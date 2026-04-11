import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (!globalThis.Bun) {
  throw new Error("scripts/build-cli.mjs must be run with Bun.");
}

const rootDir = process.cwd();
const distDir = resolve(rootDir, "dist");
const v2Dir = resolve(rootDir, "src/frontend/components/v2");
const goCacheDir = process.env.GOCACHE?.trim() || resolve(tmpdir(), "cyrene-go-cache");

const targets = [
  { goos: "linux", goarch: "amd64", ext: "" },
  { goos: "linux", goarch: "arm64", ext: "" },
  { goos: "darwin", goarch: "amd64", ext: "" },
  { goos: "darwin", goarch: "arm64", ext: "" },
  { goos: "windows", goarch: "amd64", ext: ".exe" },
  { goos: "windows", goarch: "arm64", ext: ".exe" },
];

const hostGoos = process.platform === "win32" ? "windows" : process.platform;
const hostGoarch =
  process.arch === "x64"
    ? "amd64"
    : process.arch === "arm64"
      ? "arm64"
      : null;

const targetBinaryName = target =>
  `cyrene-v2-${target.goos}-${target.goarch}${target.ext}`;

const legacyBinaryName = process.platform === "win32" ? "cyrene-v2.exe" : "cyrene-v2";

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await mkdir(goCacheDir, { recursive: true });

for (const target of targets) {
  const binaryPath = resolve(distDir, targetBinaryName(target));
  console.log(`Building ${target.goos}/${target.goarch} -> ${binaryPath}`);

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
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch,
        GOCACHE: goCacheDir,
      },
    },
  );

  const exitCode = await build.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  await stat(binaryPath);
  if (target.goos !== "windows") {
    await chmod(binaryPath, 0o755);
  }
}

if (hostGoarch) {
  const hostTarget = targets.find(target => target.goos === hostGoos && target.goarch === hostGoarch);
  if (hostTarget) {
    const sourcePath = resolve(distDir, targetBinaryName(hostTarget));
    const legacyPath = resolve(distDir, legacyBinaryName);
    await copyFile(sourcePath, legacyPath);
    if (process.platform !== "win32") {
      await chmod(legacyPath, 0o755);
    }
    console.log(`Built host CLI binary alias at ${legacyPath}.`);
  }
}

console.log(`Built release CLI binaries in ${distDir}.`);
