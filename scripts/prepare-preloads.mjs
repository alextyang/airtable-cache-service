import { promises as fileSystem } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDirectory(cwd, rawValue, fallbackRelativePath) {
  if (!rawValue) {
    return path.join(cwd, fallbackRelativePath);
  }

  return path.resolve(cwd, rawValue);
}

function stripOffsetField(body) {
  if (!isJsonObject(body)) {
    return null;
  }

  const bodyWithoutOffset = { ...body };
  delete bodyWithoutOffset.offset;
  return bodyWithoutOffset;
}

function buildPreloadScript(snapshotEntries) {
  const preloadEntries = Object.fromEntries(
    Object.entries(snapshotEntries).flatMap(([cacheKey, rawEntry]) => {
      if (!isJsonObject(rawEntry) || !isJsonObject(rawEntry.body)) {
        return [];
      }

      const strippedBody = stripOffsetField(rawEntry.body);
      if (!strippedBody) {
        return [];
      }

      return [[cacheKey, strippedBody]];
    }),
  );

  return `export const cache = ${JSON.stringify(preloadEntries, null, 2)};\nwindow.airtableCache = cache;\n`;
}

async function readFileIfExists(filePath) {
  try {
    return await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeFileAtomically(filePath, contents) {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fileSystem.writeFile(temporaryPath, contents, "utf8");
  await fileSystem.rename(temporaryPath, filePath);
}

function createStartupLogger(logger = console) {
  return {
    info(message, details) {
      if (details) {
        logger.info(`[airtable-startup] ${message}`, details);
        return;
      }

      logger.info(`[airtable-startup] ${message}`);
    },
    warn(message, details) {
      if (details) {
        logger.warn(`[airtable-startup] ${message}`, details);
        return;
      }

      logger.warn(`[airtable-startup] ${message}`);
    },
  };
}

export async function reconcileDerivedPreloadFilesFromSnapshots({
  cwd = process.cwd(),
  env = process.env,
  logger = console,
} = {}) {
  const startupLogger = createStartupLogger(logger);
  const cacheDataDirectory = resolveDirectory(cwd, env.CACHE_DATA_DIR, path.join("data", "cache"));
  const publicCacheDirectory = resolveDirectory(cwd, env.CACHE_PUBLIC_DIR, "public");

  let directoryEntries;
  try {
    directoryEntries = await fileSystem.readdir(cacheDataDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      startupLogger.info("Skipped preload preparation because the snapshot directory does not exist.", {
        cacheDataDirectory,
      });
      return {
        discoveredSnapshotCount: 0,
        rewrittenPreloadCount: 0,
        skippedSnapshotCount: 0,
      };
    }

    throw error;
  }

  let discoveredSnapshotCount = 0;
  let rewrittenPreloadCount = 0;
  let skippedSnapshotCount = 0;

  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".json")) {
      continue;
    }

    discoveredSnapshotCount += 1;
    const snapshotToken = path.basename(directoryEntry.name, ".json");
    const snapshotPath = path.join(cacheDataDirectory, directoryEntry.name);
    const preloadPath = path.join(publicCacheDirectory, `cache-${snapshotToken}.js`);

    let parsedSnapshot;
    try {
      parsedSnapshot = JSON.parse(await fileSystem.readFile(snapshotPath, "utf8"));
    } catch (error) {
      skippedSnapshotCount += 1;
      startupLogger.warn("Skipped a snapshot because it could not be parsed.", {
        snapshotPath,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
      continue;
    }

    if (!isJsonObject(parsedSnapshot) || !isJsonObject(parsedSnapshot.entries)) {
      skippedSnapshotCount += 1;
      startupLogger.warn("Skipped a snapshot because it did not contain a valid entries object.", {
        snapshotPath,
      });
      continue;
    }

    const expectedPreloadContents = buildPreloadScript(parsedSnapshot.entries);
    const currentPreloadContents = await readFileIfExists(preloadPath);

    if (currentPreloadContents === expectedPreloadContents) {
      continue;
    }

    await writeFileAtomically(preloadPath, expectedPreloadContents);
    rewrittenPreloadCount += 1;
    startupLogger.info("Prepared the public preload file from the persisted snapshot.", {
      snapshotPath,
      preloadPath,
      reason: currentPreloadContents === null ? "missing" : "mismatch",
    });
  }

  startupLogger.info("Finished preload preparation.", {
    cacheDataDirectory,
    publicCacheDirectory,
    discoveredSnapshotCount,
    rewrittenPreloadCount,
    skippedSnapshotCount,
  });

  return {
    discoveredSnapshotCount,
    rewrittenPreloadCount,
    skippedSnapshotCount,
  };
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const currentModulePath = fileURLToPath(import.meta.url);

if (invokedScriptPath === currentModulePath) {
  reconcileDerivedPreloadFilesFromSnapshots().catch((error) => {
    console.error("[airtable-startup] Failed to prepare preload files.", error);
    process.exitCode = 1;
  });
}
