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

const createFakeDiagnosticLspServer = async (root: string) => {
  const scriptPath = join(root, "fake-diagnostic-lsp.cjs");
  await writeFile(
    scriptPath,
    [
      "let inputBuffer = '';",
      "const send = message => {",
      "  const payload = JSON.stringify({ jsonrpc: '2.0', ...message });",
      "  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\\r\\n\\r\\n${payload}`);",
      "};",
      "const handle = payload => {",
      "  const parsed = JSON.parse(payload);",
      "  if (parsed.method === 'initialize') {",
      "    send({ id: parsed.id ?? null, result: { capabilities: { diagnosticProvider: {} } } });",
      "    return;",
      "  }",
      "  if (parsed.method === 'textDocument/diagnostic') {",
      "    send({ id: parsed.id ?? null, result: { kind: 'full', items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, source: 'fake-lsp', code: 'W1', message: 'demo warning' }] } });",
      "    return;",
      "  }",
      "  if (parsed.method === 'shutdown') {",
      "    send({ id: parsed.id ?? null, result: null });",
      "    return;",
      "  }",
      "  if (typeof parsed.id !== 'undefined') {",
      "    send({ id: parsed.id, result: null });",
      "  }",
      "};",
      "const pump = () => {",
      "  while (true) {",
      "    const separatorIndex = inputBuffer.indexOf('\\r\\n\\r\\n');",
      "    if (separatorIndex < 0) return;",
      "    const header = inputBuffer.slice(0, separatorIndex);",
      "    const match = /Content-Length:\\s*(\\d+)/i.exec(header);",
      "    if (!match) return;",
      "    const length = Number(match[1]);",
      "    const start = separatorIndex + 4;",
      "    if (inputBuffer.length < start + length) return;",
      "    const payload = inputBuffer.slice(start, start + length);",
      "    inputBuffer = inputBuffer.slice(start + length);",
      "    handle(payload);",
      "  }",
      "};",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  inputBuffer += chunk;",
      "  pump();",
      "});",
    ].join("\n"),
    "utf8"
  );
  return scriptPath;
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
    const seenHeaders: string[] = [];
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
        seenHeaders.push(request.headers.get("authorization") ?? "");

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
        "    trusted: true",
        "    allow_private_network: true",
        `    url: "http://127.0.0.1:${port}/mcp"`,
        "    headers:",
        '      Authorization: "Bearer runtime-token"',
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
    expect(seenHeaders.every(value => value === "Bearer runtime-token")).toBe(true);

    runtime.dispose();
  });

  test("project-scoped remote MCP servers stay blocked until explicitly trusted", async () => {
    const { root, cyreneHome } = await createWorkspace();
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
                content: [{ type: "text", text: "trusted call ok" }],
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

    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "primary_server: filesystem",
        "servers:",
        "  - id: webdocs",
        "    transport: http",
        "    allow_private_network: true",
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

    expect(runtime.listServers().find(server => server.id === "webdocs")?.enabled).toBe(false);

    const blocked = await runtime.handleToolCall("webdocs.fetch_docs", {
      topic: "routing",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("Project MCP server is blocked until trusted: webdocs");

    const enabled = await runtime.setServerEnabled?.("webdocs", true);
    expect(enabled?.ok).toBe(true);

    const result = await runtime.handleToolCall("webdocs.fetch_docs", {
      topic: "routing",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("trusted call ok");

    const configText = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(configText).toContain("trusted: true");

    runtime.dispose();
  });

  test("http MCP stays blocked for loopback targets unless allow_private_network is enabled", async () => {
    const { root, cyreneHome } = await createWorkspace();
    const port = await getAvailablePort();

    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "primary_server: filesystem",
        "servers:",
        "  - id: webdocs",
        "    transport: http",
        "    trusted: true",
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

    expect(runtime.listServers().find(server => server.id === "webdocs")?.enabled).toBe(false);

    const blocked = await runtime.handleToolCall("webdocs.fetch_docs", {
      topic: "routing",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("private or loopback addresses require allow_private_network: true");

    runtime.dispose();
  });

  test("http MCP blocks hostnames whose DNS resolves to private addresses", async () => {
    const { root, cyreneHome } = await createWorkspace();
    const lookedUpHosts: string[] = [];

    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "primary_server: filesystem",
        "servers:",
        "  - id: webdocs",
        "    transport: http",
        "    trusted: true",
        '    url: "https://docs.example.test/mcp"',
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
      dnsLookup: async (hostname, options) => {
        lookedUpHosts.push(`${hostname}:${options.all ? "all" : "single"}`);
        return [
          { address: "10.0.0.8", family: 4 },
          { address: "203.0.113.20", family: 4 },
        ];
      },
    });

    expect(lookedUpHosts).toEqual(["docs.example.test:all"]);
    expect(runtime.listServers().find(server => server.id === "webdocs")?.enabled).toBe(false);

    const blocked = await runtime.handleToolCall("webdocs.fetch_docs", {
      topic: "routing",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("hostname resolved to private or loopback address(es)");
    expect(blocked.message).toContain("resolved_addresses: 10.0.0.8");

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
      allowPrivateNetwork: true,
      headers: {
        Authorization: "Bearer docs-token",
      },
    });
    expect(addResult?.ok).toBe(true);
    expect(runtime.listServers().some(server => server.id === "docs")).toBe(true);
    let configText = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(configText).toContain('Authorization: "Bearer docs-token"');
    expect(configText).toContain("allow_private_network: true");

    const addStdioResult = await runtime.addServer?.({
      id: "time",
      transport: "stdio",
      enabled: false,
      command: "node",
      args: ["scripts/time-mcp-server.mjs"],
      cwd: "./scripts",
      env: {
        TIMEZONE: "Asia/Shanghai",
      },
    });
    expect(addStdioResult?.ok).toBe(true);

    const disableResult = await runtime.setServerEnabled?.("docs", false);
    expect(disableResult?.ok).toBe(true);
    expect(runtime.listServers().find(server => server.id === "docs")?.enabled).toBe(false);

    const enableResult = await runtime.setServerEnabled?.("docs", true);
    expect(enableResult?.ok).toBe(true);
    expect(runtime.listServers().find(server => server.id === "docs")?.enabled).toBe(true);

    const exposureResult = await runtime.setServerExposure?.("docs", "scoped");
    expect(exposureResult?.ok).toBe(true);
    expect(runtime.listServers().find(server => server.id === "docs")?.exposure).toBe(
      "scoped"
    );
    configText = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(configText).toContain("exposure: scoped");

    const removeResult = await runtime.removeServer?.("docs");
    expect(removeResult?.ok).toBe(true);
    expect(runtime.listServers().some(server => server.id === "docs")).toBe(false);

    configText = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(configText).toContain("remove_servers");
    expect(configText).toContain("- docs");
    expect(configText).toContain("cwd: ./scripts");
    expect(configText).toContain("TIMEZONE: Asia/Shanghai");
    expect(configText).toContain("trusted: true");

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

  test("bootstrapLsp adds detected mainstream-language presets for the workspace", async () => {
    const { root, cyreneHome } = await createWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), '{ "name": "demo" }\n', "utf8");
    await writeFile(join(root, "tsconfig.json"), '{ "compilerOptions": {} }\n', "utf8");
    await writeFile(join(root, "src", "main.tsx"), "export const App = () => null;\n", "utf8");
    await writeFile(join(root, "scripts.sh"), "echo hi\n", "utf8");

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const result = await runtime.bootstrapLsp?.("filesystem");
    expect(result?.ok).toBe(true);
    expect(result?.message).toContain("MCP LSP bootstrap");
    expect(result?.message).toContain("detected: typescript, json, bash");
    expect(result?.message).toContain("added: typescript, json, bash");
    expect(result?.message).toContain(
      "- typescript: npm install -g typescript-language-server typescript"
    );
    expect(result?.message).toContain(
      "- json: npm install -g vscode-langservers-extracted"
    );
    expect(result?.message).toContain(
      "- bash: npm install -g bash-language-server"
    );
    expect(runtime.listLspServers?.("filesystem").map(entry => entry.id)).toEqual([
      "bash",
      "json",
      "typescript",
    ]);

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

  test("doctorLsp runs diagnostics and reports the diagnostic count for a healthy server", async () => {
    const { root, cyreneHome } = await createWorkspace();
    const fakeLspScript = await createFakeDiagnosticLspServer(root);
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
        "      - id: fake",
        `        command: "${process.execPath.replace(/\\/g, "\\\\")}"`,
        `        args: ["${fakeLspScript.replace(/\\/g, "\\\\")}"]`,
        "        file_patterns: [\"**/*.ts\"]",
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const result = await runtime.doctorLsp?.("repo", "src/demo.ts", {
      lspServerId: "fake",
    });

    expect(result?.ok).toBe(true);
    expect(result?.status).toBe("ready");
    expect(result?.message).toContain("selected: fake");
    expect(result?.message).toContain("diagnostics: 1");

    runtime.dispose();
  });

  test("doctorLsp reports invalid serverId as a parameter error and suggests the path-matching server", async () => {
    const { root, cyreneHome } = await createWorkspace();
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "app", "main.py"), "print('hi')\n", "utf8");
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
        "      - id: python",
        "        command: pyright-langserver",
        "        args: [\"--stdio\"]",
        "        file_patterns: [\"**/*.py\"]",
        "      - id: go",
        "        command: gopls",
        "        file_patterns: [\"**/*.go\"]",
        "      - id: cpp",
        "        command: clangd",
        "        file_patterns: [\"**/*.cpp\", \"**/*.cc\", \"**/*.cxx\", \"**/*.h\", \"**/*.hpp\"]",
      ].join("\n"),
      "utf8"
    );

    const runtime = await createMcpRuntime(root, {
      env: {
        ...process.env,
        CYRENE_HOME: cyreneHome,
      },
    });

    const result = await runtime.doctorLsp?.("repo", "app/main.py", {
      lspServerId: "true",
    });

    expect(result?.ok).toBe(false);
    expect(result?.status).toBe("config_error");
    expect(result?.reason).toBe("server_not_configured");
    expect(result?.message).toContain("requested_lsp: true");
    expect(result?.message).toContain("reason: server_not_configured");
    expect(result?.message).toContain("configured: rust, python, go, cpp");
    expect(result?.message).toContain("relative_path: app/main.py");
    expect(result?.message).toContain("suggestion: did you mean 'python'?");

    runtime.dispose();
  });
});
