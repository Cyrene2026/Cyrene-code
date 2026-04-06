import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpRuntime } from "../src/core/mcp";

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-runtime-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  return root;
};

afterEach(async () => {
  await Promise.all(
    cleanupTasks.splice(0).map(task => task().catch(() => undefined))
  );
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

describe("createMcpRuntime", () => {
  test("loads configured http server, discovers tools and calls remote tool", async () => {
    const root = await createWorkspace();
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        const payload = (await request.json()) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        const argumentsPayload =
          payload.params &&
          typeof payload.params === "object" &&
          "arguments" in payload.params &&
          payload.params.arguments &&
          typeof payload.params.arguments === "object"
            ? (payload.params.arguments as Record<string, unknown>)
            : {};
        const headers = {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
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
            {
              headers,
            }
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
            {
              headers,
            }
          );
        }
        if (payload.method === "tools/call") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `http docs: ${String(argumentsPayload.topic ?? "")}`,
                  },
                ],
              },
            },
            {
              headers,
            }
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

    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "primary_server: filesystem",
        "servers:",
        "  - id: webdocs",
        "    transport: http",
        `    url: "http://127.0.0.1:${server.port}/mcp"`,
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root);

    expect(runtime.listTools("webdocs")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "fetch_docs",
        }),
      ])
    );

    const result = await runtime.handleToolCall("webdocs.fetch_docs", {
      topic: "routing",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("http docs: routing");

    runtime.dispose();
  });

  test("runtime mutations persist project mcp config and refresh active servers", async () => {
    const root = await createWorkspace();
    const runtime = await createMcpRuntime(root);

    const addResult = await runtime.addServer?.({
      id: "docs",
      transport: "http",
      url: "http://127.0.0.1:9100/mcp",
    });
    expect(addResult?.ok).toBe(true);
    expect(runtime.listServers().some(server => server.id === "docs")).toBe(true);

    const disableResult = await runtime.setServerEnabled?.("docs", false);
    expect(disableResult?.ok).toBe(true);
    expect(runtime.listServers().find(server => server.id === "docs")?.enabled).toBe(false);

    const enableResult = await runtime.setServerEnabled?.("docs", true);
    expect(enableResult?.ok).toBe(true);
    expect(runtime.listServers().find(server => server.id === "docs")?.enabled).toBe(true);

    const removeResult = await runtime.removeServer?.("docs");
    expect(removeResult?.ok).toBe(true);
    expect(runtime.listServers().some(server => server.id === "docs")).toBe(false);

    const configText = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(configText).toContain("remove_servers");
    expect(configText).toContain("- docs");

    runtime.dispose();
  });
});
