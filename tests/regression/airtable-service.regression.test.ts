import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildAirtableProxyRequest,
  normalizeAirtableUrl,
  siteKeyToFileToken,
} from "@/lib/airtable-cache/request";
import type { JsonObject, SiteSnapshot } from "@/lib/airtable-cache/types";
import {
  EXAMPLE_PUBLISHED_DATE_RECORDS,
  EXAMPLE_SITE_KEY,
  EXAMPLE_TOPICS_BODY,
  EXAMPLE_TOPICS_URL,
  EXAMPLE_PUBLISHED_DATES_URL,
} from "@/tests/fixtures/cache-example";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  readPreloadCache,
  type TestWorkspace,
} from "@/tests/test-utils";

const TEST_TIMEOUT_MS = 90_000;
// This regression boots a full Next.js server and touches the filesystem on every cache update.
// The freshness windows need enough room that normal process jitter does not turn an intended
// "fresh hit" assertion into a flaky "stale" response on slower machines or busy CI runners.
const STALE_AFTER_MS = 250;
const EVICT_AFTER_MS = 700;
const REGRESSION_OFFSET_TOKEN = "itrRegressionPublished/recPageTwo";

interface RegressionResponse {
  body: JsonObject;
  cacheHeader: string | null;
  status: number;
}

interface RunningApp {
  baseUrl: string;
  logs: string;
  process: ChildProcess;
  stop: () => Promise<void>;
}

interface AirtableStubState {
  publishedVariant: keyof typeof publishedBodies;
  requestCounts: Map<string, number>;
  requests: string[];
}

const publishedBodies = {
  v1: EXAMPLE_PUBLISHED_DATE_RECORDS,
  v2: [
    patchRecord(EXAMPLE_PUBLISHED_DATE_RECORDS[0], {
      Cohort: ["Late-March 2026", "Regression Refresh"],
    }),
    structuredClone(EXAMPLE_PUBLISHED_DATE_RECORDS[1]) as JsonObject,
    patchRecord(EXAMPLE_PUBLISHED_DATE_RECORDS[2], {
      "Session Name": "Wrap Up (Background Refresh)",
    }),
  ],
  v3: [
    patchRecord(EXAMPLE_PUBLISHED_DATE_RECORDS[0], {
      Cohort: ["Late-March 2026", "Force Refresh"],
    }),
    structuredClone(EXAMPLE_PUBLISHED_DATE_RECORDS[1]) as JsonObject,
    patchRecord(EXAMPLE_PUBLISHED_DATE_RECORDS[2], {
      "Session Name": "Wrap Up (Force Refresh)",
    }),
  ],
} as const;

function patchRecord(record: JsonObject, fieldsPatch: Record<string, unknown>): JsonObject {
  const cloned = structuredClone(record) as JsonObject;
  const currentFields = isJsonObject(cloned.fields) ? cloned.fields : {};

  return {
    ...cloned,
    fields: {
      ...currentFields,
      ...fieldsPatch,
    } as JsonObject,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createPaginatedPages(records: JsonObject[]): [JsonObject, JsonObject] {
  return [
    {
      records: records.slice(0, 2),
      offset: REGRESSION_OFFSET_TOKEN,
    },
    {
      records: records.slice(2),
    },
  ];
}

function buildProxyPath(
  airtableUrl: string,
  extraParams: Record<string, string> = {},
): string {
  const parsed = new URL(airtableUrl);
  const proxyPath = parsed.pathname.replace(/^\/v0\/?/, "/");
  const searchParams = new URLSearchParams(parsed.searchParams);

  for (const [key, value] of Object.entries(extraParams)) {
    searchParams.set(key, value);
  }

  const query = searchParams.toString();
  return `/v0${proxyPath}${query ? `?${query}` : ""}`;
}

async function findOpenPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  server.close();

  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate an open TCP port.");
  }

  return address.port;
}

async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await condition()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`Timed out after ${timeoutMs}ms while waiting for the regression condition.`);
}

