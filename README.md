# Airtable Cache Service

A targeted data service for static Center Centre sites that need live Airtable content without paying the latency cost on every page load.

The service has two jobs:

1. Act as a runtime cache in front of Airtable.
2. Publish per-site preload files so browser clients can start with data already on hand.

That combination lets static sites keep their current hosting and deployment model while moving dynamic content closer to first render.

## Why It Exists

Center Centre course sites are mostly static, but key conversion paths depend on frequently changing Airtable data such as cohort schedules and enrollment links. Direct client-side Airtable requests kept the operational model simple, but introduced a visible delay before critical page content appeared.

This service is a localized intervention. It avoids a full SSR migration, keeps the client request format backward compatible, and improves latency in two stages:

1. Runtime caching reduces repeated Airtable calls.
2. Prehydrated preload files let clients skip many network calls entirely.

## Request Model

`GET /v0/<airtable-path>?<original-query>&ref=<site-key>&refresh=true|false`

Behavior:

1. The route normalizes the Airtable request and resolves the site key from `ref` or `Referer`.
2. Cache identity ignores Airtable pagination offsets.
3. Airtable pages are merged into one cached dataset before persistence.
4. The response includes `X-Airtable-Cache` with `hit`, `stale`, `miss`, or `refresh`.

## Prehydrated Cache

Each site snapshot is stored as:

1. `data/cache/<site-token>.json` as the canonical on-disk record
2. `public/cache-<site-token>.js` as the browser-facing preload artifact

The preload file is derived from the JSON snapshot rather than maintained separately. When a client imports it, the browser gets the same request-response inventory that the runtime cache is already maintaining for that site.

## Fallback Chain

The service is designed as an enhancement, not a hard dependency.

1. Clients prefer the preloaded browser cache.
2. If the preload misses, clients can call this service.
3. If this service is unavailable, clients can still fall back to Airtable directly.

That keeps the integration low-risk for existing sites.

## Architecture

1. `app/v0/[[...path]]/route.ts` and `app/zapier/route.ts` are thin route adapters.
2. `lib/airtable-cache/` contains request normalization, caching, persistence, and Airtable-specific behavior.
3. `lib/zapier/service.ts` contains the protected Zapier forwarding flow.
4. `scripts/prepare-preloads.mjs` and `scripts/run-next-with-preloads.mjs` rebuild preload artifacts before local startup.
5. `tests/` covers route behavior, cache behavior, persistence, and regressions.

The live endpoints use the App Router. The tiny `pages/` files exist only because Next.js still expects `_document` and `404` during production builds.

## Configuration

Required:

1. `AIRTABLE_API_KEY`

Optional:

1. `CACHE_STALE_AFTER_MS`
2. `CACHE_EVICT_AFTER_MS`
3. `AIRTABLE_FETCH_TIMEOUT_MS`
4. `CACHE_DATA_DIR`
5. `CACHE_PUBLIC_DIR`
6. `AIRTABLE_API_BASE_URL`
7. `ZAPIER_SHARED_SECRET`
8. `ZAPIER_ALLOWED_HOSTS`

Default policy:

1. Stale after 15 minutes
2. Evict after 72 hours

Eviction is based on `lastAccessedAt`, not only `updatedAt`.

## Local Development

```bash
npm install
npm run dev
```

Validation:

```bash
npm run check
```

Other useful commands:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Operational Notes

1. Generated files under `data/cache/` and `public/cache-*.js` should not be committed.
2. Deleting a corrupted snapshot forces the next request to rebuild it from Airtable.
3. Legacy preload artifacts are migrated into the JSON snapshot format on first access.
4. The cache is process-local and assumes one Node process per VM.
