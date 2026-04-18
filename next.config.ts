import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

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
        source: "/:preloadFile(cache-.*\\.js)",
        headers: preloadResponseHeaders,
      },
      {
        source: "/preload-cache/:siteToken",
        headers: preloadResponseHeaders,
      },
    ];
  },
};

export default nextConfig;
