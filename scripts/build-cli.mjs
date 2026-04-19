import { existsSync } from "node:fs";
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

const helperBinaryName = target =>
  `cyrene-ime-bridge-${target.goos}-${target.goarch}${target.ext}`;

const legacyBinaryName = process.platform === "win32" ? "cyrene-v2.exe" : "cyrene-v2";

const resolveGoExecutable = () => {
  const override = process.env.CYRENE_GO_BIN?.trim();
  if (override) {
    return override;
  }

  if (process.platform !== "win32") {
    return "go";
  }

  const candidates = [
    process.env.GOROOT?.trim() ? resolve(process.env.GOROOT.trim(), "bin", "go.exe") : null,
    process.env.ProgramW6432?.trim()
      ? resolve(process.env.ProgramW6432.trim(), "Go", "bin", "go.exe")
      : null,
    process.env.ProgramFiles?.trim()
      ? resolve(process.env.ProgramFiles.trim(), "Go", "bin", "go.exe")
      : null,
    process.env["ProgramFiles(x86)"]?.trim()
      ? resolve(process.env["ProgramFiles(x86)"].trim(), "Go", "bin", "go.exe")
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return "go.exe";
};

const goExecutable = resolveGoExecutable();

const formatMissingGoMessage = (error) => {
  const lines = [
    `Unable to launch Go compiler: ${goExecutable}`,
    error instanceof Error ? error.message : String(error),
  ];

  if (process.platform === "win32") {
    lines.push(
      "Windows fix: install Go and ensure go.exe is available via PATH, GOROOT\\bin, or CYRENE_GO_BIN."
    );
  } else {
    lines.push("Install Go and ensure the `go` binary is available on PATH.");
  }

  return lines.join("\n");
};

const isWindowsLockError = error =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM" || error.code === "EBUSY")
  );

try {
  await rm(distDir, { recursive: true, force: true });
} catch (error) {
  if (!isWindowsLockError(error)) {
    throw error;
  }
  console.warn(
    `Warning: unable to fully clean ${distDir}; continuing and overwriting build outputs where possible.`
  );
}
await mkdir(distDir, { recursive: true });
await mkdir(goCacheDir, { recursive: true });

for (const target of targets) {
  const binaryPath = resolve(distDir, targetBinaryName(target));
  console.log(`Building ${target.goos}/${target.goarch} -> ${binaryPath}`);

  let build;
  try {
    build = Bun.spawn(
      [
        goExecutable,
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
  } catch (error) {
    throw new Error(formatMissingGoMessage(error));
  }

  const exitCode = await build.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  await stat(binaryPath);
  if (target.goos !== "windows") {
    await chmod(binaryPath, 0o755);
  }

  if (target.goos === "windows") {
    const helperPath = resolve(distDir, helperBinaryName(target));
    console.log(`Building helper ${target.goos}/${target.goarch} -> ${helperPath}`);

    let helperBuild;
    try {
      helperBuild = Bun.spawn(
        [
          goExecutable,
          "build",
          "-ldflags",
          "-H=windowsgui",
          "-o",
          helperPath,
          "./cmd/cyrene-ime-bridge",
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
    } catch (error) {
      throw new Error(formatMissingGoMessage(error));
    }

    const helperExitCode = await helperBuild.exited;
    if (helperExitCode !== 0) {
      process.exit(helperExitCode);
    }

    await stat(helperPath);
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

    if (hostTarget.goos === "windows") {
      const helperSourcePath = resolve(distDir, helperBinaryName(hostTarget));
      const helperLegacyPath = resolve(distDir, "cyrene-ime-bridge.exe");
      await copyFile(helperSourcePath, helperLegacyPath);
      console.log(`Built host helper alias at ${helperLegacyPath}.`);
    }
  }
}

console.log(`Built release CLI binaries in ${distDir}.`);
