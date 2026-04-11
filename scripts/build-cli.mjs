import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

if (!globalThis.Bun) {
  throw new Error("scripts/build-cli.mjs must be run with Bun.");
}

const rootDir = process.cwd();
const distDir = resolve(rootDir, "dist");
const binaryName = process.platform === "win32" ? "cyrene-v2.exe" : "cyrene-v2";
const binaryPath = resolve(distDir, binaryName);
const v2Dir = resolve(rootDir, "src/frontend/components/v2");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await mkdir("/tmp/cyrene-go-cache", { recursive: true });

const build = Bun.spawn(
  [
    "go",
    "build",
    "-o",
    binaryPath,
    ".",
  ],
  {
    cwd: v2Dir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE?.trim() || "/tmp/cyrene-go-cache",
    },
  },
);

const exitCode = await build.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

await stat(binaryPath);
if (process.platform !== "win32") {
  await chmod(binaryPath, 0o755);
}

console.log(`Built v2 CLI binary at ${binaryPath}.`);
