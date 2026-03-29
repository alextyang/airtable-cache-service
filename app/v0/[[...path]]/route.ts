import { NextRequest } from "next/server";

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const FORGET_INTERVAL = 2.9 * 24 * 60 * 60 * 1000; // 3 days

let cache: { [referrer: string]: { [url: string]: any } } = {};
let timestamps: { [referrer: string]: { [url: string]: number } } = {};

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeReferrerHostname(value: string): string {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9.-]/g, '_').slice(0, 255);
    return sanitized || 'unknown';
}

function isOffsetUrl(url: string): boolean {
    try {
        return new URL(url).searchParams.has('offset');
    } catch {
        return false;
    }
}

function getBaseUrlForPagination(url: string): string | null {
    try {
        const parsed = new URL(url);
        parsed.searchParams.delete('offset');
        return parsed.toString();
    } catch {
        return null;
    }
}

export async function GET(request: NextRequest) {
    let { searchParams, pathname } = request.nextUrl;

    let pageKey = request.headers.get("referer");
    let referrer = pageKey?.split("/")[2] || "unknown";

    let refresh = 'false';

    if (searchParams.has("ref")) {
        referrer = searchParams.get("ref") || referrer;
        searchParams.delete("ref"); // Remove the ref parameter to avoid it in the API call
    }

    referrer = sanitizeReferrerHostname(referrer);

    if (searchParams.has("refresh")) {
        refresh = searchParams.get("refresh") ?? 'false';
        searchParams.delete("refresh");
    }

    // Extract path segments from the pathname
    let path = pathname
        .replace(/^\/app\/|\/$/g, "") // Remove leading '/app/' and trailing '/'
        .split("/")
        .filter(Boolean);

    let params = searchParams.toString();

    if (!path || path.length === 0) {
        path = [""]; // Handle the case where no path is provided
    }

    const url = `https://api.airtable.com/${path.join("/")}?${params}`;
    console.log("\n\n----------\n[API] Request: " + decodeURIComponent(url));

    let data: any;

    if (!cache[referrer]) {
        await loadCache(referrer);
    }

    if (cache[referrer]?.[url] && !(refresh === 'true')) {
        data = cache[referrer][url];
        console.log("\n[API] Cache hit for URL:", decodeURIComponent(url), "\n--  Records:", data.records ? data.records.length : 'N/A', '\n\n');

        const lastUpdated = timestamps[referrer][url] || 0;
        if (Date.now() - lastUpdated > REFRESH_INTERVAL)
            refreshCache(url, referrer);

        if (searchParams.has('offset')) {
            console.log("[API] Response includes 'offset' for pagination.");
            await mergePaginatedData(referrer);
        }

        return new Response(JSON.stringify(data), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
        });
    }

    console.log("\n[API] Cache miss for URL:", decodeURIComponent(url));

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${AIRTABLE_API_KEY}`,
            "Content-Type": "application/json",
        },
    });

    data = await response.json();

    if (response.ok) {
        cache[referrer] = cache[referrer] || {};
        timestamps[referrer] = timestamps[referrer] || {};
        cache[referrer][url] = data;
        timestamps[referrer][url] = Date.now();
    }

    if (searchParams.has('offset')) {
        console.log("[API] Response includes 'offset' for pagination.");
        await mergePaginatedData(referrer);
    }

    await saveCache(referrer);

    console.log("[API] Response: ", response.status, "\n--  Records:", data.records ? data.records.length : 'N/A', '\n\n');

    return new Response(JSON.stringify(data),
        {
            status: response.status,
            headers: {
                "Content-Type": "application/json",
            },
        }
    );
}

async function mergePaginatedData(referrerHostname: string) {
    if (!isRecord(cache[referrerHostname])) {
        cache[referrerHostname] = {};
        return;
    }

    if (!isRecord(timestamps[referrerHostname])) {
        timestamps[referrerHostname] = {};
    }

    const offsetEndByBaseAndToken: Record<string, string> = {};

    for (const url of Object.keys(cache[referrerHostname])) {
        if (!isOffsetUrl(url)) continue;

        try {
            const parsed = new URL(url);
            const token = parsed.searchParams.get('offset');
            parsed.searchParams.delete('offset');
            const baseUrl = parsed.toString();

            if (token) {
                offsetEndByBaseAndToken[`${baseUrl}::${token}`] = url;
            }
        } catch (error) {
            console.error('[API] Skipping malformed cached URL during pagination merge:', url, error);
        }
    }

    let mergedAny = false;

    for (const startUrl of Object.keys(cache[referrerHostname])) {
        if (isOffsetUrl(startUrl)) continue;

        const startData = cache[referrerHostname][startUrl];
        const baseUrl = getBaseUrlForPagination(startUrl);
        if (!baseUrl || !isRecord(startData)) continue;

        while (typeof startData.offset === 'string' && startData.offset.length > 0) {
            const currentOffsetToken = startData.offset;
            const endUrl = offsetEndByBaseAndToken[`${baseUrl}::${currentOffsetToken}`];
            if (!endUrl) break;

            const endData = cache[referrerHostname][endUrl];
            console.log("[API] Backfilling paginated data and deleting request:", endUrl, "\n\n-- Merging ", startData.records ? startData.records.length : 'N/A', " <-- ", endData?.records ? endData.records.length : 'N/A', " records.");

            if (!isRecord(endData) || !Array.isArray(startData.records) || !Array.isArray(endData.records)) {
                break;
            }

            startData.records = startData.records.concat(endData.records);
            startData.offset = typeof endData.offset === 'string' ? endData.offset : undefined;

            delete cache[referrerHostname][endUrl];
            delete timestamps[referrerHostname][endUrl];
            delete offsetEndByBaseAndToken[`${baseUrl}::${currentOffsetToken}`];

            cache[referrerHostname][startUrl] = startData;
            mergedAny = true;
        }
    }

    if (mergedAny) {
        await saveCache(referrerHostname);
    }
}

const PREFIX = 'export const cache = ';
const SUFFIX = ';\nwindow.airtableCache = cache;';

async function saveCache(referrerHostname: string) {
    cache[referrerHostname] = cache[referrerHostname] || {};
    timestamps[referrerHostname] = timestamps[referrerHostname] || {};

    const persistedCache: Record<string, any> = {};
    const persistedTimestamps: Record<string, number> = {};

    for (const key in cache[referrerHostname]) {
        if (isOffsetUrl(key)) {
            continue;
        }

        persistedCache[key] = cache[referrerHostname][key];

        const timestamp = timestamps[referrerHostname][key];
        if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
            persistedTimestamps[key] = timestamp;
        }
    }

    const cacheString = PREFIX + JSON.stringify(persistedCache) + SUFFIX;

    const fs = require('fs');
    const path = require('path');
    const cacheFilePath = path.join(process.cwd(), 'public', 'cache-' + referrerHostname + '.js');

    fs.writeFileSync(cacheFilePath, cacheString, 'utf8');
    console.log("[API] Cache saved to", cacheFilePath, '\n\n');

    await saveTimestamps(referrerHostname, persistedTimestamps);
}

async function saveTimestamps(referrerHostname: string, timestampsToPersist?: Record<string, number>) {
    const timestampsString = JSON.stringify(timestampsToPersist ?? timestamps[referrerHostname]);
    const fs = require('fs');
    const path = require('path');
    const timestampsFilePath = path.join(process.cwd(), 'public', 'timestamps-' + referrerHostname + '.json');

    fs.writeFileSync(timestampsFilePath, timestampsString, 'utf8');
    console.log("[API] Timestamps saved to", timestampsFilePath, '\n\n');
}

async function loadCache(referrerHostname: string) {
    const fs = require('fs');
    const path = require('path');
    const cacheFilePath = path.join(process.cwd(), 'public', 'cache-' + referrerHostname + '.js');

    if (fs.existsSync(cacheFilePath)) {
        const fileContent = fs.readFileSync(cacheFilePath, 'utf8') as string;
        const jsonString = fileContent.substring(PREFIX.length, fileContent.indexOf(SUFFIX)).trim();
        let loadedCache: Record<string, any>;

        try {
            loadedCache = JSON.parse(jsonString);
        } catch (error) {
            console.error('[API] Failed to parse cache file for', referrerHostname, error);
            cache[referrerHostname] = {};
            timestamps[referrerHostname] = {};
            return;
        }

        if (!isRecord(loadedCache)) {
            console.error('[API] Cache file is not an object for', referrerHostname);
            cache[referrerHostname] = {};
            timestamps[referrerHostname] = {};
            return;
        }

        cache[referrerHostname] = loadedCache;
        await loadTimestamps(referrerHostname);

        if (!isRecord(timestamps[referrerHostname])) {
            timestamps[referrerHostname] = {};
        }

        for (const key in loadedCache) {
            if (typeof timestamps[referrerHostname][key] !== 'number' || !Number.isFinite(timestamps[referrerHostname][key])) {
                timestamps[referrerHostname][key] = Date.now();
            }
        }

        console.log('[API] Cache loaded from cache-' + referrerHostname + '.js');
    } else {
        cache[referrerHostname] = {};
        timestamps[referrerHostname] = {};
        console.log("[API] No existing cache file found for", referrerHostname);
    }
}

async function loadTimestamps(referrerHostname: string) {
    const fs = require('fs');
    const path = require('path');
    const timestampsFilePath = path.join(process.cwd(), 'public', 'timestamps-' + referrerHostname + '.json');

    if (fs.existsSync(timestampsFilePath)) {
        const fileContent = fs.readFileSync(timestampsFilePath, 'utf8') as string;

        let loadedTimestamps: Record<string, number>;

        try {
            loadedTimestamps = JSON.parse(fileContent);
        } catch (error) {
            console.error('[API] Failed to parse timestamps file for', referrerHostname, error);
            timestamps[referrerHostname] = {};
            return;
        }

        if (!isRecord(loadedTimestamps)) {
            console.error('[API] Timestamps file is not an object for', referrerHostname);
            timestamps[referrerHostname] = {};
            return;
        }

        const normalizedTimestamps: Record<string, number> = {};
        for (const key in loadedTimestamps) {
            const timestamp = loadedTimestamps[key];
            if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
                normalizedTimestamps[key] = timestamp;
            }
        }

        timestamps[referrerHostname] = normalizedTimestamps;

        console.log('[API] Timestamps loaded from timestamps-' + referrerHostname + '.json');
    } else {
        timestamps[referrerHostname] = {};
        console.log("[API] No existing timestamps file found for", referrerHostname);
    }
}

async function refreshCache(url: string, referrerHostname: string) {
    const searchParams = new URL(url).searchParams;

    if (searchParams.has('offset')) {
        console.log("\n\n[API] Skipping refresh for paginated request:", decodeURIComponent(url));
        return;
    }

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${AIRTABLE_API_KEY}`,
            "Content-Type": "application/json",
        },
    });

    const data = await response.json();

    if (response.ok) {
        cache[referrerHostname] = cache[referrerHostname] || {};
        timestamps[referrerHostname] = timestamps[referrerHostname] || {};
        cache[referrerHostname][url] = data;
        timestamps[referrerHostname][url] = Date.now();
        console.log("\n\n[API] Cache refreshed for URL:", decodeURIComponent(url));
    }

    if (Object.keys(data).includes('offset')) {
        let nextOffset = data.offset;

        while (nextOffset) {
            console.log("[API] Refreshed response includes 'offset' for pagination. Continuing fetching.");

            const paginatedUrl = new URL(url);
            paginatedUrl.searchParams.set('offset', nextOffset);

            const paginatedResponse = await fetch(paginatedUrl.toString(), {
                headers: {
                    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
                    "Content-Type": "application/json",
                },
            });

            const paginatedData = await paginatedResponse.json();

            if (paginatedResponse.ok) {
                cache[referrerHostname][paginatedUrl.toString()] = paginatedData;
                timestamps[referrerHostname][paginatedUrl.toString()] = Date.now();
                console.log("[API] Cached paginated data for URL:", decodeURIComponent(paginatedUrl.toString()));
            } else {
                console.error("[API] Failed to fetch paginated data for URL:", decodeURIComponent(paginatedUrl.toString()), paginatedResponse.status);
                break;
            }

            nextOffset = paginatedData.offset;
        }

        await mergePaginatedData(referrerHostname);
    }

    for (const key in cache[referrerHostname]) {
        if (Date.now() - timestamps[referrerHostname][key] > FORGET_INTERVAL) {
            console.log("\n[API] Forgetting cache for unused URL:", decodeURIComponent(key));
            delete cache[referrerHostname][key];
            delete timestamps[referrerHostname][key];
        }
    }

    await saveCache(referrerHostname);
}

// http://localhost:4444/v0/appHcZTzlfXAJpL7I/tblm2TqCcDcx94nA2?filterByFormula=OR(FIND('September 2025', ARRAYJOIN({Cohort}, ',')) > 0, {Cohort} = 'September 2025',FIND('October 2025', ARRAYJOIN({Cohort}, ',')) > 0, {Cohort} = 'October 2025',FIND('November 2025', ARRAYJOIN({Cohort}, ',')) > 0, {Cohort} = 'November 2025')
