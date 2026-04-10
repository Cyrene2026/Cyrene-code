import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  HttpMcpAdapter,
  type McpConfiguredServer,
} from "../src/core/mcp";

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
});

describe("HttpMcpAdapter", () => {
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
