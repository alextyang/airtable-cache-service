import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import {
  buildAirtableProxyRequest,
  normalizeAirtableUrl,
  resolveAirtableApiBaseUrl,
  normalizeSiteKey,
  siteKeyToFileToken,
} from "@/lib/airtable-cache/request";
import {
  EXAMPLE_PUBLISHED_DATES_URL,
  EXAMPLE_SITE_KEY,
} from "@/tests/fixtures/cache-example";

describe("airtable request parsing", () => {
  it("accepts hostname-style refs and creates filesystem-safe preload names", () => {
    expect(normalizeSiteKey("Example.com")).toBe("example.com");
    expect(siteKeyToFileToken("localhost:3000")).toBe("localhost_3000");
  });

  it("rejects full URLs passed as refs", () => {
    expect(() => normalizeSiteKey("https://influence.centercentre.com")).toThrow(
      /slug or hostname token/i,
    );
  });

  it("rejects empty refs and refs with unsupported characters", () => {
    expect(() => normalizeSiteKey("   ")).toThrow(/cannot be empty/i);
    expect(() => normalizeSiteKey("bad site key")).toThrow(/unsupported characters/i);
  });

  it("normalizes Airtable URLs by stripping offsets without reordering parameters", () => {
    const normalizedUrl = normalizeAirtableUrl(
      `${EXAMPLE_PUBLISHED_DATES_URL}&offset=itrIgnored&view=Grid`,
    );

    expect(normalizedUrl).toBe(
      "https://api.airtable.com/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=asc&fields%5B%5D=Date&fields%5B%5D=Cohort&filterByFormula=%7BPublished%7D+%3D+%27Published%27&view=Grid",
    );
    expect(normalizeAirtableUrl("not-a-url")).toBeNull();
  });

  it("resolves a custom Airtable base URL and trims trailing slashes", () => {
    expect(
      resolveAirtableApiBaseUrl({
        AIRTABLE_API_BASE_URL: "http://127.0.0.1:9999/mock-airtable/",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("http://127.0.0.1:9999/mock-airtable");
  });

  it("rejects invalid Airtable base URL overrides", () => {
    expect(() =>
      resolveAirtableApiBaseUrl({
        AIRTABLE_API_BASE_URL: "not-a-url",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/AIRTABLE_API_BASE_URL must be a valid absolute URL/i);

    expect(() =>
      resolveAirtableApiBaseUrl({
        AIRTABLE_API_BASE_URL: "ftp://127.0.0.1/mock-airtable",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/AIRTABLE_API_BASE_URL must use http or https/i);
  });

  it("builds a normalized Airtable request from the URL and Referer", () => {
    const request = new NextRequest(
      "http://localhost:4444/v0/app123/tbl456?fields%5B%5D=Name&offset=abc123&refresh=true",
      {
        headers: {
          referer: "https://Influence.CenterCentre.com/library",
        },
      },
    );

    const parsedRequest = buildAirtableProxyRequest(request);

    expect(parsedRequest.siteKey).toBe("influence.centercentre.com");
    expect(parsedRequest.forceRefresh).toBe(true);
    expect(parsedRequest.airtableUrl).toBe(
      "https://api.airtable.com/v0/app123/tbl456?fields%5B%5D=Name",
    );
    expect(parsedRequest.cacheKey).toBe(parsedRequest.airtableUrl);
  });

  it("preserves the caller's Airtable parameter order for preload compatibility", () => {
    const request = new NextRequest(
      "http://localhost:4444/v0/app123/tbl456?sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=asc&fields%5B%5D=Date&fields%5B%5D=Cohort&filterByFormula=%7BPublished%7D%3D%27Published%27&offset=abc123&ref=Influence.CenterCentre.com",
    );

    const parsedRequest = buildAirtableProxyRequest(request);

    expect(parsedRequest.airtableUrl).toBe(
      "https://api.airtable.com/v0/app123/tbl456?sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=asc&fields%5B%5D=Date&fields%5B%5D=Cohort&filterByFormula=%7BPublished%7D%3D%27Published%27",
    );
  });

  it("prefers the explicit ref over the Referer header and preserves encoded path segments", () => {
    const request = new NextRequest(
      "http://localhost:4444/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?filterByFormula=%7BPublished%7D%3D%27Published%27&ref=Influence.CenterCentre.com",
      {
        headers: {
          referer: "https://fallback.example.com/library",
        },
      },
    );

    const parsedRequest = buildAirtableProxyRequest(request);

    expect(parsedRequest.siteKey).toBe(EXAMPLE_SITE_KEY);
    expect(parsedRequest.forceRefresh).toBe(false);
    expect(parsedRequest.airtableUrl).toContain(
      "https://api.airtable.com/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?",
    );
  });

  it("supports a custom Airtable base URL for launched regression testing", () => {
    const request = new NextRequest(
      "http://localhost:4444/v0/appRegression/tblRegression?fields%5B%5D=Name&ref=Influence.CenterCentre.com",
    );

    const parsedRequest = buildAirtableProxyRequest(
      request,
      "http://127.0.0.1:9999/mock-airtable",
    );

    expect(parsedRequest.airtableUrl).toBe(
      "http://127.0.0.1:9999/mock-airtable/v0/appRegression/tblRegression?fields%5B%5D=Name",
    );
  });

  it("accepts duplicated upstream v0 path segments for backward compatibility", () => {
    const request = new NextRequest(
      "http://localhost:4444/v0/v0/appRegression/tblRegression?fields%5B%5D=Name&ref=Influence.CenterCentre.com",
    );

    const parsedRequest = buildAirtableProxyRequest(request);

    expect(parsedRequest.airtableUrl).toBe(
      "https://api.airtable.com/v0/appRegression/tblRegression?fields%5B%5D=Name",
    );
  });

  it("rejects missing refs, invalid referers, and empty Airtable paths", () => {
    expect(() =>
      buildAirtableProxyRequest(new NextRequest("http://localhost:4444/v0/app123/tbl456")),
    ).toThrow(/Provide \?ref=<site>/i);

    expect(() =>
      buildAirtableProxyRequest(
        new NextRequest("http://localhost:4444/v0/app123/tbl456", {
          headers: {
            referer: "not-a-url",
          },
        }),
      ),
    ).toThrow(/Referer header must contain a valid URL/i);

    expect(() =>
      buildAirtableProxyRequest(
        new NextRequest("http://localhost:4444/v0/?ref=influence.centercentre.com"),
      ),
    ).toThrow(/Airtable path is required/i);
  });

  it("rejects referers that do not include a hostname", () => {
    expect(() =>
      buildAirtableProxyRequest(
        new NextRequest("http://localhost:4444/v0/app123/tbl456", {
          headers: {
            referer: "mailto:editor@influence.centercentre.com",
          },
        }),
      ),
    ).toThrow(/Referer header must include a hostname/i);
  });

  it("surfaces Airtable URL normalization failures", () => {
    const request = new NextRequest(
      "http://localhost:4444/v0/app123/tbl456?ref=influence.centercentre.com",
    );
    const NativeUrl = URL;
    const originalUrl = globalThis.URL;
    let urlConstructionCount = 0;

    class FaultyUrl extends NativeUrl {
      constructor(input: string | URL, base?: string | URL) {
        urlConstructionCount += 1;
        if (
          urlConstructionCount === 2 &&
          typeof input === "string" &&
          input.startsWith("https://api.airtable.com/")
        ) {
          throw new TypeError("broken url normalizer");
        }

        super(input, base);
      }
    }

    globalThis.URL = FaultyUrl as unknown as typeof URL;

    try {
      expect(() => buildAirtableProxyRequest(request)).toThrow(
        /Airtable request could not be normalized/i,
      );
    } finally {
      globalThis.URL = originalUrl;
    }
  });
});
