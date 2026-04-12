#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleCyreneCli } from "./lib/cyrene-cli.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const goos = process.platform === "win32" ? "windows" : process.platform;
const goarch =
  process.arch === "x64"
    ? "amd64"
    : process.arch === "arm64"
      ? "arm64"
      : null;

if (!goarch) {
  console.error(`Unsupported architecture for packaged Cyrene binary: ${process.arch}`);
  process.exit(1);
}

const result = await handleCyreneCli(process.argv.slice(2), {
  packageRoot: resolve(currentDir, ".."),
});

if (result.kind === "handled") {
  process.exit(result.exitCode);
}

const platformBinaryName = `cyrene-v2-${goos}-${goarch}${process.platform === "win32" ? ".exe" : ""}`;
const legacyBinaryName = process.platform === "win32" ? "cyrene-v2.exe" : "cyrene-v2";
const preferredBinaryPath = resolve(currentDir, "..", "dist", platformBinaryName);
const legacyBinaryPath = resolve(currentDir, "..", "dist", legacyBinaryName);
const binaryPath = existsSync(preferredBinaryPath) ? preferredBinaryPath : legacyBinaryPath;

if (!existsSync(binaryPath)) {
  console.error(`Missing built CLI binary: ${binaryPath}`);
  console.error(`Expected packaged binary for ${goos}/${goarch}: ${platformBinaryName}`);
  process.exit(1);
}

const child = spawn(binaryPath, result.args, {
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
