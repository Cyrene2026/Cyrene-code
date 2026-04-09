import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpRuntime } from "../src/core/mcp";

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-runtime-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  const cyreneHome = join(root, "user-home");
  await mkdir(cyreneHome, { recursive: true });
  return { root, cyreneHome };
};

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
    const { root, cyreneHome } = await createWorkspace();
    const port = await getAvailablePort();
    const server = Bun.serve({
      port,
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
        `    url: "http://127.0.0.1:${port}/mcp"`,
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

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
    const { root, cyreneHome } = await createWorkspace();
    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

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

  test("builtin filesystem tool descriptors include semantic tool descriptions", async () => {
    const { root, cyreneHome } = await createWorkspace();
    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const tsHover = runtime.listTools("filesystem").find(tool => tool.name === "ts_hover");
    const lspHover = runtime.listTools("filesystem").find(tool => tool.name === "lsp_hover");

    expect(tsHover?.description).toBe(
      "TypeScript/JavaScript quick info at an exact file position."
    );
    expect(lspHover?.description).toContain("configured `lsp_servers`");

    runtime.dispose();
  });

  test("LSP mutations persist per-filesystem config and support explicit clearing", async () => {
    const { root, cyreneHome } = await createWorkspace();
    await writeFile(
      join(cyreneHome, "mcp.yaml"),
      [
        "servers:",
        "  - id: repo",
        "    transport: filesystem",
        "    workspace_root: .",
        "    lsp_servers:",
        "      - id: rust",
        "        command: rust-analyzer",
        "        file_patterns: [\"**/*.rs\"]",
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    expect(runtime.listLspServers?.("repo")).toEqual([
      expect.objectContaining({
        filesystemServerId: "repo",
        id: "rust",
        filePatterns: ["**/*.rs"],
      }),
    ]);

    const addResult = await runtime.addLspServer?.("repo", {
      id: "python",
      command: "pyright-langserver",
      args: ["--stdio"],
      filePatterns: ["**/*.py"],
      rootMarkers: ["pyproject.toml", ".git"],
      env: {
        PYRIGHT_PYTHON_FORCE_VERSION: "latest",
      },
    });
    expect(addResult?.ok).toBe(true);
    expect(addResult?.message).toContain("MCP LSP server added");
    expect(addResult?.message).toContain("filesystem_server: repo");
    expect(addResult?.message).toContain("lsp_server: python");
    expect(addResult?.message).toContain("env_keys: PYRIGHT_PYTHON_FORCE_VERSION");
    expect(
      runtime.listLspServers?.("repo").map(entry => entry.id).sort()
    ).toEqual(["python", "rust"]);

    const removeRust = await runtime.removeLspServer?.("repo", "rust");
    expect(removeRust?.ok).toBe(true);
    expect(removeRust?.message).toContain("MCP LSP server removed");
    expect(removeRust?.message).toContain("remaining: python");
    expect(runtime.listLspServers?.("repo").map(entry => entry.id)).toEqual(["python"]);

    const removePython = await runtime.removeLspServer?.("repo", "python");
    expect(removePython?.ok).toBe(true);
    expect(runtime.listLspServers?.("repo")).toEqual([]);

    const configText = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(configText).toContain("lsp_servers:");
    expect(configText).toContain("[]");

    runtime.dispose();
  });

  test("doctorLsp reports startup errors for invalid language-server commands", async () => {
    const { root, cyreneHome } = await createWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "demo.rs"), "fn main() {}\n", "utf8");
    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: repo",
        "    transport: filesystem",
        "    workspace_root: .",
        "    lsp_servers:",
        "      - id: rust",
        "        command: definitely-not-a-real-lsp-binary",
        "        file_patterns: [\"**/*.rs\"]",
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const result = await runtime.doctorLsp?.("repo", "src/demo.rs");

    expect(result?.ok).toBe(false);
    expect(result?.status).toBe("startup_error");
    expect(result?.reason).toBe("command_not_found");
    expect(result?.message).toContain("MCP LSP doctor");
    expect(result?.message).toContain("requested_lsp: (auto)");
    expect(result?.message).toContain("status: startup_error");
    expect(result?.message).toContain("reason: command_not_found");
    expect(result?.message).toContain("definitely-not-a-real-lsp-binary");

    runtime.dispose();
  });

  test("doctorLsp classifies unmatched files and prints match hints", async () => {
    const { root, cyreneHome } = await createWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "demo.py"), "print('hi')\n", "utf8");
    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: repo",
        "    transport: filesystem",
        "    workspace_root: .",
        "    lsp_servers:",
        "      - id: rust",
        "        command: rust-analyzer",
        "        file_patterns: [\"**/*.rs\"]",
        "        root_markers: [\"Cargo.toml\", \".git\"]",
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const result = await runtime.doctorLsp?.("repo", "src/demo.py");

    expect(result?.ok).toBe(false);
    expect(result?.status).toBe("config_error");
    expect(result?.reason).toBe("no_matching_server");
    expect(result?.message).toContain("reason: no_matching_server");
    expect(result?.message).toContain("match_hints:");
    expect(result?.message).toContain("workspace . (path must stay inside)");
    expect(result?.message).toContain("patterns **/*.rs (any glob match)");
    expect(result?.message).toContain("roots Cargo.toml, .git (nearest marker wins)");

    runtime.dispose();
  });

  test("doctorLsp reports multiple matching servers with disambiguation hints", async () => {
    const { root, cyreneHome } = await createWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "demo.ts"), "export const demo = 1;\n", "utf8");
    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: repo",
        "    transport: filesystem",
        "    workspace_root: .",
        "    lsp_servers:",
        "      - id: ts",
        "        command: typescript-language-server",
        "        args: [\"--stdio\"]",
        "        file_patterns: [\"**/*.ts\"]",
        "      - id: deno",
        "        command: deno",
        "        args: [\"lsp\"]",
        "        file_patterns: [\"src/**/*.ts\"]",
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const result = await runtime.doctorLsp?.("repo", "src/demo.ts");

    expect(result?.ok).toBe(false);
    expect(result?.status).toBe("config_error");
    expect(result?.reason).toBe("multiple_matching_servers");
    expect(result?.message).toContain("reason: multiple_matching_servers");
    expect(result?.message).toContain("matched: ts, deno");
    expect(result?.message).toContain("hint: re-run with serverId to disambiguate");

    runtime.dispose();
  });
});
