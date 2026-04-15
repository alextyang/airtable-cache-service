import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/preload-cache/[siteToken]/route";
import { EXAMPLE_FILTERED_LABS_BODY, EXAMPLE_FILTERED_LABS_URL, EXAMPLE_SITE_KEY } from "@/tests/fixtures/cache-example";
import { cleanupTempWorkspace, createTempWorkspace, readPreloadCache, writeSnapshot } from "@/tests/test-utils";
import { siteKeyToFileToken } from "@/lib/airtable-cache/request";

describe("/preload-cache route", () => {
  const originalApiKey = process.env.AIRTABLE_API_KEY;
  const originalCacheDataDir = process.env.CACHE_DATA_DIR;
  const originalPublicDir = process.env.CACHE_PUBLIC_DIR;
  const workspaceRoots: string[] = [];

  afterEach(() => {
    process.env.AIRTABLE_API_KEY = originalApiKey;
    process.env.CACHE_DATA_DIR = originalCacheDataDir;
    process.env.CACHE_PUBLIC_DIR = originalPublicDir;

    for (const rootDir of workspaceRoots.splice(0)) {
      cleanupTempWorkspace({
        rootDir,
        publicDir: `${rootDir}/public`,
        dataDir: `${rootDir}/data/cache`,
      });
    }
  });

  it("serves a generated preload file from a snapshot when the public file is missing", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    process.env.AIRTABLE_API_KEY = "test-airtable-key";
    process.env.CACHE_DATA_DIR = workspace.dataDir;
    process.env.CACHE_PUBLIC_DIR = workspace.publicDir;

    writeSnapshot(workspace, EXAMPLE_SITE_KEY, {
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
    });

    const response = await GET(new NextRequest("http://localhost:4444/preload-cache/test"), {
      params: Promise.resolve({ siteToken: siteKeyToFileToken(EXAMPLE_SITE_KEY) }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Content-Length");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    await expect(response.text()).resolves.toContain("window.airtableCache = cache;");

    const preloadPath = path.join(
      workspace.publicDir,
      `cache-${siteKeyToFileToken(EXAMPLE_SITE_KEY)}.js`,
    );
    expect(fs.existsSync(preloadPath)).toBe(true);
    expect(readPreloadCache(preloadPath)[EXAMPLE_FILTERED_LABS_URL]).toEqual(
      EXAMPLE_FILTERED_LABS_BODY,
    );
  });

  it("returns 404 when neither a preload file nor a snapshot exists", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    process.env.AIRTABLE_API_KEY = "test-airtable-key";
    process.env.CACHE_DATA_DIR = workspace.dataDir;
    process.env.CACHE_PUBLIC_DIR = workspace.publicDir;

    const response = await GET(new NextRequest("http://localhost:4444/preload-cache/test"), {
      params: Promise.resolve({ siteToken: siteKeyToFileToken(EXAMPLE_SITE_KEY) }),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not Found");
  });

  it("accepts historical cache-file tokens that include a .js suffix", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    process.env.AIRTABLE_API_KEY = "test-airtable-key";
    process.env.CACHE_DATA_DIR = workspace.dataDir;
    process.env.CACHE_PUBLIC_DIR = workspace.publicDir;

    const legacySiteKey = "localhost:3000";

    writeSnapshot(workspace, legacySiteKey, {
      version: 1,
      siteKey: legacySiteKey,
      savedAt: 1_700_000_000_000,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_700_000_000_000,
        },
      },
    });

    const response = await GET(new NextRequest("http://localhost:4444/preload-cache/localhost:3000.js"), {
      params: Promise.resolve({ siteToken: "localhost:3000.js" }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("window.airtableCache = cache;");

    const preloadPath = path.join(
      workspace.publicDir,
      `cache-${siteKeyToFileToken(legacySiteKey)}.js`,
    );
    expect(fs.existsSync(preloadPath)).toBe(true);
    expect(readPreloadCache(preloadPath)[EXAMPLE_FILTERED_LABS_URL]).toEqual(
      EXAMPLE_FILTERED_LABS_BODY,
    );
  });
});
