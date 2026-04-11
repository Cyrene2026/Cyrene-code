import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TsServerClient } from "../src/core/mcp";

type FakeTsChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: (chunk: string | Buffer) => boolean;
  };
  kill: () => boolean;
};

type SpawnOptionsSnapshot = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const tempRoots: string[] = [];

const sendTsFrame = (child: FakeTsChildProcess, message: Record<string, unknown>) => {
  const payload = JSON.stringify({
    type: "response",
    success: true,
    ...message,
  });
  child.stdout.emit(
    "data",
    Buffer.from(
      `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`,
      "utf8"
    )
  );
};

const createFakeTsServerSpawn = (handlers: {
  onRequest: (
    request: { seq?: number; command?: string; arguments?: Record<string, unknown> },
    child: FakeTsChildProcess,
    spawnIndex: number
  ) => void;
}) => {
  let spawnCount = 0;
  let lastOptions: SpawnOptionsSnapshot | undefined;

  const spawnProcess = (_command?: string, _args?: string[], options?: SpawnOptionsSnapshot) => {
    const spawnIndex = spawnCount++;
    lastOptions = options;
    const child = new EventEmitter() as FakeTsChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    let inputBuffer = "";

    const pump = () => {
      while (inputBuffer.length > 0) {
        const newlineIndex = inputBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const payload = inputBuffer.slice(0, newlineIndex).trim();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        if (!payload) {
          continue;
        }
        handlers.onRequest(JSON.parse(payload), child, spawnIndex);
      }
    };

    child.stdin = {
      write: chunk => {
        inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        pump();
        return true;
      },
    };

    child.kill = () => {
      child.emit("exit", null, "SIGTERM");
      return true;
    };

    return child as any;
  };

  return {
    spawnProcess,
    getSpawnCount: () => spawnCount,
    getLastOptions: () => lastOptions,
  };
};

const getPathEnvValue = (env?: NodeJS.ProcessEnv) =>
  env?.PATH ?? env?.Path;

describe("TsServerClient", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0, tempRoots.length).map(root =>
        rm(root, { recursive: true, force: true }).catch(() => undefined)
      )
    );
  });

  test("request timeout includes recent stderr lines and resets the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-tsserver-test-"));
    tempRoots.push(root);
    const filePath = join(root, "demo.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const fake = createFakeTsServerSpawn({
      onRequest: (request, child) => {
        if (request.command === "open") {
          child.stderr.emit("data", Buffer.from("Project loading is slow\n", "utf8"));
          return;
        }
      },
    });

    const client = new TsServerClient({
      workspaceRoot: root,
      spawnProcess: fake.spawnProcess as any,
      requestTimeoutMs: 10,
      tsserverPath: "./fake-tsserver.js",
    });

    await expect(client.hover(filePath, 1, 1)).rejects.toThrow(
      "tsserver request 'quickinfo' timed out after 10ms."
    );
    await expect(client.hover(filePath, 1, 1)).rejects.toThrow(
      "Recent tsserver stderr"
    );
    expect(client.getRecentStderr()).toContain("Project loading is slow");
    expect(fake.getSpawnCount()).toBeGreaterThanOrEqual(1);

    client.dispose();
  });

  test("diagnostics runs sequentially and skips timed-out phases while keeping later results", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-tsserver-test-"));
    tempRoots.push(root);
    const filePath = join(root, "demo.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const fake = createFakeTsServerSpawn({
      onRequest: (request, child, spawnIndex) => {
        if (request.command === "syntacticDiagnosticsSync") {
          sendTsFrame(child, {
            request_seq: request.seq,
            body: [
              {
                start: { line: 1, offset: 1 },
                end: { line: 1, offset: 7 },
                code: 1005,
                category: "error",
                text: "';' expected.",
              },
            ],
          });
          return;
        }

        if (request.command === "semanticDiagnosticsSync") {
          child.stderr.emit("data", Buffer.from("semantic worker stalled\n", "utf8"));
          return;
        }

        if (request.command === "suggestionDiagnosticsSync" && spawnIndex >= 1) {
          sendTsFrame(child, {
            request_seq: request.seq,
            body: [
              {
                start: { line: 1, offset: 14 },
                end: { line: 1, offset: 19 },
                code: 80001,
                category: "suggestion",
                text: "Can be converted to async function.",
              },
            ],
          });
        }
      },
    });

    const client = new TsServerClient({
      workspaceRoot: root,
      spawnProcess: fake.spawnProcess as any,
      requestTimeoutMs: 10,
      tsserverPath: "./fake-tsserver.js",
    });

    const result = await client.diagnostics(filePath);

    expect(result.syntactic).toHaveLength(1);
    expect(result.semantic).toHaveLength(0);
    expect(result.suggestion).toHaveLength(1);
    expect(result.warnings?.some(warning => warning.includes("semantic diagnostics unavailable"))).toBe(
      true
    );
    expect(result.warnings?.some(warning => warning.includes("semanticDiagnosticsSync"))).toBe(
      true
    );
    expect(fake.getSpawnCount()).toBeGreaterThanOrEqual(2);

    client.dispose();
  });

  test("spawns tsserver with a restricted environment and preserves explicit overrides", async () => {
    const previousApiKey = process.env.CYRENE_API_KEY;
    const previousPath = getPathEnvValue(process.env);
    process.env.CYRENE_API_KEY = "should-not-leak";
    process.env.PATH = previousPath ?? "/usr/bin";

    const root = await mkdtemp(join(tmpdir(), "cyrene-tsserver-test-"));
    tempRoots.push(root);
    const filePath = join(root, "demo.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const fake = createFakeTsServerSpawn({
      onRequest: (request, child) => {
        if (request.command === "open") {
          sendTsFrame(child, {
            request_seq: request.seq,
            body: true,
          });
          return;
        }
        if (request.command === "quickinfo") {
          sendTsFrame(child, {
            request_seq: request.seq,
            body: {
              kind: "const",
              kindModifiers: "",
              start: { line: 1, offset: 14 },
              end: { line: 1, offset: 19 },
              displayString: "const value: 1",
              documentation: "",
              tags: [],
            },
          });
        }
      },
    });

    const client = new TsServerClient({
      workspaceRoot: root,
      spawnProcess: fake.spawnProcess as any,
      tsserverPath: "./fake-tsserver.js",
      env: {
        CUSTOM_TOOL_FLAG: "enabled",
      },
    });

    try {
      await client.hover(filePath, 1, 14);
      const env = fake.getLastOptions()?.env ?? {};
      expect(env.CYRENE_API_KEY).toBeUndefined();
      expect(getPathEnvValue(env)).toBe(getPathEnvValue(process.env));
      expect(env.CUSTOM_TOOL_FLAG).toBe("enabled");
    } finally {
      client.dispose();
      if (previousApiKey === undefined) {
        delete process.env.CYRENE_API_KEY;
      } else {
        process.env.CYRENE_API_KEY = previousApiKey;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
        delete process.env.Path;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});
