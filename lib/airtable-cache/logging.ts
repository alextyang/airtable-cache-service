import { Logger } from "@/lib/airtable-cache/types";

function formatMessage(scope: string, message: string): string {
  return `[${scope}] ${message}`;
}

function hasContext(context?: Record<string, unknown>): boolean {
  return Boolean(context && Object.keys(context).length > 0);
}

export function createLogger(scope: string): Logger {
  return {
    info(message, context) {
      if (hasContext(context)) {
        console.info(formatMessage(scope, message), context);
        return;
      }

      console.info(formatMessage(scope, message));
    },
    warn(message, context) {
      if (hasContext(context)) {
        console.warn(formatMessage(scope, message), context);
        return;
      }

      console.warn(formatMessage(scope, message));
    },
    error(message, context) {
      if (hasContext(context)) {
        console.error(formatMessage(scope, message), context);
        return;
      }

      console.error(formatMessage(scope, message));
    },
  };
}
