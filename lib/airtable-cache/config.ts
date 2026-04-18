import path from "node:path";

import { HttpError } from "@/lib/airtable-cache/errors";
import { AirtableConfig } from "@/lib/airtable-cache/types";

export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_EVICT_AFTER_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;

function parseDurationMs(
  rawValue: string | undefined,
  envKey: string,
  fallbackValue: number,
): number {
  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      `${envKey} must be a positive number of milliseconds.`,
      { envKey, providedValue: rawValue },
    );
  }

  return parsedValue;
}

function resolveDirectory(
  cwd: string,
  rawValue: string | undefined,
  fallbackRelativePath: string,
): string {
  if (!rawValue) {
    return path.join(cwd, fallbackRelativePath);
  }

  return path.resolve(cwd, rawValue);
}

export function createAirtableConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AirtableConfig {
  const apiKey = env.AIRTABLE_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      500,
      "MISSING_AIRTABLE_API_KEY",
      "AIRTABLE_API_KEY is required to proxy Airtable requests.",
    );
  }

  return {
    apiKey,
    cacheDataDir: resolveDirectory(cwd, env.CACHE_DATA_DIR, path.join("data", "cache")),
    publicCacheDir: resolveDirectory(cwd, env.CACHE_PUBLIC_DIR, "public"),
    staleAfterMs: parseDurationMs(
      env.CACHE_STALE_AFTER_MS,
      "CACHE_STALE_AFTER_MS",
      DEFAULT_STALE_AFTER_MS,
    ),
    evictAfterMs: parseDurationMs(
      env.CACHE_EVICT_AFTER_MS,
      "CACHE_EVICT_AFTER_MS",
      DEFAULT_EVICT_AFTER_MS,
    ),
    fetchTimeoutMs: parseDurationMs(
      env.AIRTABLE_FETCH_TIMEOUT_MS,
      "AIRTABLE_FETCH_TIMEOUT_MS",
      DEFAULT_FETCH_TIMEOUT_MS,
    ),
  };
}
