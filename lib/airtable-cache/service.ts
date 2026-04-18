import { AirtableClient } from "@/lib/airtable-cache/airtable-client";
import { AirtableCacheStore } from "@/lib/airtable-cache/cache-store";
import { createAirtableConfig } from "@/lib/airtable-cache/config";
import { createLogger } from "@/lib/airtable-cache/logging";
import { FileSystemCachePersistence } from "@/lib/airtable-cache/persistence";
import {
  AirtableConfig,
  FetchLike,
  Logger,
  ProxyRequest,
  ProxyResponse,
} from "@/lib/airtable-cache/types";

interface AirtableCacheServiceOptions {
  config?: AirtableConfig;
  fetchImpl?: FetchLike;
  logger?: Logger;
  now?: () => number;
}

export class AirtableCacheService {
  constructor(private readonly store: AirtableCacheStore) {}

  async handle(request: ProxyRequest): Promise<ProxyResponse> {
    return this.store.resolve(request);
  }

  async waitForIdle(siteKey?: string): Promise<void> {
    await this.store.waitForIdle(siteKey);
  }
}

function createAirtableCacheServiceInstance(
  options: AirtableCacheServiceOptions = {},
): AirtableCacheService {
  const config = options.config ?? createAirtableConfig();
  const logger = options.logger ?? createLogger("airtable-cache");
  const now = options.now ?? Date.now;
  const persistence = new FileSystemCachePersistence(config, logger, now);
  const client = new AirtableClient(config, logger, options.fetchImpl);
  const store = new AirtableCacheStore(config, persistence, client, logger, now);

  return new AirtableCacheService(store);
}

const globalAirtableCacheSingleton = globalThis as typeof globalThis & {
  __airtableCacheService?: AirtableCacheService;
};

export function createAirtableCacheService(
  options: AirtableCacheServiceOptions = {},
): AirtableCacheService {
  return createAirtableCacheServiceInstance(options);
}

export function getAirtableCacheService(): AirtableCacheService {
  if (!globalAirtableCacheSingleton.__airtableCacheService) {
    globalAirtableCacheSingleton.__airtableCacheService =
      createAirtableCacheServiceInstance();
  }

  return globalAirtableCacheSingleton.__airtableCacheService;
}

export function resetAirtableCacheServiceForTests(): void {
  delete globalAirtableCacheSingleton.__airtableCacheService;
}
