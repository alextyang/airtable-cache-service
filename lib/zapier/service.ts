import { NextRequest } from "next/server";

import { HttpError } from "@/lib/airtable-cache/errors";
import { createLogger } from "@/lib/airtable-cache/logging";
import { FetchLike, isJsonObject, JsonObject, JsonValue, ProxyResponse } from "@/lib/airtable-cache/types";

interface ZapierProxyConfig {
  sharedSecret: string;
  allowedHosts: Set<string>;
  fetchTimeoutMs: number;
}

function parseAllowedHosts(rawValue: string | undefined): Set<string> {
  return new Set(
    (rawValue ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function resolveZapierConfig(env: NodeJS.ProcessEnv = process.env): ZapierProxyConfig {
  const sharedSecret = env.ZAPIER_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    throw new HttpError(
      500,
      "MISSING_ZAPIER_SECRET",
      "ZAPIER_SHARED_SECRET is required to use the Zapier proxy.",
    );
  }

  const allowedHosts = parseAllowedHosts(env.ZAPIER_ALLOWED_HOSTS);
  if (allowedHosts.size === 0) {
    throw new HttpError(
      500,
      "MISSING_ZAPIER_ALLOWLIST",
      "ZAPIER_ALLOWED_HOSTS must contain at least one hostname.",
    );
  }

  const timeoutValue = Number(env.AIRTABLE_FETCH_TIMEOUT_MS ?? 15_000);
  const fetchTimeoutMs =
    Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 15_000;

  return {
    sharedSecret,
    allowedHosts,
    fetchTimeoutMs,
  };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function extractSharedSecret(request: NextRequest): string | null {
  const headerSecret = request.headers.get("x-zapier-secret");
  if (headerSecret) {
    return headerSecret;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim();
}

function validateEndpoint(endpointValue: string, allowedHosts: Set<string>): URL {
  let endpointUrl: URL;

  try {
    endpointUrl = new URL(endpointValue);
  } catch {
    throw new HttpError(
      400,
      "INVALID_ENDPOINT",
      "The endpoint query parameter must be a valid URL.",
    );
  }

  if (!["http:", "https:"].includes(endpointUrl.protocol)) {
    throw new HttpError(
      400,
      "INVALID_ENDPOINT",
      "The endpoint must use http or https.",
      { protocol: endpointUrl.protocol },
    );
  }

  if (!allowedHosts.has(endpointUrl.host.toLowerCase())) {
    throw new HttpError(
      403,
      "DISALLOWED_ENDPOINT",
      "The endpoint host is not in the Zapier allowlist.",
      { endpointHost: endpointUrl.host.toLowerCase() },
    );
  }

  return endpointUrl;
}

export class ZapierProxyService {
  constructor(
    private readonly config: ZapierProxyConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async handle(request: NextRequest): Promise<ProxyResponse> {
    const sharedSecret = extractSharedSecret(request);
    if (sharedSecret !== this.config.sharedSecret) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "A valid shared secret is required to use the Zapier proxy.",
      );
    }

    const endpointValue = request.nextUrl.searchParams.get("endpoint");
    if (!endpointValue) {
      throw new HttpError(
        400,
        "MISSING_ENDPOINT",
        "The endpoint query parameter is required.",
      );
    }

    const endpointUrl = validateEndpoint(endpointValue, this.config.allowedHosts);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new HttpError(
        400,
        "INVALID_JSON",
        "The Zapier proxy expects a JSON request body.",
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(endpointUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
      });
    } catch (error) {
      throw new HttpError(
        502,
        "ZAPIER_NETWORK_ERROR",
        "Failed to reach the configured Zapier endpoint.",
        {
          endpointHost: endpointUrl.host.toLowerCase(),
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }

    const parsedBody = await parseResponseBody(response);
    if (!response.ok) {
      const details: Record<string, JsonValue> = {
        endpointHost: endpointUrl.host.toLowerCase(),
        upstreamStatus: response.status,
      };

      if (isJsonObject(parsedBody)) {
        details.upstreamBody = parsedBody;
      } else if (typeof parsedBody === "string") {
        details.upstreamText = parsedBody;
      }

      throw new HttpError(
        response.status,
        "ZAPIER_UPSTREAM_ERROR",
        "The Zapier endpoint returned an error response.",
        details,
      );
    }

    if (!isJsonObject(parsedBody)) {
      throw new HttpError(
        502,
        "ZAPIER_INVALID_RESPONSE",
        "The Zapier endpoint returned a non-object JSON payload.",
        { endpointHost: endpointUrl.host.toLowerCase() },
      );
    }

    return {
      status: response.status,
      body: parsedBody as JsonObject,
      headers: {
        "Cache-Control": "no-store",
        "X-Zapier-Proxy": "forwarded",
      },
    };
  }
}

const globalForZapierProxy = globalThis as typeof globalThis & {
  __zapierProxyService?: ZapierProxyService;
};

export function getZapierProxyService(): ZapierProxyService {
  if (!globalForZapierProxy.__zapierProxyService) {
    globalForZapierProxy.__zapierProxyService = new ZapierProxyService(resolveZapierConfig());
    createLogger("zapier-proxy").info("Initialized the Zapier proxy service.");
  }

  return globalForZapierProxy.__zapierProxyService;
}

export function createZapierProxyService(fetchImpl?: FetchLike): ZapierProxyService {
  return new ZapierProxyService(resolveZapierConfig(), fetchImpl);
}
