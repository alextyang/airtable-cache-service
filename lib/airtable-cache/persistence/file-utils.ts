import { promises as fileSystem } from "fs";
import path from "node:path";

import { CacheEntryState, stripOffsetField } from "@/lib/airtable-cache/types";

export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function buildPreloadScript(entries: Record<string, CacheEntryState>): string {
  const preloadBody = Object.fromEntries(
    Object.entries(entries).map(([cacheKey, entry]) => [cacheKey, stripOffsetField(entry.body)]),
  );

  return `export const cache = ${JSON.stringify(preloadBody, null, 2)};\nwindow.airtableCache = cache;\n`;
}

export async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fileSystem.writeFile(temporaryPath, contents, "utf8");
  await fileSystem.rename(temporaryPath, filePath);
}

export async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

export async function restoreFileContents(
  filePath: string,
  previousContents: string | null,
): Promise<void> {
  if (previousContents === null) {
    await fileSystem.rm(filePath, { force: true });
    return;
  }

  await writeFileAtomically(filePath, previousContents);
}
