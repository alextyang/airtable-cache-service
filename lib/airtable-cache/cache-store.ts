import { HttpError } from "@/lib/airtable-cache/errors";
import {
  AirtableClientContract,
  AirtableConfig,
  CacheEntryState,
  CachePersistence,
  Logger,
  ProxyRequest,
  ProxyResponse,
} from "@/lib/airtable-cache/types";

interface SiteCacheState {
  loaded: boolean;
  entries: Record<string, CacheEntryState>;
  refreshingCacheKeys: Set<string>;
  hasQueuedPersist: boolean;
}

export class AirtableCacheStore {
  private readonly siteStateByKey = new Map<string, SiteCacheState>();
  private readonly siteQueueByKey = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AirtableConfig,
    private readonly persistence: CachePersistence,
    private readonly client: AirtableClientContract,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(request: ProxyRequest): Promise<ProxyResponse> {
    await this.ensureSiteLoaded(request.siteKey);

    const siteState = this.getOrCreateSiteState(request.siteKey);
    const cachedEntry = siteState.entries[request.cacheKey];
    const requestTime = this.now();

    if (cachedEntry && !request.forceRefresh) {
      cachedEntry.lastAccessedAt = requestTime;
      this.scheduleMetadataPersist(request.siteKey);

      if (this.isEntryStale(cachedEntry, requestTime)) {
        this.scheduleBackgroundRefresh(
          request.siteKey,
          request.cacheKey,
          request.airtableUrl,
        );

        return {
          status: 200,
          body: structuredClone(cachedEntry.body),
          headers: {
            "Cache-Control": "no-store",
            "X-Airtable-Cache": "stale",
          },
        };
      }

      return {
        status: 200,
        body: structuredClone(cachedEntry.body),
        headers: {
          "Cache-Control": "no-store",
          "X-Airtable-Cache": "hit",
        },
      };
    }

    return this.runWithSiteLock(request.siteKey, async () => {
      const lockedSiteState = await this.loadSiteSnapshotIfNeeded(request.siteKey);
      const lockedEntry = lockedSiteState.entries[request.cacheKey];
      const lockedTime = this.now();

      if (lockedEntry && !request.forceRefresh && !this.isEntryStale(lockedEntry, lockedTime)) {
        lockedEntry.lastAccessedAt = lockedTime;
        await this.persistSiteSnapshot(request.siteKey, lockedSiteState, lockedTime);

        return {
          status: 200,
          body: structuredClone(lockedEntry.body),
          headers: {
            "Cache-Control": "no-store",
            "X-Airtable-Cache": "hit",
          },
        };
      }

      const freshResponse = await this.client.fetchMergedResponse(request.airtableUrl);

      lockedSiteState.entries[request.cacheKey] = {
        body: freshResponse.body,
        updatedAt: lockedTime,
        lastAccessedAt: lockedTime,
      };

      this.removeExpiredEntries(lockedSiteState, lockedTime);
      await this.persistSiteSnapshot(request.siteKey, lockedSiteState, lockedTime);

      return {
        status: freshResponse.status,
        body: structuredClone(freshResponse.body),
        headers: {
          "Cache-Control": "no-store",
          "X-Airtable-Cache": request.forceRefresh ? "refresh" : "miss",
        },
      };
    });
  }

  async waitForIdle(siteKey?: string): Promise<void> {
    if (siteKey) {
      await this.waitForSiteQueueToDrain(siteKey);
      return;
    }

    await Promise.all(
      Array.from(this.siteQueueByKey.keys()).map((key) => this.waitForSiteQueueToDrain(key)),
    );
  }

  private async ensureSiteLoaded(siteKey: string): Promise<void> {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.loaded) {
      return;
    }

