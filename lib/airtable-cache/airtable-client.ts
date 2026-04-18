import { HttpError } from "@/lib/airtable-cache/errors";
import {
  AirtableClientContract,
  AirtableConfig,
  FetchLike,
  isJsonObject,
  JsonObject,
  JsonValue,
  Logger,
  stripOffsetField,
} from "@/lib/airtable-cache/types";

const MAX_AIRTABLE_PAGES = 100;

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
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

function mergePaginatedResponses(pages: JsonObject[]): JsonObject {
  const firstPage = stripOffsetField(pages[0]);
  if (pages.length === 1) {
    return firstPage;
  }

  if (!Array.isArray(firstPage.records)) {
    throw new HttpError(
      502,
      "AIRTABLE_INVALID_PAGINATION",
      "Airtable pagination returned a response without a records array.",
    );
  }

  const mergedRecords = [...firstPage.records];
  for (const page of pages.slice(1)) {
    if (!Array.isArray(page.records)) {
      throw new HttpError(
        502,
        "AIRTABLE_INVALID_PAGINATION",
        "Airtable returned a paginated page without a records array.",
      );
    }

    mergedRecords.push(...page.records);
  }

  return {
    ...firstPage,
    records: mergedRecords,
  };
}

export class AirtableClient implements AirtableClientContract {
  constructor(
    private readonly config: AirtableConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetchMergedResponse(
    airtableUrl: string,
  ): Promise<{ status: number; body: JsonObject; pageCount: number }> {
    const pageBodies: JsonObject[] = [];
    const seenOffsetTokens = new Set<string>();
    let nextOffsetToken: string | undefined;

    do {
      if (pageBodies.length >= MAX_AIRTABLE_PAGES) {
        throw new HttpError(
          502,
          "AIRTABLE_PAGINATION_LIMIT_EXCEEDED",
          "Airtable pagination exceeded the maximum supported page count.",
          {
            airtableUrl,
            maxPages: MAX_AIRTABLE_PAGES,
            pageCount: pageBodies.length,
          },
        );
      }

      const airtablePageUrl = new URL(airtableUrl);
      if (nextOffsetToken) {
        airtablePageUrl.searchParams.set("offset", nextOffsetToken);
      }

      const pageBody = await this.fetchPage(airtablePageUrl.toString());
      pageBodies.push(pageBody);

      const nextOffsetTokenFromPage =
        typeof pageBody.offset === "string" && pageBody.offset.length > 0
          ? pageBody.offset
          : undefined;

      if (nextOffsetTokenFromPage) {
        if (seenOffsetTokens.has(nextOffsetTokenFromPage)) {
          throw new HttpError(
            502,
            "AIRTABLE_INVALID_PAGINATION",
            "Airtable pagination repeated an offset token.",
            {
              airtableUrl,
              repeatedOffset: nextOffsetTokenFromPage,
              pageCount: pageBodies.length,
            },
          );
        }

        seenOffsetTokens.add(nextOffsetTokenFromPage);
      }

      nextOffsetToken = nextOffsetTokenFromPage;
    } while (nextOffsetToken);

    const mergedBody = mergePaginatedResponses(pageBodies);
    this.logger.info("Fetched Airtable response.", {
      airtableUrl,
      pageCount: pageBodies.length,
      recordCount: Array.isArray(mergedBody.records) ? mergedBody.records.length : "n/a",
    });

    return {
      status: 200,
      body: mergedBody,
      pageCount: pageBodies.length,
    };
  }

  private async fetchPage(airtableUrl: string): Promise<JsonObject> {
    let response: Response;

    try {
      response = await this.fetchImpl(airtableUrl, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new HttpError(
          504,
          "AIRTABLE_TIMEOUT",
          "Timed out while waiting for Airtable.",
          { airtableUrl, timeoutMs: this.config.fetchTimeoutMs },
        );
      }

      throw new HttpError(
        502,
        "AIRTABLE_NETWORK_ERROR",
        "Failed to reach Airtable.",
        {
          airtableUrl,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }

    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      const details: Record<string, JsonValue> = {
        airtableUrl,
        airtableStatus: response.status,
      };

      if (isJsonObject(parsedBody)) {
        details.airtableBody = parsedBody;
      } else if (typeof parsedBody === "string") {
        details.airtableText = parsedBody;
      }

      throw new HttpError(
        response.status,
        "AIRTABLE_REQUEST_FAILED",
        "Airtable returned an error response.",
        details,
      );
    }

    if (!isJsonObject(parsedBody)) {
      throw new HttpError(
        502,
        "AIRTABLE_INVALID_RESPONSE",
        "Airtable returned a non-object JSON payload.",
        { airtableUrl },
      );
    }

    return parsedBody;
  }
}
