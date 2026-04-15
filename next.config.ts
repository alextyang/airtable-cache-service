import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

// Browser clients load `cache-<site>.js` from a different origin than the page itself.
// Next serves files in `public/` as static assets, but it does not add cross-origin headers
// automatically. These headers keep the preload file fast and static while still allowing
// module-script loading and debugging with `fetch(...).headers.get(...)` in the browser.
const preloadResponseHeaders = [
  {
    key: "Access-Control-Allow-Origin",
    value: "*",
  },
  {
    key: "Access-Control-Allow-Methods",
    value: "GET, HEAD, OPTIONS",
  },
  {
    key: "Access-Control-Expose-Headers",
    value: "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "cross-origin",
  },
] satisfies NonNullable<Awaited<ReturnType<NonNullable<NextConfig["headers"]>>>[number]["headers"]>;

const nextConfig: NextConfig = {
  outputFileTracingRoot: configDirectory,
  async headers() {
    return [
      {
        // This matches the static preload artifact in `public/cache-<site>.js`.
        source: "/:preloadFile(cache-.*\\.js)",
        headers: preloadResponseHeaders,
      },
      {
        // This repair route is slower than the static file, but it should still behave correctly
        // for cross-origin browsers when an operator calls it directly.
        source: "/preload-cache/:siteToken",
        headers: preloadResponseHeaders,
      },
    ];
  },
};

export default nextConfig;
