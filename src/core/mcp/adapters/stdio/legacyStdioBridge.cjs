#!/usr/bin/env node

const { spawn } = require("node:child_process");

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("legacyStdioBridge: missing command");
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const forwardInput = chunk => {
  if (!child.stdin.destroyed) {
    child.stdin.write(chunk);
  }
};

process.stdin.on("data", forwardInput);
process.stdin.on("end", () => {
  if (!child.stdin.destroyed) {
    child.stdin.end();
  }
});

child.stdout.on("data", chunk => {
  process.stdout.write(chunk);
});

child.stderr.on("data", chunk => {
  process.stderr.write(chunk);
});

child.on("error", error => {
  console.error(`legacyStdioBridge child error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

process.stdin.resume();
