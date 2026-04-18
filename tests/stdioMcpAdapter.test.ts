import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const createUnresponsiveSpawnProcess = () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: () => true,
  };
  child.kill = () => {
    child.emit("exit", null, "SIGTERM");
    return true;
  };

  const spawnProcess = () => child as any;

  return {
    spawnProcess,
    child,
  };
};

const createLegacyNewlineFallbackSpawnProcess = () => {
  const spawnCalls: Array<{ env?: NodeJS.ProcessEnv }> = [];
  let invocationCount = 0;

  const spawnProcess = (
    _command: string,
    _args: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ) => {
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnCalls.push({ env: options?.env });
    invocationCount += 1;
    const supportsLegacyMode = invocationCount > 1;
    let inputBuffer = Buffer.alloc(0);

    const sendLine = (message: Record<string, unknown>) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        ...message,
      });
      child.stdout.emit("data", Buffer.from(`${payload}\n`, "utf8"));
    };

    const handleLegacyRequest = (request: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    }) => {
      switch (request.method) {
        case "initialize":
          sendLine({
            id: request.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "legacy-stdio", version: "1.0.0" },
            },
          });
          return;
        case "notifications/initialized":
          return;
        case "tools/list":
          sendLine({
            id: request.id,
            result: {
              tools: [{ name: "legacy_docs", description: "Legacy docs" }],
            },
          });
          return;
        case "tools/call":
          sendLine({
            id: request.id,
            result: {
              content: [{ type: "text", text: "legacy ok" }],
            },
          });
          return;
      }
    };

    const pumpLegacyInput = () => {
      while (inputBuffer.length > 0) {
        const newlineIndex = inputBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const payload = inputBuffer.slice(0, newlineIndex).toString("utf8").trim();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        if (!payload) {
          continue;
        }
        handleLegacyRequest(JSON.parse(payload));
      }
    };

    child.stdin = {
      write: chunk => {
        if (!supportsLegacyMode) {
          return true;
        }
        inputBuffer = Buffer.concat([
          inputBuffer,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
        ]);
        pumpLegacyInput();
        return true;
      },
    };
    child.kill = () => {
      child.emit("exit", 0, null);
      return true;
    };

    return child as any;
  };

  return {
    spawnProcess,
    spawnCalls,
  };
};

const createExitAfterInitializeSpawnProcess = () => {
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
      const request = JSON.parse(payload) as {
        id?: number;
        method?: string;
      };
      if (request.method === "initialize") {
        send({
          id: request.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stdio", version: "1.0.0" },
          },
        });
        child.stderr.emit(
          "data",
          Buffer.from("Server started and listening on stdio\n", "utf8")
        );
        child.emit("exit", 17, null);
      }
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

const createLegacyBootstrapEarlyExitThenNewlineSpawnProcess = () => {
  const spawnCalls: Array<{ env?: NodeJS.ProcessEnv }> = [];
  let invocationCount = 0;

  const spawnProcess = (
    _command: string,
    _args: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ) => {
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnCalls.push({ env: options?.env });
    invocationCount += 1;

    const injectedResumeStdin =
      options?.env?.NODE_OPTIONS?.includes("resumeStdin.cjs") ?? false;
    let inputBuffer = Buffer.alloc(0);

    const sendLine = (message: Record<string, unknown>) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        ...message,
      });
      child.stdout.emit("data", Buffer.from(`${payload}\n`, "utf8"));
    };

    const pumpLegacyInput = () => {
      while (inputBuffer.length > 0) {
        const newlineIndex = inputBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const payload = inputBuffer.slice(0, newlineIndex).toString("utf8").trim();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        if (!payload) {
          continue;
        }
        const request = JSON.parse(payload) as {
          id?: number;
          method?: string;
        };
        switch (request.method) {
          case "initialize":
            sendLine({
              id: request.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "legacy-stdio", version: "1.0.0" },
              },
            });
            return;
          case "notifications/initialized":
            return;
          case "tools/list":
            sendLine({
              id: request.id,
              result: {
                tools: [{ name: "legacy_docs", description: "Legacy docs" }],
              },
            });
            return;
        }
      }
    };

    child.stdin = {
      write: chunk => {
        if (invocationCount === 1 && injectedResumeStdin) {
          child.stderr.emit(
            "data",
            Buffer.from(
              "DuckDuckGo, IAsk AI & Monica AI Search MCP server started and listening on stdio\n",
              "utf8"
            )
          );
          child.emit("exit", null, "SIGTERM");
          return true;
        }

        inputBuffer = Buffer.concat([
          inputBuffer,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
        ]);
        pumpLegacyInput();
        return true;
      },
    };
    child.kill = () => {
      child.emit("exit", 0, null);
      return true;
    };

    return child as any;
  };

  return {
    spawnProcess,
    spawnCalls,
  };
};

