// This route is the manual maintenance entry point for browser preload files.
// Normal page loads should hit the generated static file in `public/cache-<site>.js`.
// This route exists as an explicit repair endpoint that can rebuild that file from the private JSON
// snapshot when an operator or proxy wants to recover it on demand.
import { promises as fileSystem } from "fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse, HttpError } from "@/lib/airtable-cache/errors";
import { createAirtableConfig } from "@/lib/airtable-cache/config";
import { createLogger } from "@/lib/airtable-cache/logging";
import { FileSystemCachePersistence } from "@/lib/airtable-cache/persistence";
import { normalizeSiteKey, siteKeyToFileToken } from "@/lib/airtable-cache/request";

export const runtime = "nodejs";

const crossOriginPreloadHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function normalizeRequestedSiteToken(rawSiteToken: string): string {
  const trimmedSiteToken = rawSiteToken.trim();
  if (!trimmedSiteToken) {
    throw new HttpError(400, "INVALID_REF", "The preload site token cannot be empty.");
  }

  // Older callers may still send the filename-style token with a `.js` suffix, while the new
  // persistence layer stores snapshots under the canonical filename-safe token only.
  const tokenWithoutJavaScriptSuffix = trimmedSiteToken.endsWith(".js")
    ? trimmedSiteToken.slice(0, -3)
    : trimmedSiteToken;

  return siteKeyToFileToken(normalizeSiteKey(tokenWithoutJavaScriptSuffix));
}

async function resolvePreloadFileContents(siteToken: string): Promise<string | null> {
  const config = createAirtableConfig();
  const logger = createLogger("airtable-preload-route");
  const persistence = new FileSystemCachePersistence(config, logger);
  const canonicalSiteToken = normalizeRequestedSiteToken(siteToken);
  const preloadPath = path.join(config.publicCacheDir, `cache-${canonicalSiteToken}.js`);
  const existingPreloadContents = await readFileIfExists(preloadPath);

  if (existingPreloadContents !== null) {
    return existingPreloadContents;
  }

  const snapshotPath = path.join(config.cacheDataDir, `${canonicalSiteToken}.json`);
  const snapshotContents = await readFileIfExists(snapshotPath);
  if (snapshotContents === null) {
    return null;
  }

  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(snapshotContents);
  } catch {
    throw new HttpError(
      500,
      "CACHE_PARSE_FAILED",
      "Failed to parse the persisted cache snapshot.",
      {
        snapshotPath,
      },
    );
  }

  if (
    typeof parsedSnapshot !== "object" ||
    parsedSnapshot === null ||
    !("siteKey" in parsedSnapshot) ||
    typeof parsedSnapshot.siteKey !== "string"
  ) {
    throw new HttpError(
      500,
      "CACHE_PARSE_FAILED",
      "Persisted cache snapshots must include a siteKey.",
      {
        snapshotPath,
      },
    );
  }

  const siteKey = normalizeSiteKey(parsedSnapshot.siteKey);
  if (siteKeyToFileToken(siteKey) !== canonicalSiteToken) {
    throw new HttpError(
      500,
      "CACHE_PARSE_FAILED",
      "The snapshot siteKey does not match the requested preload token.",
      {
        requestedToken: canonicalSiteToken,
        snapshotSiteKey: siteKey,
      },
    );
  }

  await persistence.loadSiteSnapshot(siteKey);

  return readFileIfExists(preloadPath);
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ siteToken: string }> },
) {
  try {
    const { siteToken } = await context.params;
    const preloadContents = await resolvePreloadFileContents(siteToken);

    if (preloadContents === null) {
      return new NextResponse("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(preloadContents, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        ...crossOriginPreloadHeaders,
      },
    });
  } catch (error) {
    const response = toErrorResponse(error, "Failed to load the Airtable preload cache file.");
    return NextResponse.json(response.body, { status: response.status });
  }
}