    await this.runWithSiteLock(siteKey, async () => {
      await this.loadSiteSnapshotIfNeeded(siteKey);
    });
  }

  private async loadSiteSnapshotIfNeeded(siteKey: string): Promise<SiteCacheState> {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.loaded) {
      return siteState;
    }

    const snapshot = await this.persistence.loadSiteSnapshot(siteKey);
    siteState.entries = snapshot?.entries ?? {};
    siteState.loaded = true;

    const removedEntries = this.removeExpiredEntries(siteState, this.now());
    if (removedEntries > 0) {
      await this.persistSiteSnapshot(siteKey, siteState, this.now());
    }

    this.logger.info("Loaded site cache into memory.", {
      siteKey,
      entryCount: Object.keys(siteState.entries).length,
    });

    return siteState;
  }

  private getOrCreateSiteState(siteKey: string): SiteCacheState {
    const existingState = this.siteStateByKey.get(siteKey);
    if (existingState) {
      return existingState;
    }

    const newState: SiteCacheState = {
      loaded: false,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
    };
    this.siteStateByKey.set(siteKey, newState);
    return newState;
  }

  private isEntryStale(entry: CacheEntryState, currentTime: number): boolean {
    return currentTime - entry.updatedAt >= this.config.staleAfterMs;
  }

  private removeExpiredEntries(siteState: SiteCacheState, currentTime: number): number {
    let removedEntries = 0;

    for (const [cacheKey, entry] of Object.entries(siteState.entries)) {
      if (currentTime - entry.lastAccessedAt <= this.config.evictAfterMs) {
        continue;
      }

      delete siteState.entries[cacheKey];
      removedEntries += 1;
    }

    return removedEntries;
  }

  private async persistSiteSnapshot(
    siteKey: string,
    siteState: SiteCacheState,
    savedAt: number,
  ): Promise<void> {
    await this.persistence.saveSiteSnapshot(siteKey, siteState.entries, savedAt);
  }

  private scheduleMetadataPersist(siteKey: string): void {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.hasQueuedPersist) {
      return;
    }

    siteState.hasQueuedPersist = true;

    void this.runWithSiteLock(siteKey, async () => {
      try {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(siteKey);
        const currentTime = this.now();
        this.removeExpiredEntries(lockedSiteState, currentTime);
        await this.persistSiteSnapshot(siteKey, lockedSiteState, currentTime);
      } catch (error) {
        this.logger.error("Failed to persist cache access metadata.", {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        siteState.hasQueuedPersist = false;
      }
    });
  }

  private scheduleBackgroundRefresh(
    siteKey: string,
    cacheKey: string,
    airtableUrl: string,
  ): void {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.refreshingCacheKeys.has(cacheKey)) {
      return;
    }

    siteState.refreshingCacheKeys.add(cacheKey);

    void this.runWithSiteLock(siteKey, async () => {
      try {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(siteKey);
        const existingEntry = lockedSiteState.entries[cacheKey];
        if (!existingEntry) {
          return;
        }

        const currentTime = this.now();
        if (!this.isEntryStale(existingEntry, currentTime)) {
          return;
        }

        const freshResponse = await this.client.fetchMergedResponse(airtableUrl);
        lockedSiteState.entries[cacheKey] = {
          body: freshResponse.body,
          updatedAt: currentTime,
          lastAccessedAt: existingEntry.lastAccessedAt,
        };

        this.removeExpiredEntries(lockedSiteState, currentTime);
        await this.persistSiteSnapshot(siteKey, lockedSiteState, currentTime);
      } catch (error) {
        this.logger.error("Background refresh failed. Serving the last good cache entry.", {
          siteKey,
          cacheKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        siteState.refreshingCacheKeys.delete(cacheKey);
      }
    });
  }

  private async runWithSiteLock<T>(siteKey: string, task: () => Promise<T>): Promise<T> {
    const previousQueuedTask = this.siteQueueByKey.get(siteKey) ?? Promise.resolve();
    let releaseCurrentQueueSlot: (() => void) | undefined;
    const currentQueueSlot = new Promise<void>((resolve) => {
      releaseCurrentQueueSlot = resolve;
    });
    const updatedQueueTail = previousQueuedTask
      .catch(() => undefined)
      .then(() => currentQueueSlot);
    this.siteQueueByKey.set(siteKey, updatedQueueTail);

    await previousQueuedTask.catch(() => undefined);

    try {
      return await task();
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw error;
    } finally {
      releaseCurrentQueueSlot?.();
      if (this.siteQueueByKey.get(siteKey) === updatedQueueTail) {
        this.siteQueueByKey.delete(siteKey);
      }
    }
  }

  private async waitForSiteQueueToDrain(siteKey: string): Promise<void> {
    while (true) {
      const queuedWork = this.siteQueueByKey.get(siteKey);
      if (!queuedWork) {
        return;
      }

      await queuedWork.catch(() => undefined);

      if (this.siteQueueByKey.get(siteKey) === queuedWork) {
        return;
      }
    }
  }
}