const createLegacyDirectRetryToolCallSpawnProcess = () => {
  const spawnCalls: Array<{
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }> = [];
  let invocationCount = 0;

  const spawnProcess = (
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ) => {
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnIndex = ++invocationCount;
    const usesQuietShim = args.some(arg => arg.includes("quietLegacyStdout.cjs"));
    spawnCalls.push({
      command,
      args,
      env: options?.env,
    });

    let inputBuffer = Buffer.alloc(0);

    const sendLine = (message: Record<string, unknown>) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        ...message,
      });
      child.stdout.emit("data", Buffer.from(`${payload}\n`, "utf8"));
    };

    const pumpLegacyInput = () => {
      while (inputBuffer.length > 0) {
        const newlineIndex = inputBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const payload = inputBuffer.slice(0, newlineIndex).toString("utf8").trim();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        if (!payload) {
          continue;
        }
        const request = JSON.parse(payload) as {
          id?: number;
          method?: string;
        };
        switch (request.method) {
          case "initialize":
            sendLine({
              id: request.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "legacy-stdio", version: "1.0.0" },
              },
            });
            return;
          case "notifications/initialized":
            return;
          case "tools/list":
            sendLine({
              id: request.id,
              result: {
                tools: [{ name: "web-search", description: "Search the web" }],
              },
            });
            return;
          case "tools/call":
            if (!usesQuietShim) {
              child.stdout.emit(
                "data",
                Buffer.from("Searching for: Beijing to Shanghai\n", "utf8")
              );
            }
            sendLine({
              id: request.id,
              result: {
                content: [{ type: "text", text: "search completed" }],
              },
            });
            return;
        }
      }
    };

    child.stdin = {
      write: chunk => {
        if (spawnIndex === 1) {
          child.stderr.emit(
            "data",
            Buffer.from(
              "DuckDuckGo, IAsk AI & Monica AI Search MCP server started and listening on stdio\n",
              "utf8"
            )
          );
          child.emit("exit", null, "SIGTERM");
          return true;
        }

        inputBuffer = Buffer.concat([
          inputBuffer,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
        ]);
        pumpLegacyInput();
        return true;
      },
    };
    child.kill = () => {
      child.emit("exit", 0, null);
      return true;
    };

    return child as any;
  };

  return {
    spawnProcess,
    spawnCalls,
  };
};

const createInvalidProtocolSpawnProcess = () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: () => {
      child.stdout.emit("data", Buffer.from("not-json\n", "utf8"));
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

const createToolsListFailureSpawnProcess = () => {
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
      const request = JSON.parse(payload) as {
        id?: number;
        method?: string;
      };
      if (request.method === "initialize") {
        send({
          id: request.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stdio", version: "1.0.0" },
          },
        });
      } else if (request.method === "tools/list") {
        send({
          id: request.id,
          error: {
            message: "tools/list failed",
          },
        });
      }
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

const createLowSignalRemoteToolErrorSpawnProcess = () => {
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
      const request = JSON.parse(payload) as {
        id?: number;
        method?: string;
      };
      if (request.method === "initialize") {
        send({
          id: request.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stdio", version: "1.0.0" },
          },
        });
        continue;
      }
      if (request.method === "tools/list") {
        send({
          id: request.id,
          result: {
            tools: [{ name: "web-search", description: "Search the web" }],
          },
        });
        continue;
      }
      if (request.method === "tools/call") {
        child.stderr.emit(
          "data",
          Buffer.from(
            [
              "Error searching DuckDuckGo:",
              "AxiosError | code=ECONNRESET | url=https://duckduckgo.com/html/?q=query",
            ].join("\n"),
            "utf8"
          )
        );
        send({
          id: request.id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "Error executing tool 'web-search': Search failed for \"query\": ",
              },
            ],
          },
        });
      }
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

  return {
    spawnProcess: () => child as any,
    child,
  };
};

