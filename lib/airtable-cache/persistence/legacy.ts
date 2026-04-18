import { normalizeAirtableUrl } from "@/lib/airtable-cache/request";
import {
  CacheEntryState,
  cloneJsonObject,
  JsonObject,
  stripOffsetField,
} from "@/lib/airtable-cache/types";

interface LegacyCachePage {
  rawUrl: string;
  body: JsonObject;
}

interface LegacyPageGroup {
  basePage?: LegacyCachePage;
  paginatedPagesByOffset: Map<string, LegacyCachePage>;
}

export interface LegacyMigrationResult {
  entries: Record<string, CacheEntryState>;
  filesToDelete: string[];
}

export function extractLegacyPreloadJson(fileContents: string): string {
  const match = fileContents.match(
    /export const cache =\s*(\{[\s\S]*\})\s*;\s*window\.airtableCache = cache;?\s*$/,
  );

  if (!match) {
    throw new Error("The cache file does not match the expected preload format.");
  }

  return match[1];
}

function readOffsetTokenFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.searchParams.get("offset");
  } catch {
    return null;
  }
}

export function mergeLegacyPaginatedResponses(
  rawEntries: Record<string, JsonObject>,
  timestamps: Record<string, number>,
  now: number,
): Record<string, CacheEntryState> {
  const pageGroupsByNormalizedUrl = new Map<string, LegacyPageGroup>();

  for (const [rawUrl, body] of Object.entries(rawEntries)) {
    const normalizedKey = normalizeAirtableUrl(rawUrl);
    if (!normalizedKey) {
      continue;
    }

    const pageGroup =
      pageGroupsByNormalizedUrl.get(normalizedKey) ??
      {
        paginatedPagesByOffset: new Map<string, LegacyCachePage>(),
      };

    const offsetToken = readOffsetTokenFromUrl(rawUrl);
    if (offsetToken) {
      pageGroup.paginatedPagesByOffset.set(offsetToken, { rawUrl, body });
    } else {
      pageGroup.basePage = { rawUrl, body };
    }

    pageGroupsByNormalizedUrl.set(normalizedKey, pageGroup);
  }

  const mergedEntries: Record<string, CacheEntryState> = {};

  for (const [cacheKey, pageGroup] of pageGroupsByNormalizedUrl.entries()) {
    if (!pageGroup.basePage) {
      continue;
    }

    const baseBody = cloneJsonObject(pageGroup.basePage.body);
    const mergedBody = stripOffsetField(baseBody);
    const sourceRawUrls = [pageGroup.basePage.rawUrl];

    if (
      typeof pageGroup.basePage.body.offset === "string" &&
      pageGroup.basePage.body.offset.length > 0
    ) {
      if (!Array.isArray(baseBody.records)) {
        continue;
      }

      const mergedRecords = [...baseBody.records];
      const visitedOffsets = new Set<string>();
      let nextOffset: string | undefined = pageGroup.basePage.body.offset;
      let isComplete = true;

      while (nextOffset) {
        if (visitedOffsets.has(nextOffset)) {
          isComplete = false;
          break;
        }

        visitedOffsets.add(nextOffset);
        const nextPage = pageGroup.paginatedPagesByOffset.get(nextOffset);
        if (!nextPage || !Array.isArray(nextPage.body.records)) {
          isComplete = false;
          break;
        }

        mergedRecords.push(...nextPage.body.records);
        sourceRawUrls.push(nextPage.rawUrl);
        nextOffset =
          typeof nextPage.body.offset === "string" && nextPage.body.offset.length > 0
            ? nextPage.body.offset
            : undefined;
      }

      if (!isComplete) {
        continue;
      }

      mergedBody.records = mergedRecords;
    }

    const sourceUpdatedAtValues = sourceRawUrls
      .map((rawUrl) => timestamps[rawUrl])
      .filter((value): value is number => Number.isFinite(value));
    const updatedAt =
      sourceUpdatedAtValues.length > 0 ? Math.max(...sourceUpdatedAtValues) : now;

    mergedEntries[cacheKey] = {
      body: mergedBody,
      updatedAt,
      lastAccessedAt: updatedAt,
    };
  }

  return mergedEntries;
}
