#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const binaryName = process.platform === "win32" ? "cyrene-v2.exe" : "cyrene-v2";
const currentDir = dirname(fileURLToPath(import.meta.url));
const binaryPath = resolve(currentDir, "..", "dist", binaryName);

if (!existsSync(binaryPath)) {
  console.error(`Missing built CLI binary: ${binaryPath}`);
  console.error("Run `bun run build` first.");
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", error => {
  console.error(`Failed to launch ${binaryPath}: ${error.message}`);
  process.exit(1);
});
