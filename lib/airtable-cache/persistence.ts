import { promises as fileSystem } from "fs";
import path from "node:path";

import { assertJsonObject, HttpError } from "@/lib/airtable-cache/errors";
import {
  normalizeAirtableUrl,
  normalizeSiteKey,
  siteKeyToFileToken,
} from "@/lib/airtable-cache/request";
import {
  buildPreloadScript,
  isNotFoundError,
  readFileIfExists,
  restoreFileContents,
  writeFileAtomically,
} from "@/lib/airtable-cache/persistence/file-utils";
import {
  extractLegacyPreloadJson,
  LegacyMigrationResult,
  mergeLegacyPaginatedResponses,
} from "@/lib/airtable-cache/persistence/legacy";
import {
  AirtableConfig,
  CacheEntryState,
  CachePersistence,
  isJsonObject,
  JsonObject,
  Logger,
  SiteSnapshot,
  stripOffsetField,
} from "@/lib/airtable-cache/types";

function normalizeLoadedSnapshotEntry(
  now: number,
  rawEntry: unknown,
): CacheEntryState | null {
  if (!isJsonObject(rawEntry) || !isJsonObject(rawEntry.body)) {
    return null;
  }

  const updatedAt =
    typeof rawEntry.updatedAt === "number" && Number.isFinite(rawEntry.updatedAt)
      ? rawEntry.updatedAt
      : now;
  const lastAccessedAt =
    typeof rawEntry.lastAccessedAt === "number" && Number.isFinite(rawEntry.lastAccessedAt)
      ? rawEntry.lastAccessedAt
      : updatedAt;

  return {
    body: stripOffsetField(rawEntry.body),
    updatedAt,
    lastAccessedAt,
  };
}