function readSnapshot(snapshotPath: string): SiteSnapshot {
  return JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as SiteSnapshot;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out while stopping the regression server.")), 5_000);
      }),
    ]);
  } catch {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function startAirtableStub(): Promise<{
  baseUrl: string;
  server: http.Server;
  state: AirtableStubState;
  stop: () => Promise<void>;
}> {
  const port = await findOpenPort();
  const publishedPathname = new URL(EXAMPLE_PUBLISHED_DATES_URL).pathname;
  const topicsPathname = new URL(EXAMPLE_TOPICS_URL).pathname;
  const state: AirtableStubState = {
    publishedVariant: "v1",
    requestCounts: new Map<string, number>(),
    requests: [],
  };

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const cacheKey = normalizeAirtableUrl(requestUrl.toString());

    if (!cacheKey) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST_URL",
            url: requestUrl.toString(),
          },
        }),
      );
      return;
    }

    state.requests.push(requestUrl.toString());
    state.requestCounts.set(cacheKey, (state.requestCounts.get(cacheKey) ?? 0) + 1);

    if (requestUrl.pathname === publishedPathname) {
      const [firstPage, secondPage] = createPaginatedPages([
        ...publishedBodies[state.publishedVariant],
      ]);
      const body =
        requestUrl.searchParams.get("offset") === REGRESSION_OFFSET_TOKEN ? secondPage : firstPage;

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }

    if (requestUrl.pathname === topicsPathname) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(EXAMPLE_TOPICS_BODY));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: "UNKNOWN_UPSTREAM_REQUEST",
          cacheKey,
        },
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    state,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function startNextApp(workspace: TestWorkspace, airtableBaseUrl: string): Promise<RunningApp> {
  const port = await findOpenPort();
  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AIRTABLE_API_BASE_URL: airtableBaseUrl,
        AIRTABLE_API_KEY: "regression-airtable-key",
        AIRTABLE_FETCH_TIMEOUT_MS: "2000",
        CACHE_DATA_DIR: workspace.dataDir,
        CACHE_PUBLIC_DIR: workspace.publicDir,
        CACHE_STALE_AFTER_MS: String(STALE_AFTER_MS),
        CACHE_EVICT_AFTER_MS: String(EVICT_AFTER_MS),
        CI: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  const appendLogs = (chunk: Buffer | string) => {
    logs += chunk.toString();
  };

  child.stdout.on("data", appendLogs);
  child.stderr.on("data", appendLogs);

  const baseUrl = `http://127.0.0.1:${port}`;

  await waitForCondition(async () => {
    if (child.exitCode !== null) {
      throw new Error(`The launched Next service exited early.\n${logs}`);
    }

    try {
      const response = await fetch(`${baseUrl}/v0`);
      return response.status === 400;
    } catch {
      return false;
    }
  }, 45_000, 100);

  return {
    baseUrl,
    get logs() {
      return logs;
    },
    process: child,
    stop: async () => {
      await stopChildProcess(child);
    },
  };
}

async function requestJson(url: string): Promise<RegressionResponse> {
  const response = await fetch(url);
  const body = (await response.json()) as JsonObject;

  return {
    body,
    cacheHeader: response.headers.get("X-Airtable-Cache"),
    status: response.status,
  };
}