const getPathEnvValue = (env?: NodeJS.ProcessEnv) =>
  env?.PATH ?? env?.Path;

const setPathEnvValue = (value: string) => {
  process.env.PATH = value;
  process.env.Path = value;
};

const restorePathEnvValue = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env.PATH;
    delete process.env.Path;
    return;
  }
  process.env.PATH = value;
  process.env.Path = value;
};

describe("StdioMcpAdapter", () => {
  test("queues review-required remote tools instead of executing them immediately", async () => {
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
        tools: [
          {
            name: "search_docs",
            requiresReview: true,
            risk: "medium",
          },
        ],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
      }
    );

    const queued = await adapter.handleToolCall("search_docs", {
      query: "hello",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending).toBeDefined();
    expect(queued.message).toContain("[review required]");
    expect(adapter.listPending()).toHaveLength(1);

    const approved = await adapter.approve(queued.pending!.id);
    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("remote docs: hello");
    expect(adapter.listPending()).toHaveLength(0);

    adapter.dispose();
  });

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

  test("initialize fails fast when the stdio server never responds", async () => {
    const fakeProcess = createUnresponsiveSpawnProcess();
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
        initializeTimeoutMs: 20,
      }
    );

    await expect(adapter.initialize()).rejects.toThrow(
      "MCP stdio initialize timed out: docs (20ms)"
    );
    expect(adapter.descriptor.health).toBe("error");
    expect(adapter.descriptor.healthReason).toBe("initialize_timeout");
    expect(adapter.descriptor.healthExitPhase).toBe("initialize");
    expect(adapter.descriptor.healthExitCode).toBeNull();
    expect(adapter.descriptor.healthExitSignal).toBe("SIGTERM");
    expect(adapter.descriptor.healthExitSource).toBe("cyrene_timeout");
    expect(adapter.descriptor.healthHint).toContain("MCP stdio mode");

    adapter.dispose();
  });

  test("classifies invalid stdout as invalid protocol output", async () => {
    const fakeProcess = createInvalidProtocolSpawnProcess();
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
        initializeTimeoutMs: 20,
      }
    );

    await expect(adapter.initialize()).rejects.toThrow(
      "Invalid MCP stdio JSON from docs"
    );
    expect(adapter.descriptor.health).toBe("error");
    expect(adapter.descriptor.healthReason).toBe("invalid_protocol_output");
    expect(adapter.descriptor.healthHint).toContain("stdout");

    adapter.dispose();
  });

  test("classifies tools/list failures separately", async () => {
    const fakeProcess = createToolsListFailureSpawnProcess();
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
        initializeTimeoutMs: 20,
        discoveryTimeoutMs: 20,
      }
    );

    await expect(adapter.initialize()).rejects.toThrow("tools/list failed");
    expect(adapter.descriptor.health).toBe("error");
    expect(adapter.descriptor.healthReason).toBe("tools_list_failed");
    expect(adapter.descriptor.healthDetail).toContain("tools/list failed");

    adapter.dispose();
  });

  test("augments low-signal remote tool errors with recent stderr detail", async () => {
    const fakeProcess = createLowSignalRemoteToolErrorSpawnProcess();
    const adapter = new StdioMcpAdapter(
      {
        id: "ddg-search",
        transport: "stdio",
        label: "ddg-search",
        enabled: true,
        aliases: [],
        command: "node",
        args: ["fake-server.mjs"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
        initializeTimeoutMs: 20,
        discoveryTimeoutMs: 20,
      }
    );

    const result = await adapter.handleToolCall("web-search", {
      query: "query",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      "Upstream MCP tool reported an error without a concrete cause."
    );
    expect(result.message).toContain("Recent stderr:");
    expect(result.message).toContain("AxiosError | code=ECONNRESET");

    adapter.dispose();
  });

  test("classifies process exit during initialize follow-up as process exited early", async () => {
    const fakeProcess = createExitAfterInitializeSpawnProcess();
    const adapter = new StdioMcpAdapter(
      {
        id: "ddg-search",
        transport: "stdio",
        label: "ddg-search",
        enabled: true,
        aliases: [],
        command: "node",
        args: ["fake-server.mjs"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
        initializeTimeoutMs: 20,
        discoveryTimeoutMs: 20,
      }
    );

    await expect(adapter.initialize()).rejects.toThrow(
      "MCP stdio server not running: ddg-search"
    );
    expect(adapter.descriptor.health).toBe("error");
    expect(adapter.descriptor.healthReason).toBe("process_exited_early");
    expect(adapter.descriptor.healthDetail).toContain(
      "MCP stdio server not running: ddg-search"
    );
    expect(adapter.descriptor.healthDetail).toContain("Server started and listening on stdio");
    expect(adapter.descriptor.healthExitPhase).toBe("initialize");
    expect(adapter.descriptor.healthExitCode).toBe(17);
    expect(adapter.descriptor.healthExitSignal).toBeNull();
    expect(adapter.descriptor.healthExitSource).toBe("external_or_server");

    adapter.dispose();
  });

  test("uses a longer default timeout for npx-backed MCP servers", () => {
    const fakeProcess = createUnresponsiveSpawnProcess();
    const adapter = new StdioMcpAdapter(
      {
        id: "amap-maps",
        transport: "stdio",
        label: "Amap",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@amap/amap-maps-mcp-server"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
      }
    );

    expect((adapter as any).resolveInitializeTimeoutMs()).toBe(45_000);
    expect((adapter as any).resolveDiscoveryTimeoutMs()).toBe(45_000);

    adapter.dispose();
  });

  test("injects resumeStdin for package-manager stdio servers on the initial spawn", async () => {
    const spawnCalls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const adapter = new StdioMcpAdapter(
      {
        id: "ddg-search",
        transport: "stdio",
        label: "ddg-search",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@oevortex/ddg_search@latest"],
        env: {
          NODE_OPTIONS: "--trace-warnings",
        },
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: ((_command: string, _args: string[], options?: {
          env?: NodeJS.ProcessEnv;
        }) => {
          spawnCalls.push(options ?? {});
          return createUnresponsiveSpawnProcess().child as any;
        }) as any,
        initializeTimeoutMs: 20,
      }
    );

    await expect(adapter.initialize()).rejects.toThrow();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.env?.NODE_OPTIONS).toContain("--trace-warnings");
    expect(spawnCalls[0]?.env?.NODE_OPTIONS).toContain("resumeStdin.cjs");
    expect(spawnCalls[1]?.env?.NODE_OPTIONS).toBe("--trace-warnings");

    adapter.dispose();
  });

  test("falls back to legacy newline stdio for npx-backed MCP servers", async () => {
    const fakeProcess = createLegacyNewlineFallbackSpawnProcess();
    const adapter = new StdioMcpAdapter(
      {
        id: "amap-maps",
        transport: "stdio",
        label: "Amap",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@amap/amap-maps-mcp-server"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
        initializeTimeoutMs: 20,
        discoveryTimeoutMs: 20,
      }
    );

    await adapter.initialize();

    expect(fakeProcess.spawnCalls).toHaveLength(2);
    expect(fakeProcess.spawnCalls[0]?.env?.NODE_OPTIONS).toContain("resumeStdin.cjs");
    expect(fakeProcess.spawnCalls[1]?.env?.NODE_OPTIONS ?? "").not.toContain(
      "resumeStdin.cjs"
    );
    expect(adapter.descriptor.health).toBe("online");
    expect(adapter.descriptor.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "legacy_docs",
        }),
      ])
    );

    adapter.dispose();
  });

  test("retries legacy newline without resumeStdin after initialize-stage early exit from package bootstrap server", async () => {
    const fakeProcess = createLegacyBootstrapEarlyExitThenNewlineSpawnProcess();
    const adapter = new StdioMcpAdapter(
      {
        id: "ddg-search",
        transport: "stdio",
        label: "ddg-search",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@oevortex/ddg_search@latest"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        spawnProcess: fakeProcess.spawnProcess as any,
        initializeTimeoutMs: 20,
        discoveryTimeoutMs: 20,
      }
    );

    await adapter.initialize();

    expect(fakeProcess.spawnCalls).toHaveLength(2);
    expect(fakeProcess.spawnCalls[0]?.env?.NODE_OPTIONS).toContain("resumeStdin.cjs");
    expect(fakeProcess.spawnCalls[1]?.env?.NODE_OPTIONS ?? "").not.toContain(
      "resumeStdin.cjs"
    );
    expect(adapter.descriptor.health).toBe("online");
    expect(adapter.descriptor.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "legacy_docs",
        }),
      ])
    );

    adapter.dispose();
  });

  test("uses quiet legacy stdout shim for direct retry so tool-call logs do not corrupt MCP JSON", async () => {
    const fakeProcess = createLegacyDirectRetryToolCallSpawnProcess();
    const tempHome = mkdtempSync(join(tmpdir(), "cyrene-ddg-home-"));
    const packageDir = join(
      tempHome,
      ".npm",
      "_npx",
      "cache-1",
      "node_modules",
      "@oevortex",
      "ddg_search"
    );

    mkdirSync(join(packageDir, "bin"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@oevortex/ddg_search",
        bin: {
          ddg_search: "bin/cli.js",
        },
      }),
      "utf8"
    );
    writeFileSync(join(packageDir, "bin", "cli.js"), "process.stdin.resume();\n", "utf8");

    const adapter = new StdioMcpAdapter(
      {
        id: "ddg-search",
        transport: "stdio",
        label: "ddg-search",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@oevortex/ddg_search@latest"],
        tools: [],
      },
      {
        appRoot: "D:/Projects/js_projects/Cyrene-code",
        env: {
          HOME: tempHome,
        },
        spawnProcess: fakeProcess.spawnProcess as any,
        initializeTimeoutMs: 20,
        discoveryTimeoutMs: 20,
      }
    );

    try {
      await adapter.initialize();
      const result = await adapter.handleToolCall("web-search", {
        query: "Beijing to Shanghai",
      });

      expect(fakeProcess.spawnCalls).toHaveLength(2);
      expect(fakeProcess.spawnCalls[1]?.command).toBe("node");
      expect(fakeProcess.spawnCalls[1]?.args).toEqual(
        expect.arrayContaining([
          expect.stringContaining("legacyStdioBridge.cjs"),
          "--require",
          expect.stringContaining("quietLegacyStdout.cjs"),
          expect.stringContaining("resumeStdin.cjs"),
          expect.stringContaining("node_modules/@oevortex/ddg_search/bin/cli.js"),
        ])
      );
      expect(result.ok).toBe(true);
      expect(result.message).toContain("search completed");
      expect(adapter.descriptor.health).toBe("online");
    } finally {
      adapter.dispose();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("passes server cwd and env to spawned stdio process", async () => {
    const previousApiKey = process.env.CYRENE_API_KEY;
    const previousPath = getPathEnvValue(process.env);
    const appRoot = process.platform === "win32" ? "C:/workspace/project" : "/workspace/project";
    process.env.CYRENE_API_KEY = "should-not-leak";
    setPathEnvValue(previousPath ?? "/usr/bin");

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
        appRoot,
        spawnProcess: ((_command: string, _args: string[], options?: {
          cwd?: string;
          env?: NodeJS.ProcessEnv;
        }) => {
          capture.current = options ?? null;
          return fakeProcess.child as any;
        }) as any,
      }
    );

    try {
      await adapter.initialize();

      expect(capture.current).not.toBeNull();
      if (!capture.current) {
        throw new Error("spawn options were not captured");
      }
      const spawnOptions = capture.current;
      expect(spawnOptions.cwd).toBe(resolve(appRoot, "tools/docs"));
      expect((spawnOptions.env as Record<string, string> | undefined)?.DOCS_API_KEY).toBe(
        "demo-key"
      );
      expect((spawnOptions.env as Record<string, string> | undefined)?.CYRENE_API_KEY).toBeUndefined();
      expect(getPathEnvValue(spawnOptions.env)).toBe(getPathEnvValue(process.env));
    } finally {
      adapter.dispose();
      if (previousApiKey === undefined) {
        delete process.env.CYRENE_API_KEY;
      } else {
        process.env.CYRENE_API_KEY = previousApiKey;
      }
      if (previousPath === undefined) {
        restorePathEnvValue(undefined);
      } else {
        restorePathEnvValue(previousPath);
      }
    }
  });
});
