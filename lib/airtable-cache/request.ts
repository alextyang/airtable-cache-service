import { NextRequest } from "next/server";

import { HttpError } from "@/lib/airtable-cache/errors";
import { ProxyRequest } from "@/lib/airtable-cache/types";

const SITE_REF_PATTERN = /^(?=.{1,255}$)[a-z0-9._-]+(?::\d{1,5})?$/i;
const DEFAULT_AIRTABLE_API_BASE_URL = "https://api.airtable.com";

export function normalizeSiteKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new HttpError(400, "INVALID_REF", "The site ref cannot be empty.");
  }

  if (normalized.includes("://")) {
    throw new HttpError(
      400,
      "INVALID_REF",
      "The site ref must be a slug or hostname token, not a full URL.",
      { providedRef: normalized },
    );
  }

  if (!SITE_REF_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      "INVALID_REF",
      "The site ref contains unsupported characters.",
      { providedRef: normalized },
    );
  }

  return normalized;
}

export function siteKeyToFileToken(siteKey: string): string {
  return normalizeSiteKey(siteKey).replace(/[^a-z0-9._-]/g, "_");
}

/**
 * Cache identity is based on the base Airtable query. Offset tokens are removed so
 * paginated fragments collapse into the one merged dataset the service returns.
 *
 * Important: we intentionally keep the remaining query parameter order exactly as
 * the caller sent it. The public preload script writes these URLs into
 * `window.airtableCache`, and the legacy program-sites client still does an exact
 * string comparison when looking them up. Sorting the parameters makes the cache
 * semantically equivalent but browser-incompatible, which breaks pre-render data.
 */
export function normalizeAirtableUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("offset");
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveAirtableApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rawValue = env.AIRTABLE_API_BASE_URL?.trim();
  if (!rawValue) {
    return DEFAULT_AIRTABLE_API_BASE_URL;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawValue);
  } catch {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      "AIRTABLE_API_BASE_URL must be a valid absolute URL.",
      { envKey: "AIRTABLE_API_BASE_URL", providedValue: rawValue },
    );
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      "AIRTABLE_API_BASE_URL must use http or https.",
      { envKey: "AIRTABLE_API_BASE_URL", providedValue: rawValue },
    );
  }

  parsedUrl.hash = "";
  parsedUrl.search = "";
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");

  return parsedUrl.toString().replace(/\/$/, "");
}

function resolveRequestSiteKey(request: NextRequest): string {
  const refParam = request.nextUrl.searchParams.get("ref");
  if (refParam) {
    return normalizeSiteKey(refParam);
  }

  const refererHeader = request.headers.get("referer");
  if (!refererHeader) {
    throw new HttpError(
      400,
      "MISSING_REF",
      "Provide ?ref=<site> or send a valid Referer header.",
    );
  }

  let refererUrl: URL;
  try {
    refererUrl = new URL(refererHeader);
  } catch {
    throw new HttpError(
      400,
      "INVALID_REFERER",
      "The Referer header must contain a valid URL.",
    );
  }

  if (!refererUrl.host) {
    throw new HttpError(
      400,
      "INVALID_REFERER",
      "The Referer header must include a hostname.",
    );
  }

  return normalizeSiteKey(refererUrl.host);
}

export function buildAirtableProxyRequest(
  request: NextRequest,
  airtableApiBaseUrl = resolveAirtableApiBaseUrl(),
): ProxyRequest {
  const requestPathWithoutProxyPrefix = request.nextUrl.pathname.replace(/^\/v0\/?/, "");
  const requestedPathSegments = requestPathWithoutProxyPrefix.split("/").filter(Boolean);
  if (requestedPathSegments.length === 0) {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_PATH",
      "The Airtable path is required after /v0/.",
    );
  }

  const upstreamPathSegments =
    requestedPathSegments[0]?.toLowerCase() === "v0"
      ? requestedPathSegments.slice(1)
      : requestedPathSegments;
  if (upstreamPathSegments.length === 0) {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_PATH",
      "The Airtable path is required after /v0/.",
    );
  }

  const upstreamSearchParams = new URLSearchParams(request.nextUrl.searchParams);
  upstreamSearchParams.delete("ref");
  upstreamSearchParams.delete("refresh");
  upstreamSearchParams.delete("offset");
  const encodedUpstreamPath = upstreamPathSegments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const upstreamAirtableUrl = new URL(`${airtableApiBaseUrl}/v0/${encodedUpstreamPath}`);
  for (const [key, value] of upstreamSearchParams.entries()) {
    upstreamAirtableUrl.searchParams.append(key, value);
  }

  const normalizedAirtableUrl = normalizeAirtableUrl(upstreamAirtableUrl.toString());
  if (!normalizedAirtableUrl) {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_URL",
      "The Airtable request could not be normalized.",
    );
  }

  return {
    siteKey: resolveRequestSiteKey(request),
    forceRefresh: request.nextUrl.searchParams.get("refresh") === "true",
    airtableUrl: normalizedAirtableUrl,
    cacheKey: normalizedAirtableUrl,
  };
}