describe.sequential("launched Airtable cache regression", () => {
  let workspace: TestWorkspace;
  let app: RunningApp;
  let airtableStub: Awaited<ReturnType<typeof startAirtableStub>>;
  let publishedProxyPath: string;
  let forceRefreshProxyPath: string;
  let topicsProxyPath: string;
  let publishedCacheKey: string;
  let topicsCacheKey: string;
  let snapshotPath: string;
  let preloadPath: string;

  beforeAll(async () => {
    workspace = createTempWorkspace();

    publishedProxyPath = buildProxyPath(EXAMPLE_PUBLISHED_DATES_URL, {
      ref: EXAMPLE_SITE_KEY,
    });
    forceRefreshProxyPath = buildProxyPath(EXAMPLE_PUBLISHED_DATES_URL, {
      ref: EXAMPLE_SITE_KEY,
      refresh: "true",
    });
    topicsProxyPath = buildProxyPath(EXAMPLE_TOPICS_URL, {
      ref: EXAMPLE_SITE_KEY,
    });

    airtableStub = await startAirtableStub();

    publishedCacheKey = buildAirtableProxyRequest(
      new NextRequest(`${airtableStub.baseUrl}${publishedProxyPath}`),
      airtableStub.baseUrl,
    ).cacheKey;
    topicsCacheKey = buildAirtableProxyRequest(
      new NextRequest(`${airtableStub.baseUrl}${topicsProxyPath}`),
      airtableStub.baseUrl,
    ).cacheKey;

    app = await startNextApp(workspace, airtableStub.baseUrl);

    const cacheFileToken = siteKeyToFileToken(EXAMPLE_SITE_KEY);
    snapshotPath = path.join(workspace.dataDir, `${cacheFileToken}.json`);
    preloadPath = path.join(workspace.publicDir, `cache-${cacheFileToken}.js`);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    await airtableStub?.stop();
    if (workspace) {
      cleanupTempWorkspace(workspace);
    }
  }, TEST_TIMEOUT_MS);

  it("verifies miss, hit, background refresh, explicit refresh, and eviction end to end", async () => {
    const firstResponse = await requestJson(`${app.baseUrl}${publishedProxyPath}`);

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.cacheHeader).toBe("miss");
    expect(firstResponse.body.records).toEqual(publishedBodies.v1);

    await waitForCondition(() => airtableStub.state.requestCounts.get(publishedCacheKey) === 2);
    await waitForCondition(() => {
      if (!path.isAbsolute(snapshotPath) || !path.isAbsolute(preloadPath)) {
        return false;
      }

      try {
        return Boolean(readSnapshot(snapshotPath).entries[publishedCacheKey]) && fs.existsSync(preloadPath);
      } catch {
        return false;
      }
    });

    let snapshot = readSnapshot(snapshotPath);
    let preloadCache = readPreloadCache(preloadPath);

    expect(snapshot.entries[publishedCacheKey]?.body.records).toEqual(publishedBodies.v1);
    expect(snapshot.entries[publishedCacheKey]?.body).not.toHaveProperty("offset");
    expect(preloadCache[publishedCacheKey]).not.toHaveProperty("offset");

    const hitResponse = await requestJson(`${app.baseUrl}${publishedProxyPath}`);

    expect(hitResponse.cacheHeader).toBe("hit");
    expect(airtableStub.state.requestCounts.get(publishedCacheKey)).toBe(2);

    const topicsResponse = await requestJson(`${app.baseUrl}${topicsProxyPath}`);

    expect(topicsResponse.status).toBe(200);
    expect(topicsResponse.cacheHeader).toBe("miss");
    expect(topicsResponse.body.records).toEqual(EXAMPLE_TOPICS_BODY.records);

    await waitForCondition(() => airtableStub.state.requestCounts.get(topicsCacheKey) === 1);
    await waitForCondition(() => {
      const currentSnapshot = readSnapshot(snapshotPath);
      return (
        Boolean(currentSnapshot.entries[publishedCacheKey]) &&
        Boolean(currentSnapshot.entries[topicsCacheKey])
      );
    });

    airtableStub.state.publishedVariant = "v2";
    await new Promise((resolve) => setTimeout(resolve, STALE_AFTER_MS + 40));

    const staleResponse = await requestJson(`${app.baseUrl}${publishedProxyPath}`);

    expect(staleResponse.cacheHeader).toBe("stale");
    expect(staleResponse.body.records).toEqual(publishedBodies.v1);

    await waitForCondition(() => airtableStub.state.requestCounts.get(publishedCacheKey) === 4);
    await waitForCondition(() => {
      const currentSnapshot = readSnapshot(snapshotPath);
      const records = currentSnapshot.entries[publishedCacheKey]?.body.records;
      return JSON.stringify(records) === JSON.stringify(publishedBodies.v2);
    });

    const refreshedHit = await requestJson(`${app.baseUrl}${publishedProxyPath}`);

    expect(refreshedHit.cacheHeader).toBe("hit");
    expect(refreshedHit.body.records).toEqual(publishedBodies.v2);

    airtableStub.state.publishedVariant = "v3";

    const forceRefreshResponse = await requestJson(`${app.baseUrl}${forceRefreshProxyPath}`);

    expect(forceRefreshResponse.cacheHeader).toBe("refresh");
    expect(forceRefreshResponse.body.records).toEqual(publishedBodies.v3);
    expect(airtableStub.state.requestCounts.get(publishedCacheKey)).toBe(6);

    snapshot = readSnapshot(snapshotPath);
    preloadCache = readPreloadCache(preloadPath);

    expect(Object.keys(snapshot.entries)).toContain(publishedCacheKey);
    expect(snapshot.entries[publishedCacheKey]?.body.records).toEqual(publishedBodies.v3);
    expect(preloadCache[publishedCacheKey].records).toEqual(publishedBodies.v3);

    await new Promise((resolve) => setTimeout(resolve, EVICT_AFTER_MS + 40));

    const trimResponse = await requestJson(`${app.baseUrl}${forceRefreshProxyPath}`);

    expect(trimResponse.cacheHeader).toBe("refresh");
    expect(trimResponse.body.records).toEqual(publishedBodies.v3);

    await waitForCondition(() => {
      const currentSnapshot = readSnapshot(snapshotPath);
      return (
        Object.keys(currentSnapshot.entries).length === 1 &&
        Boolean(currentSnapshot.entries[publishedCacheKey]) &&
        !currentSnapshot.entries[topicsCacheKey]
      );
    });

    snapshot = readSnapshot(snapshotPath);
    preloadCache = readPreloadCache(preloadPath);

    expect(Object.keys(snapshot.entries)).toEqual([publishedCacheKey]);
    expect(Object.keys(preloadCache)).toEqual([publishedCacheKey]);
    expect(preloadCache[publishedCacheKey]).not.toHaveProperty("offset");
  }, TEST_TIMEOUT_MS);
});
