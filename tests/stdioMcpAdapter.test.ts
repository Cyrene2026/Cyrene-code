import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { StdioMcpAdapter } from "../src/core/mcp";

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: (chunk: string | Buffer) => boolean;
  };
  kill: () => boolean;
};

const createFakeSpawnProcess = () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  let inputBuffer = Buffer.alloc(0);

  const send = (message: Record<string, unknown>) => {
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

  const handle = (request: { id?: number; method?: string; params?: Record<string, unknown> }) => {
    switch (request.method) {
      case "initialize":
        send({
          id: request.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stdio", version: "1.0.0" },
          },
        });
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        send({
          id: request.id,
          result: {
            tools: [{ name: "search_docs", description: "Search docs" }],
          },
        });
        return;
      case "tools/call":
        send({
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: `remote docs: ${String(
                  (request.params?.arguments as Record<string, unknown> | undefined)?.query ?? ""
                )}`,
              },
            ],
          },
        });
        return;
      default:
        send({
          id: request.id,
          error: {
            message: `unknown method: ${request.method}`,
          },
        });
    }
  };

  const pump = () => {
    while (inputBuffer.length > 0) {
      const headerEnd = inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = inputBuffer.slice(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        inputBuffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1] ?? "0");
      const payloadStart = headerEnd + 4;
      const payloadEnd = payloadStart + length;
      if (inputBuffer.length < payloadEnd) {
        return;
      }
      const payload = inputBuffer
        .slice(payloadStart, payloadEnd)
        .toString("utf8");
      inputBuffer = inputBuffer.slice(payloadEnd);
      handle(JSON.parse(payload));
    }
  };

  child.stdin = {
    write: chunk => {
      inputBuffer = Buffer.concat([
        inputBuffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
      ]);
      pump();
      return true;
    },
  };
  child.kill = () => {
    child.emit("exit", 0, null);
    return true;
  };

  const spawnProcess = () => child as any;

  return {
    spawnProcess,
    child,
  };
};

describe("StdioMcpAdapter", () => {
  test("initializes over stdio, lists tools and calls a remote tool", async () => {
    const fakeProcess = createFakeSpawnProcess();
    const adapter = new StdioMcpAdapter(
      {
        id: "docs",
        transport: "stdio",
        label: "Docs",
        enabled: true,
        aliases: ["docs"],
        command: "node",
        args: ["fake-server.mjs"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
      }
    );

    await adapter.initialize();

    expect(adapter.descriptor.health).toBe("online");
    expect(adapter.descriptor.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "search_docs",
        }),
      ])
    );

    const result = await adapter.handleToolCall("search_docs", {
      query: "hello",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("remote docs: hello");

    adapter.dispose();
  });

  test("passes server cwd and env to spawned stdio process", async () => {
    const fakeProcess = createFakeSpawnProcess();
    const capture: {
      current:
        | {
            cwd?: string;
            env?: NodeJS.ProcessEnv;
          }
        | null;
    } = { current: null };
    const adapter = new StdioMcpAdapter(
      {
        id: "docs",
        transport: "stdio",
        label: "Docs",
        enabled: true,
        aliases: ["docs"],
        command: "node",
        args: ["fake-server.mjs"],
        cwd: "./tools/docs",
        env: {
          DOCS_API_KEY: "demo-key",
        },
        tools: [],
      } as any,
      {
        appRoot: "/workspace/project",
        spawnProcess: ((_command: string, _args: string[], options?: {
          cwd?: string;
          env?: NodeJS.ProcessEnv;
        }) => {
          capture.current = options ?? null;
          return fakeProcess.child as any;
        }) as any,
      }
    );

    await adapter.initialize();

    expect(capture.current).not.toBeNull();
    if (!capture.current) {
      throw new Error("spawn options were not captured");
    }
    const spawnOptions = capture.current;
    expect(spawnOptions.cwd).toBe("/workspace/project/tools/docs");
    expect((spawnOptions.env as Record<string, string> | undefined)?.DOCS_API_KEY).toBe(
      "demo-key"
    );

    adapter.dispose();
  });
});