export class FileSystemCachePersistence implements CachePersistence {
  constructor(
    private readonly config: AirtableConfig,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async loadSiteSnapshot(siteKey: string): Promise<SiteSnapshot | null> {
    const snapshotPath = this.getSnapshotPath(siteKey);

    try {
      const fileContents = await fileSystem.readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(fileContents) as unknown;
      const snapshot = this.normalizeLoadedSnapshot(siteKey, parsed);
      await this.reconcileDerivedPreloadFile(siteKey, snapshot.entries);
      return snapshot;
    } catch (error) {
      if (isNotFoundError(error)) {
        return this.migrateLegacyArtifacts(siteKey);
      }

      if (error instanceof SyntaxError) {
        throw new HttpError(
          500,
          "CACHE_PARSE_FAILED",
          "Failed to parse the persisted cache snapshot.",
          { siteKey },
        );
      }

      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        "CACHE_READ_FAILED",
        "Failed to read the persisted cache snapshot.",
        {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  async reconcileAllDerivedPreloadFiles(): Promise<void> {
    const snapshotFilePaths = await this.findSnapshotPaths();

    for (const snapshotFilePath of snapshotFilePaths) {
      try {
        const fileContents = await fileSystem.readFile(snapshotFilePath, "utf8");
        const parsed = JSON.parse(fileContents) as unknown;
        assertJsonObject(parsed, 500, "CACHE_PARSE_FAILED", "Cache snapshot must be an object.");

        if (typeof parsed.siteKey !== "string") {
          this.logger.warn("Skipping startup preload reconciliation for a snapshot without siteKey.", {
            snapshotFilePath,
          });
          continue;
        }

        const siteKey = normalizeSiteKey(parsed.siteKey);
        const snapshot = this.normalizeLoadedSnapshot(siteKey, parsed);
        await this.reconcileDerivedPreloadFile(siteKey, snapshot.entries);
      } catch (error) {
        this.logger.error("Failed to reconcile a startup preload file from a snapshot.", {
          snapshotFilePath,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  async saveSiteSnapshot(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
    savedAt: number,
  ): Promise<void> {
    const snapshot: SiteSnapshot = {
      version: 1,
      siteKey,
      savedAt,
      entries: Object.fromEntries(
        Object.entries(entries).map(([cacheKey, entry]) => [
          cacheKey,
          {
            body: stripOffsetField(entry.body),
            updatedAt: entry.updatedAt,
            lastAccessedAt: entry.lastAccessedAt,
          },
        ]),
      ),
    };

    const snapshotPath = this.getSnapshotPath(siteKey);
    const preloadPath = this.getPreloadPath(siteKey);
    const snapshotContents = `${JSON.stringify(snapshot, null, 2)}\n`;
    const derivedPreloadContents = buildPreloadScript(snapshot.entries);
    let previousSnapshotContents: string | null = null;
    let didWriteNewSnapshot = false;

    try {
      previousSnapshotContents = await readFileIfExists(snapshotPath);
      await writeFileAtomically(snapshotPath, snapshotContents);
      didWriteNewSnapshot = true;
      await writeFileAtomically(preloadPath, derivedPreloadContents);
      this.logger.info("Persisted site cache.", {
        siteKey,
        snapshotPath,
        preloadPath,
        entryCount: Object.keys(snapshot.entries).length,
      });
    } catch (error) {
      if (didWriteNewSnapshot) {
        try {
          await restoreFileContents(snapshotPath, previousSnapshotContents);
        } catch (rollbackError) {
          this.logger.error("Failed to roll back the snapshot after a preload write failure.", {
            siteKey,
            snapshotPath,
            cause: rollbackError instanceof Error ? rollbackError.message : "Unknown error",
          });
        }
      }

      throw new HttpError(
        500,
        "CACHE_WRITE_FAILED",
        "Failed to persist the cache snapshot to disk.",
        {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  private async reconcileDerivedPreloadFile(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
  ): Promise<void> {
    const preloadPath = this.getPreloadPath(siteKey);
    const expectedPreloadContents = buildPreloadScript(entries);
    let currentPreloadContents: string | null;

    try {
      currentPreloadContents = await readFileIfExists(preloadPath);
    } catch (error) {
      this.logger.error("Failed to read the derived preload cache file.", {
        siteKey,
        preloadPath,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
      currentPreloadContents = null;
    }

    if (currentPreloadContents === expectedPreloadContents) {
      return;
    }

    try {
      await writeFileAtomically(preloadPath, expectedPreloadContents);
      this.logger.info("Reconciled the derived preload cache file from the JSON snapshot.", {
        siteKey,
        preloadPath,
        reason: currentPreloadContents === null ? "missing" : "mismatch",
      });
    } catch (error) {
      this.logger.error("Failed to reconcile the derived preload cache file.", {
        siteKey,
        preloadPath,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private normalizeLoadedSnapshot(siteKey: string, parsed: unknown): SiteSnapshot {
    const now = this.now();
    assertJsonObject(parsed, 500, "CACHE_PARSE_FAILED", "Cache snapshot must be an object.");

    const rawEntries = isJsonObject(parsed.entries) ? parsed.entries : {};
    const entries = Object.fromEntries(
      Object.entries(rawEntries).flatMap(([cacheKey, rawEntry]) => {
        const normalizedCacheKey = normalizeAirtableUrl(cacheKey);
        const normalizedEntry = normalizeLoadedSnapshotEntry(now, rawEntry);

        if (!normalizedCacheKey || !normalizedEntry) {
          return [];
        }

        return [[normalizedCacheKey, normalizedEntry] as const];
      }),
    );

    return {
      version: 1,
      siteKey,
      savedAt:
        typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : now,
      entries,
    };
  }

  private async migrateLegacyArtifacts(siteKey: string): Promise<SiteSnapshot | null> {
    const migration = await this.readLegacyArtifacts(siteKey);
    if (!migration) {
      return null;
    }

    const snapshot: SiteSnapshot = {
      version: 1,
      siteKey,
      savedAt: this.now(),
      entries: migration.entries,
    };

    await this.saveSiteSnapshot(siteKey, migration.entries, snapshot.savedAt);
    await Promise.all(
      migration.filesToDelete
        .filter((filePath) => filePath !== this.getPreloadPath(siteKey))
        .map(async (filePath) => {
          await fileSystem.rm(filePath, { force: true });
        }),
    );

    this.logger.info("Migrated legacy cache files into the JSON snapshot format.", {
      siteKey,
      migratedFiles: migration.filesToDelete,
    });

    return snapshot;
  }

  private async readLegacyArtifacts(siteKey: string): Promise<LegacyMigrationResult | null> {
    const legacyCachePaths = await this.findExistingPaths(this.getLegacyCachePaths(siteKey));
    if (legacyCachePaths.length === 0) {
      return null;
    }

    const legacyTimestampPaths = await this.findExistingPaths(this.getLegacyTimestampPaths(siteKey));
    const rawEntries: Record<string, JsonObject> = {};
    const rawTimestamps: Record<string, number> = {};

    for (const cachePath of legacyCachePaths) {
      Object.assign(rawEntries, await this.readLegacyCacheFile(cachePath));
    }

    for (const timestampPath of legacyTimestampPaths) {
      Object.assign(rawTimestamps, await this.readLegacyTimestampFile(timestampPath));
    }

    const entries = mergeLegacyPaginatedResponses(rawEntries, rawTimestamps, this.now());
    if (Object.keys(entries).length === 0) {
      return null;
    }

    return {
      entries,
      filesToDelete: [...legacyCachePaths, ...legacyTimestampPaths],
    };
  }

  private async readLegacyCacheFile(filePath: string): Promise<Record<string, JsonObject>> {
    try {
      const fileContents = await fileSystem.readFile(filePath, "utf8");
      const jsonString = extractLegacyPreloadJson(fileContents);
      const parsed = JSON.parse(jsonString) as unknown;

      assertJsonObject(
        parsed,
        500,
        "CACHE_PARSE_FAILED",
        "Legacy cache files must contain an object payload.",
      );

      const entries: Record<string, JsonObject> = {};
      for (const [rawUrl, value] of Object.entries(parsed)) {
        if (!isJsonObject(value)) {
          continue;
        }

        entries[rawUrl] = value;
      }

      return entries;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        "CACHE_PARSE_FAILED",
        "Failed to parse a legacy cache preload file.",
        {
          filePath,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  private async readLegacyTimestampFile(filePath: string): Promise<Record<string, number>> {
    try {
      const fileContents = await fileSystem.readFile(filePath, "utf8");
      const parsed = JSON.parse(fileContents) as unknown;
      assertJsonObject(
        parsed,
        500,
        "CACHE_PARSE_FAILED",
        "Legacy timestamp files must contain an object payload.",
      );

      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        "CACHE_PARSE_FAILED",
        "Failed to parse a legacy timestamp file.",
        {
          filePath,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  private getSnapshotPath(siteKey: string): string {
    return path.join(this.config.cacheDataDir, `${siteKeyToFileToken(siteKey)}.json`);
  }

  private getPreloadPath(siteKey: string): string {
    return path.join(this.config.publicCacheDir, `cache-${siteKeyToFileToken(siteKey)}.js`);
  }

  private getLegacyCachePaths(siteKey: string): string[] {
    const token = siteKeyToFileToken(siteKey);
    const variants = Array.from(new Set([siteKey, token]));
    return variants.map((variant) => path.join(this.config.publicCacheDir, `cache-${variant}.js`));
  }

  private getLegacyTimestampPaths(siteKey: string): string[] {
    const token = siteKeyToFileToken(siteKey);
    const variants = Array.from(new Set([siteKey, token]));
    return variants.map((variant) =>
      path.join(this.config.publicCacheDir, `timestamps-${variant}.json`),
    );
  }

  private async findExistingPaths(candidatePaths: string[]): Promise<string[]> {
    const foundPaths: string[] = [];

    for (const candidatePath of candidatePaths) {
      try {
        await fileSystem.access(candidatePath);
        foundPaths.push(candidatePath);
      } catch {
        continue;
      }
    }

    return foundPaths;
  }

  private async findSnapshotPaths(): Promise<string[]> {
    try {
      const directoryEntries = await fileSystem.readdir(this.config.cacheDataDir, {
        withFileTypes: true,
      });

      return directoryEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(this.config.cacheDataDir, entry.name));
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }

      throw error;
    }
  }
}
