export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export interface CacheEntryState {
  body: JsonObject;
  updatedAt: number;
  lastAccessedAt: number;
}

/**
 * SiteSnapshot is the canonical on-disk record for one site's cache.
 * The JSON snapshot is the source of truth; the public preload file is generated from it.
 */
export interface SiteSnapshot {
  version: 1;
  siteKey: string;
  savedAt: number;
  entries: Record<string, CacheEntryState>;
}

export interface ProxyRequest {
  siteKey: string;
  forceRefresh: boolean;
  /** Normalized upstream Airtable URL with cache-only params removed. */
  airtableUrl: string;
  /** Cache identity for the full Airtable dataset; never includes an `offset` page token. */
  cacheKey: string;
}

export interface ProxyResponse {
  status: number;
  body: JsonObject;
  headers?: Record<string, string>;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type FetchLike = typeof fetch;
export interface AirtableConfig {
  apiKey: string;
  cacheDataDir: string;
  publicCacheDir: string;
  staleAfterMs: number;
  evictAfterMs: number;
  fetchTimeoutMs: number;
}

export interface CachePersistence {
  loadSiteSnapshot(siteKey: string): Promise<SiteSnapshot | null>;
  saveSiteSnapshot(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
    savedAt: number,
  ): Promise<void>;
}

export interface AirtableClientContract {
  fetchMergedResponse(
    airtableUrl: string,
  ): Promise<{ status: number; body: JsonObject; pageCount: number }>;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJsonObject<T extends JsonObject>(value: T): T {
  return structuredClone(value);
}

export function stripOffsetField<T extends JsonObject>(value: T): T {
  const cloned = cloneJsonObject(value);
  delete cloned.offset;
  return cloned;
}
