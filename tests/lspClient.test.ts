import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager } from "../src/core/mcp";

type FakeLspChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: (chunk: string | Buffer, encoding?: BufferEncoding) => boolean;
  };
  kill: () => boolean;
};

type SpawnOptionsSnapshot = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const tempRoots: string[] = [];

const sendLspFrame = (
  child: FakeLspChildProcess,
  message: Record<string, unknown>
) => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
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

const createFakeLspSpawn = () => {
  let lastOptions: SpawnOptionsSnapshot | undefined;

  const spawnProcess = (_command?: string, _args?: string[], options?: SpawnOptionsSnapshot) => {
    lastOptions = options;
    const child = new EventEmitter() as FakeLspChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    let inputBuffer = "";

    const pump = () => {
      while (true) {
        const separatorIndex = inputBuffer.indexOf("\r\n\r\n");
        if (separatorIndex < 0) {
          return;
        }
        const header = inputBuffer.slice(0, separatorIndex);
        const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
        if (!lengthMatch) {
          return;
        }
        const contentLength = Number(lengthMatch[1]);
        const frameStart = separatorIndex + 4;
        if (inputBuffer.length < frameStart + contentLength) {
          return;
        }
        const payload = inputBuffer.slice(frameStart, frameStart + contentLength);
        inputBuffer = inputBuffer.slice(frameStart + contentLength);
        const parsed = JSON.parse(payload) as {
          id?: number | string | null;
          method?: string;
        };
        if (parsed.method === "initialize") {
          sendLspFrame(child, {
            id: parsed.id ?? null,
            result: {
              capabilities: {
                hoverProvider: true,
              },
            },
          });
          continue;
        }
        if (parsed.method === "textDocument/hover") {
          sendLspFrame(child, {
            id: parsed.id ?? null,
            result: null,
          });
          continue;
        }
        if (parsed.method === "shutdown") {
          sendLspFrame(child, {
            id: parsed.id ?? null,
            result: null,
          });
        }
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
    getLastOptions: () => lastOptions,
  };
};

describe("LspClient environment", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0, tempRoots.length).map(root =>
        rm(root, { recursive: true, force: true }).catch(() => undefined)
      )
    );
  });

  test("spawns LSP servers with a restricted environment and preserves explicit overrides", async () => {
    const previousApiKey = process.env.CYRENE_API_KEY;
    const previousPath = process.env.PATH;
    process.env.CYRENE_API_KEY = "should-not-leak";
    process.env.PATH = process.env.PATH ?? "/usr/bin";

    const root = await mkdtemp(join(tmpdir(), "cyrene-lsp-test-"));
    tempRoots.push(root);
    const filePath = join(root, "demo.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const fake = createFakeLspSpawn();
    const manager = new LspManager(
      root,
      [
        {
          id: "ts",
          command: "fake-lsp",
          args: [],
          filePatterns: ["**/*.ts"],
          rootMarkers: [],
          env: {
            CUSTOM_LSP_FLAG: "enabled",
          },
        },
      ],
      {
        spawnProcess: fake.spawnProcess as any,
      }
    );

    try {
      const session = await manager.getSession(filePath, { serverId: "ts" });
      await session.hover(filePath, 1, 14);

      const env = fake.getLastOptions()?.env ?? {};
      expect(env.CYRENE_API_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.CUSTOM_LSP_FLAG).toBe("enabled");
    } finally {
      await manager.dispose();
      if (previousApiKey === undefined) {
        delete process.env.CYRENE_API_KEY;
      } else {
        process.env.CYRENE_API_KEY = previousApiKey;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});
