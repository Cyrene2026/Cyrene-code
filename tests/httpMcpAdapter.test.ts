import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  HttpMcpAdapter,
  type McpConfiguredServer,
} from "../src/core/mcp";

const originalFetch = globalThis.fetch;
const cleanupTasks: Array<() => Promise<void>> = [];

const getAvailablePort = () =>
  new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => {
          rejectPort(new Error("Failed to allocate an ephemeral port."));
        });
        return;
      }
      const { port } = address;
      probe.close(error => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
  });

const createHttpServerConfig = (url: string): McpConfiguredServer => ({
  id: "webdocs",
  transport: "http",
  label: "webdocs",
  enabled: true,
  trusted: true,
  aliases: [],
  url,
  allowPrivateNetwork: true,
  tools: [],
});

afterEach(async () => {
  await Promise.all(
    cleanupTasks.splice(0).map(task => task().catch(() => undefined))
  );
  globalThis.fetch = originalFetch;
});

describe("HttpMcpAdapter", () => {
  test("queues review-required remote tools instead of executing them immediately", async () => {
    const port = await getAvailablePort();
    let toolCallCount = 0;
    const server = Bun.serve({
      port,
      fetch: async request => {
        const payload = (await request.json()) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        const headers = {
          "content-type": "application/json",
          "mcp-session-id": "session-review",
        };

        if (payload.method === "notifications/initialized") {
          return new Response(null, { status: 204, headers });
        }
        if (payload.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-http", version: "1.0.0" },
              },
            },
            { headers }
          );
        }
        if (payload.method === "tools/list") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                tools: [{ name: "fetch_docs", description: "Fetch docs" }],
              },
            },
            { headers }
          );
        }
        if (payload.method === "tools/call") {
          toolCallCount += 1;
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                content: [{ type: "text", text: "approved remote call" }],
              },
            },
            { headers }
          );
        }

        return Response.json(
          {
            jsonrpc: "2.0",
            id: payload.id,
            error: { message: `unknown method: ${payload.method}` },
          },
          {
            status: 400,
            headers,
          }
        );
      },
    });
    cleanupTasks.push(async () => {
      server.stop(true);
    });

    const adapter = new HttpMcpAdapter(
      {
        ...createHttpServerConfig(`http://127.0.0.1:${port}/mcp`),
        tools: [
          {
            name: "fetch_docs",
            requiresReview: true,
            risk: "medium",
          },
        ],
      },
      {
        appRoot: ".",
        fetchImpl: originalFetch,
      } as never
    );

    const queued = await adapter.handleToolCall("fetch_docs", {
      topic: "routing",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending).toBeDefined();
    expect(queued.message).toContain("[review required]");
    expect(adapter.listPending()).toHaveLength(1);
    expect(toolCallCount).toBe(0);

    const approved = await adapter.approve(queued.pending!.id);
    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("approved remote call");
    expect(adapter.listPending()).toHaveLength(0);
    expect(toolCallCount).toBe(1);
  });

  test("blocks HTTP redirects instead of following them", async () => {
    const port = await getAvailablePort();
    const server = Bun.serve({
      port,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${port}/redirected`,
            "mcp-session-id": "session-redirect",
          },
        }),
    });
    cleanupTasks.push(async () => {
      server.stop(true);
    });

    const adapter = new HttpMcpAdapter(
      createHttpServerConfig(`http://127.0.0.1:${port}/mcp`),
      {
        appRoot: ".",
        fetchImpl: originalFetch,
      } as never
    );

    const result = await adapter.handleToolCall("fetch_docs", {
      topic: "routing",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("redirects are not allowed");
    expect(result.message).toContain(`location: http://127.0.0.1:${port}/redirected`);
  });

  test("revalidates the URL before each request, not just at adapter creation", async () => {
    const port = await getAvailablePort();
    const server = Bun.serve({
      port,
      fetch: async request => {
        const payload = (await request.json()) as {
          id?: number;
          method?: string;
        };
        const headers = {
          "content-type": "application/json",
          "mcp-session-id": "session-revalidate",
        };

        if (payload.method === "notifications/initialized") {
          return new Response(null, {
            status: 204,
            headers,
          });
        }
        if (payload.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-http", version: "1.0.0" },
              },
            },
            { headers }
          );
        }
        if (payload.method === "tools/list") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                tools: [{ name: "fetch_docs", description: "Fetch docs" }],
              },
            },
            { headers }
          );
        }
        if (payload.method === "tools/call") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                content: [{ type: "text", text: "should not be reached" }],
              },
            },
            { headers }
          );
        }

        return Response.json(
          {
            jsonrpc: "2.0",
            id: payload.id,
            error: { message: `unknown method: ${payload.method}` },
          },
          {
            status: 400,
            headers,
          }
        );
      },
    });
    cleanupTasks.push(async () => {
      server.stop(true);
    });

    let validationCount = 0;
    const adapter = new HttpMcpAdapter(
      createHttpServerConfig(`http://127.0.0.1:${port}/mcp`),
      {
        appRoot: ".",
        fetchImpl: originalFetch,
        validateRequestUrl: async () => {
          validationCount += 1;
          return validationCount >= 4
            ? "MCP http server blocked: hostname resolved to private or loopback address(es)"
            : null;
        },
      } as never
    );

    const result = await adapter.handleToolCall("fetch_docs", {
      topic: "routing",
    });

    expect(validationCount).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("hostname resolved to private or loopback address(es)");
  });
});
