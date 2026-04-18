import { isJsonObject, JsonObject, JsonValue } from "@/lib/airtable-cache/types";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): JsonObject {
    const errorBody: JsonObject = {
      code: this.code,
      message: this.message,
    };

    if (this.details && Object.keys(this.details).length > 0) {
      errorBody.details = this.details;
    }

    return { error: errorBody };
  }
}

export function toErrorResponse(
  error: unknown,
  fallbackMessage = "Unexpected server error.",
): { status: number; body: JsonObject } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: error.toBody(),
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: fallbackMessage,
          details: { cause: error.message },
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: fallbackMessage,
      },
    },
  };
}

export function assertJsonObject(
  value: unknown,
  status: number,
  code: string,
  message: string,
  details?: Record<string, JsonValue>,
): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new HttpError(status, code, message, details);
  }
}
