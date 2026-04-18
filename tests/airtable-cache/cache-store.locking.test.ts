import { afterEach, describe, expect, it, vi } from "vitest";

import { AirtableCacheStore } from "@/lib/airtable-cache/cache-store";
import { HttpError } from "@/lib/airtable-cache/errors";
import {
  AirtableClientContract,
  CachePersistence,
  SiteSnapshot,
} from "@/lib/airtable-cache/types";
import {
  EXAMPLE_FILTERED_LABS_BODY,
  EXAMPLE_FILTERED_LABS_URL,
  EXAMPLE_SITE_KEY,
} from "@/tests/fixtures/cache-example";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  createTestConfig,
} from "@/tests/test-utils";

describe("airtable cache store locking and edge cases", () => {
  const workspaces: ReturnType<typeof createTempWorkspace>[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      cleanupTempWorkspace(workspace);
    }
  });

  it("returns a hit from the locked section when another request already populated the cache", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          status: 200,
          body: EXAMPLE_FILTERED_LABS_BODY,
          pageCount: 1,
        };
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
      () => 1_700_000_000_000,
    );

    const request = {
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    };

    const [firstResponse, secondResponse] = await Promise.all([
      store.resolve(request),
      store.resolve(request),
    ]);

    expect(firstResponse.headers?.["X-Airtable-Cache"]).toBe("miss");
    expect(secondResponse.headers?.["X-Airtable-Cache"]).toBe("hit");
    expect(client.fetchMergedResponse).toHaveBeenCalledTimes(1);
  });

  it("rethrows unexpected load errors without wrapping them", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockRejectedValue(new Error("boom")),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );

    await expect(
      store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: false,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      }),
    ).rejects.toThrow("boom");
  });

  it("waits for a replacement queue before reporting the site as idle", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteQueueByKey: Map<string, Promise<void>>;
    };

    let resolveFirstQueue!: () => void;
    let resolveSecondQueue!: () => void;
    const firstQueue = new Promise<void>((resolve) => {
      resolveFirstQueue = resolve;
    });
    const secondQueue = new Promise<void>((resolve) => {
      resolveSecondQueue = resolve;
    });

    privateStore.siteQueueByKey.set(EXAMPLE_SITE_KEY, firstQueue);

    let resolved = false;
    const waitPromise = store.waitForIdle(EXAMPLE_SITE_KEY).then(() => {
      resolved = true;
    });

    privateStore.siteQueueByKey.set(EXAMPLE_SITE_KEY, secondQueue);
    resolveFirstQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolved).toBe(false);

    resolveSecondQueue();
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("waits across every queued site when no site key is provided", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteQueueByKey: Map<string, Promise<void>>;
    };

    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    privateStore.siteQueueByKey.set(
      EXAMPLE_SITE_KEY,
      new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    privateStore.siteQueueByKey.set(
      "labs.centercentre.com",
      new Promise<void>((resolve) => {
        resolveSecond = resolve;
      }),
    );

    let resolved = false;
    const waitPromise = store.waitForIdle().then(() => {
      resolved = true;
    });

    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    resolveSecond();
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("skips snapshot loading when the site is already marked as loaded", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<
        string,
        {
          loaded: boolean;
          entries: Record<string, unknown>;
          refreshingCacheKeys: Set<string>;
          hasQueuedPersist: boolean;
        }
      >;
      ensureSiteLoaded(siteKey: string): Promise<void>;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
    });

    await privateStore.ensureSiteLoaded(EXAMPLE_SITE_KEY);

    expect(persistence.loadSiteSnapshot).not.toHaveBeenCalled();
  });

  it("rethrows HttpError refresh failures from the exclusive section unchanged", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const timeoutError = new HttpError(
      504,
      "AIRTABLE_TIMEOUT",
      "Timed out while waiting for Airtable.",
    );
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockRejectedValue(timeoutError),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );

    await expect(
      store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: true,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      }),
    ).rejects.toBe(timeoutError);
  });

  it("skips background refreshes that become fresh before the lock is acquired", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const now = 1_700_000_000_000;
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 100 }),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
      () => now,
    );
    const privateStore = store as unknown as {
      siteQueueByKey: Map<string, Promise<void>>;
      siteStateByKey: Map<
        string,
        {
          loaded: boolean;
          entries: Record<
            string,
            { body: typeof EXAMPLE_FILTERED_LABS_BODY; updatedAt: number; lastAccessedAt: number }
          >;
          refreshingCacheKeys: Set<string>;
          hasQueuedPersist: boolean;
        }
      >;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: now - 1_000,
          lastAccessedAt: now - 1_000,
        },
      },
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
    });

    let releaseQueue!: () => void;
    const blockingQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    privateStore.siteQueueByKey.set(EXAMPLE_SITE_KEY, blockingQueue);

    privateStore.scheduleBackgroundRefresh(
      EXAMPLE_SITE_KEY,
      EXAMPLE_FILTERED_LABS_URL,
      EXAMPLE_FILTERED_LABS_URL,
    );

    const siteState = privateStore.siteStateByKey.get(EXAMPLE_SITE_KEY);
    if (siteState) {
      siteState.entries[EXAMPLE_FILTERED_LABS_URL].updatedAt = now;
    }

    releaseQueue();
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(client.fetchMergedResponse).not.toHaveBeenCalled();
    expect(
      privateStore.siteStateByKey
        .get(EXAMPLE_SITE_KEY)
        ?.refreshingCacheKeys.has(EXAMPLE_FILTERED_LABS_URL),
    ).toBe(false);
  });

  it("logs and swallows queued persist failures on hot cache hits", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_700_000_000_000,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_700_000_000_000,
            lastAccessedAt: 1_700_000_000_000,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockRejectedValue("disk full"),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 60_000 }),
      persistence,
      client,
      logger,
      () => 1_700_000_000_100,
    );

    const response = await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });

    expect(response.headers?.["X-Airtable-Cache"]).toBe("hit");

    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to persist cache access metadata.",
      expect.objectContaining({
        siteKey: EXAMPLE_SITE_KEY,
        cause: "Unknown error",
      }),
    );
  });

  it("logs persist failures with the thrown error message when available", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_700_000_000_000,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_700_000_000_000,
            lastAccessedAt: 1_700_000_000_000,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 60_000 }),
      persistence,
      client,
      logger,
      () => 1_700_000_000_100,
    );

    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to persist cache access metadata.",
      expect.objectContaining({
        siteKey: EXAMPLE_SITE_KEY,
        cause: "disk full",
      }),
    );
  });

  it("skips background refreshes when the entry disappears before refresh work starts", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<
        string,
        {
          loaded: boolean;
          entries: Record<string, typeof EXAMPLE_FILTERED_LABS_BODY>;
          refreshingCacheKeys: Set<string>;
          hasQueuedPersist: boolean;
        }
      >;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
    });

    privateStore.scheduleBackgroundRefresh(
      EXAMPLE_SITE_KEY,
      EXAMPLE_FILTERED_LABS_URL,
      EXAMPLE_FILTERED_LABS_URL,
    );
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(client.fetchMergedResponse).not.toHaveBeenCalled();
    expect(
      privateStore.siteStateByKey
        .get(EXAMPLE_SITE_KEY)
        ?.refreshingCacheKeys.has(EXAMPLE_FILTERED_LABS_URL),
    ).toBe(false);
  });

  it("logs background refresh failures with the thrown error message when available", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 100 }),
      persistence,
      client,
      logger,
      () => 1_700_000_000_000,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<
        string,
        {
          loaded: boolean;
          entries: Record<
            string,
            { body: typeof EXAMPLE_FILTERED_LABS_BODY; updatedAt: number; lastAccessedAt: number }
          >;
          refreshingCacheKeys: Set<string>;
          hasQueuedPersist: boolean;
        }
      >;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_699_999_999_000,
          lastAccessedAt: 1_699_999_999_000,
        },
      },
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
    });

    privateStore.scheduleBackgroundRefresh(
      EXAMPLE_SITE_KEY,
      EXAMPLE_FILTERED_LABS_URL,
      EXAMPLE_FILTERED_LABS_URL,
    );
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(logger.error).toHaveBeenCalledWith(
      "Background refresh failed. Serving the last good cache entry.",
      expect.objectContaining({
        siteKey: EXAMPLE_SITE_KEY,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
        cause: "network down",
      }),
    );
  });
});
