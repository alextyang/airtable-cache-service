import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAirtableCacheService } from "@/lib/airtable-cache/service";
import { siteKeyToFileToken } from "@/lib/airtable-cache/request";
import {
  EXAMPLE_FILTERED_LABS_BODY,
  EXAMPLE_FILTERED_LABS_URL,
  EXAMPLE_PAGINATED_PAGE_ONE,
  EXAMPLE_PAGINATED_PAGE_TWO,
  EXAMPLE_PUBLISHED_DATES_BODY,
  EXAMPLE_PUBLISHED_DATES_URL,
  EXAMPLE_SITE_KEY,
} from "@/tests/fixtures/cache-example";
import {
  createJsonResponse,
  createTempWorkspace,
  createTestConfig,
  readPreloadCache,
  testLogger,
  writeSnapshot,
} from "@/tests/test-utils";

describe("airtable cache service", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const rootDir of workspaces.splice(0)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fetches every Airtable page on a cold miss and persists a merged dataset", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const cacheKey = EXAMPLE_PUBLISHED_DATES_URL;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_ONE))
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_TWO));

    const service = createAirtableCacheService({
      config: createTestConfig(workspace),
      fetchImpl: fetchMock,
      logger: testLogger,
      now: () => 1_700_000_000_000,
    });

    const response = await service.handle({
      siteKey,
      forceRefresh: false,
      airtableUrl: cacheKey,
      cacheKey,
    });

    expect(response.status).toBe(200);
    expect(response.headers?.["X-Airtable-Cache"]).toBe("miss");
    expect(response.body.records).toEqual(EXAMPLE_PUBLISHED_DATES_BODY.records);
    expect(response.body).not.toHaveProperty("offset");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    const preloadPath = path.join(
      workspace.publicDir,
      `cache-${siteKeyToFileToken(siteKey)}.js`,
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      entries: Record<string, { body: Record<string, unknown> }>;
    };
    const preloadCache = readPreloadCache(preloadPath);

    expect(Object.keys(snapshot.entries)).toEqual([cacheKey]);
    expect(snapshot.entries[cacheKey]?.body).not.toHaveProperty("offset");
    expect(preloadCache[cacheKey]).not.toHaveProperty("offset");
    expect(preloadCache[cacheKey].records).toHaveLength(3);
  });

  it("coalesces duplicate stale refreshes and keeps the snapshot consistent", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const cacheKey = EXAMPLE_FILTERED_LABS_URL;
    writeSnapshot(workspace, siteKey, {
      version: 1,
      siteKey,
      savedAt: 1_700_000_000_000,
      entries: {
        [cacheKey]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_700_000_000_100,
        },
      },
    });

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return createJsonResponse(EXAMPLE_PUBLISHED_DATES_BODY);
    });

    const service = createAirtableCacheService({
      config: createTestConfig(workspace, {
        staleAfterMs: 100,
      }),
      fetchImpl: fetchMock,
      logger: testLogger,
      now: () => 1_700_000_001_000,
    });

    const request = {
      siteKey,
      forceRefresh: false,
      airtableUrl: cacheKey,
      cacheKey,
    };

    const [firstResponse, secondResponse] = await Promise.all([
      service.handle(request),
      service.handle(request),
    ]);

    expect(firstResponse.headers?.["X-Airtable-Cache"]).toBe("stale");
    expect(secondResponse.headers?.["X-Airtable-Cache"]).toBe("stale");
    expect(firstResponse.body.records).toEqual(EXAMPLE_FILTERED_LABS_BODY.records);
    expect(secondResponse.body.records).toEqual(EXAMPLE_FILTERED_LABS_BODY.records);

    await service.waitForIdle(siteKey);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      entries: Record<string, { body: Record<string, unknown> }>;
    };

    expect(snapshot.entries[cacheKey]?.body.records).toEqual(EXAMPLE_PUBLISHED_DATES_BODY.records);
    expect(snapshot.entries[cacheKey]?.body).not.toHaveProperty("offset");
  });

  it("serves fresh cache hits without calling Airtable and persists access metadata", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    writeSnapshot(workspace, EXAMPLE_SITE_KEY, {
      version: 1,
      siteKey: EXAMPLE_SITE_KEY,
      savedAt: 1_700_000_000_000,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_699_999_000_000,
        },
      },
    });

    const fetchMock = vi.fn<typeof fetch>();
    const service = createAirtableCacheService({
      config: createTestConfig(workspace, {
        staleAfterMs: 60_000,
      }),
      fetchImpl: fetchMock,
      logger: testLogger,
      now: () => 1_700_000_000_500,
    });

    const response = await service.handle({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });

    expect(response.headers?.["X-Airtable-Cache"]).toBe("hit");
    expect(fetchMock).not.toHaveBeenCalled();

    await service.waitForIdle(EXAMPLE_SITE_KEY);

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(EXAMPLE_SITE_KEY)}.json`,
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      entries: Record<string, { lastAccessedAt: number }>;
    };

    expect(snapshot.entries[EXAMPLE_FILTERED_LABS_URL]?.lastAccessedAt).toBe(1_700_000_000_500);
  });

  it("bypasses the cache on force refresh and evicts expired entries when persisting", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    writeSnapshot(workspace, EXAMPLE_SITE_KEY, {
      version: 1,
      siteKey: EXAMPLE_SITE_KEY,
      savedAt: 1_700_000_000_000,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_699_000_000_000,
        },
        [EXAMPLE_PUBLISHED_DATES_URL]: {
          body: EXAMPLE_PUBLISHED_DATES_BODY,
          updatedAt: 1_699_000_000_000,
          lastAccessedAt: 1_699_000_000_000,
        },
      },
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_ONE))
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_TWO));
    const service = createAirtableCacheService({
      config: createTestConfig(workspace, {
        staleAfterMs: 60_000,
        evictAfterMs: 10_000,
      }),
      fetchImpl: fetchMock,
      logger: testLogger,
      now: () => 1_700_000_050_000,
    });

    const response = await service.handle({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: true,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });

    expect(response.headers?.["X-Airtable-Cache"]).toBe("refresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(EXAMPLE_SITE_KEY)}.json`,
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      entries: Record<string, { body: Record<string, unknown> }>;
    };

    expect(Object.keys(snapshot.entries)).toEqual([EXAMPLE_FILTERED_LABS_URL]);
  });

  it("keeps the last good snapshot when a background refresh fails", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    writeSnapshot(workspace, EXAMPLE_SITE_KEY, {
      version: 1,
      siteKey: EXAMPLE_SITE_KEY,
      savedAt: 1_700_000_000_000,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_700_000_000_100,
        },
      },
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Airtable is temporarily unavailable"));
    const service = createAirtableCacheService({
      config: createTestConfig(workspace, {
        staleAfterMs: 100,
      }),
      fetchImpl: fetchMock,
      logger: testLogger,
      now: () => 1_700_000_001_000,
    });

    const response = await service.handle({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });

    expect(response.headers?.["X-Airtable-Cache"]).toBe("stale");
    await service.waitForIdle(EXAMPLE_SITE_KEY);

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(EXAMPLE_SITE_KEY)}.json`,
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      entries: Record<string, { body: Record<string, unknown> }>;
    };

    expect(snapshot.entries[EXAMPLE_FILTERED_LABS_URL]?.body.records).toEqual(
      EXAMPLE_FILTERED_LABS_BODY.records,
    );
  });
});
