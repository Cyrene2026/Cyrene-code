import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!globalThis.Bun) {
  throw new Error("scripts/build-cli.mjs must be run with Bun.");
}

const rootDir = process.cwd();
const distDir = resolve(rootDir, "dist");
const cliBundlePath = resolve(distDir, "cli.js");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(rootDir, "src/entrypoint/cli.tsx")],
  outdir: distDir,
  target: "node",
  format: "esm",
  external: ["node-pty", "react-devtools-core"],
  define: {
    "process.env.DEV": JSON.stringify("false"),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const bundledCli = await readFile(cliBundlePath, "utf8");
const reactDevtoolsImport = 'import devtools from "react-devtools-core";';

if (!bundledCli.includes(reactDevtoolsImport)) {
  throw new Error("Expected react-devtools-core import was not found in dist/cli.js.");
}

await writeFile(
  cliBundlePath,
  bundledCli.replace(
    reactDevtoolsImport,
    'const devtools = { connectToDevTools() {} };',
  ),
  "utf8",
);

console.log(`Built ${result.outputs.length} file(s) into ${distDir}.`);
