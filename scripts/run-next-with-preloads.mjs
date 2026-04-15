import path from "node:path";
import { spawn } from "node:child_process";

import { reconcileDerivedPreloadFilesFromSnapshots } from "./prepare-preloads.mjs";

const mode = process.argv[2];

if (mode !== "dev" && mode !== "start") {
  console.error(`[airtable-startup] Unsupported Next.js mode: ${mode ?? "missing"}`);
  process.exit(1);
}

await reconcileDerivedPreloadFilesFromSnapshots();

const nextBinaryPath = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const port = process.env.PORT?.trim() || "4444";
const host = process.env.HOST?.trim();
const nextArguments = [nextBinaryPath, mode, "--port", port];

if (host) {
  nextArguments.push("--hostname", host);
}

if (mode === "dev") {
  nextArguments.push("--turbopack");
}

const nextProcess = spawn(process.execPath, nextArguments, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signalName, () => {
    nextProcess.kill(signalName);
  });
}

nextProcess.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
