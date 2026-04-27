import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFilesystemRuleConfig,
  loadMcpConfig,
  saveProjectMcpConfig,
} from "../src/core/mcp";
import { listLspPresets } from "../src/core/mcp/lspPresets";
import {
  configureAppRootFromArgs,
  resetConfiguredAppRoot,
} from "../src/infra/config/appRoot";
import {
  ensureProjectCyreneConfig,
  loadCyreneConfig,
  saveProjectCyreneConfig,
} from "../src/infra/config/loadCyreneConfig";
import { loadPromptPolicy } from "../src/infra/config/loadPromptPolicy";
import { DEFAULT_QUERY_MAX_TOOL_STEPS } from "../src/shared/runtimeDefaults";

const tempRoots: string[] = [];

afterEach(async () => {
  resetConfiguredAppRoot();
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

const createWorkspace = async (configText: string) => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-config-test-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  await writeFile(join(root, ".cyrene", "config.yaml"), configText, "utf8");
  return root;
};

describe("config loaders", () => {
  test("loadCyreneConfig reads key runtime params from config.yaml", async () => {
    const root = await createWorkspace([
      "pin_max_count: 9",
      "query_max_tool_steps: 31",
      "auto_summary_refresh: false",
      "request_temperature: 0.15",
      "debug_capture_anthropic_requests: true",
      "debug_capture_anthropic_requests_dir: .cyrene/debug/anthropic-requests",
      'system_prompt: "focus on tests"',
    ].join("\n"));

    const config = await loadCyreneConfig(root);

    expect(config.pinMaxCount).toBe(9);
    expect(config.queryMaxToolSteps).toBe(31);
    expect(config.autoSummaryRefresh).toBe(false);
    expect(config.requestTemperature).toBe(0.15);
    expect(config.debugCaptureAnthropicRequests).toBe(true);
    expect(config.debugCaptureAnthropicRequestsDir).toBe(
      ".cyrene/debug/anthropic-requests"
    );
    expect(config.systemPrompt).toBe("focus on tests");
  });

  test("loadCyreneConfig merges global defaults with project overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-config-merge-"));
    tempRoots.push(root);
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await mkdir(join(root, ".cyrene"), { recursive: true });
    await writeFile(
      join(globalHome, "config.yaml"),
      [
        "pin_max_count: 12",
        "query_max_tool_steps: 40",
        "auto_summary_refresh: false",
        "debug_capture_anthropic_requests: true",
        'system_prompt: "global prompt"',
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, ".cyrene", "config.yaml"),
      [
        "pin_max_count: 7",
        "request_temperature: 0.6",
        "debug_capture_anthropic_requests: false",
        "debug_capture_anthropic_requests_dir: ./tmp/anthropic-debug",
        'system_prompt: "project prompt"',
      ].join("\n"),
      "utf8"
    );

    const config = await loadCyreneConfig(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    expect(config.pinMaxCount).toBe(7);
    expect(config.queryMaxToolSteps).toBe(40);
    expect(config.autoSummaryRefresh).toBe(false);
    expect(config.requestTemperature).toBe(0.6);
    expect(config.debugCaptureAnthropicRequests).toBe(false);
    expect(config.debugCaptureAnthropicRequestsDir).toBe("./tmp/anthropic-debug");
    expect(config.systemPrompt).toBe("project prompt");
  });

  test("loadCyreneConfig falls back to safe default tool budget when config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-config-default-"));
    tempRoots.push(root);

    const config = await loadCyreneConfig(root);

    expect(config.queryMaxToolSteps).toBe(DEFAULT_QUERY_MAX_TOOL_STEPS);
    expect(config.autoSummaryRefresh).toBe(true);
    expect(config.requestTemperature).toBe(0.2);
    expect(config.debugCaptureAnthropicRequests).toBe(false);
    expect(config.debugCaptureAnthropicRequestsDir).toBeUndefined();
  });

  test("loadCyreneConfig migrates the old runaway tool budget default", async () => {
    const root = await createWorkspace("query_max_tool_steps: 19200");

    const config = await loadCyreneConfig(root);

    expect(config.queryMaxToolSteps).toBe(DEFAULT_QUERY_MAX_TOOL_STEPS);
  });

  test("loadPromptPolicy default system prompt enables autonomous execution plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-prompt-default-"));
    tempRoots.push(root);

    const promptPolicy = await loadPromptPolicy(undefined, root);

    expect(promptPolicy.systemPrompt).toContain("execution plan");
    expect(promptPolicy.systemPrompt).toContain("<cyrene_plan>");
    expect(promptPolicy.systemPrompt).toContain("mark finished steps completed yourself");
  });

  test("loadPromptPolicy prefers project .cyrene.md over global .cyrene.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-prompt-priority-"));
    tempRoots.push(root);
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await mkdir(join(root, ".cyrene"), { recursive: true });
    await writeFile(join(globalHome, ".cyrene.md"), "global policy\n", "utf8");
    await writeFile(join(root, ".cyrene", ".cyrene.md"), "project policy\n", "utf8");

    const promptPolicy = await loadPromptPolicy(undefined, root, {
      env: { CYRENE_HOME: globalHome },
    });

    expect(promptPolicy.projectPrompt).toBe("project policy");
  });

  test("loadCyreneConfig clamps invalid request_temperature into 0..2", async () => {
    const root = await createWorkspace("request_temperature: 9");

    const config = await loadCyreneConfig(root);

    expect(config.requestTemperature).toBe(2);
  });

  test("ensureProjectCyreneConfig creates a default project config.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-config-init-"));
    tempRoots.push(root);

    const created = await ensureProjectCyreneConfig(root);
    const configText = await readFile(created.path, "utf8");

    expect(created.created).toBe(true);
    expect(created.path).toBe(join(root, ".cyrene", "config.yaml"));
    expect(configText).toContain("pin_max_count:");
    expect(configText).toContain("query_max_tool_steps:");
    expect(configText).toContain("auto_summary_refresh:");
    expect(configText).toContain("request_temperature:");
    expect(configText).toContain("debug_capture_anthropic_requests:");
    expect(configText).toContain("debug_capture_anthropic_requests_dir:");
  });

  test("saveProjectCyreneConfig updates project config.yaml and preserves unrelated lines", async () => {
    const root = await createWorkspace([
      "# custom project config",
      "query_max_tool_steps: 31",
      "request_temperature: 0.15",
      "workspace_root: .",
      "",
    ].join("\n"));

    const saved = await saveProjectCyreneConfig(
      {
        queryMaxToolSteps: 64,
        requestTemperature: 0.4,
        debugCaptureAnthropicRequests: true,
      },
      root
    );
    const content = await readFile(saved.path, "utf8");
    const config = await loadCyreneConfig(root);

    expect(content).toContain("# custom project config");
    expect(content).toContain("workspace_root: .");
    expect(content).toContain("query_max_tool_steps: 64");
    expect(content).toContain("request_temperature: 0.4");
    expect(content).toContain("debug_capture_anthropic_requests: true");
    expect(config.queryMaxToolSteps).toBe(64);
    expect(config.requestTemperature).toBe(0.4);
    expect(config.debugCaptureAnthropicRequests).toBe(true);
  });

  test("loadFilesystemRuleConfig falls back to config.yaml for MCP review settings", async () => {
    const root = await createWorkspace([
      "workspace_root: .",
      "max_read_bytes: 4096",
      "require_review:",
      "  - create_file",
      "  - move_path",
      "  - run_command",
    ].join("\n"));

    const config = await loadFilesystemRuleConfig(root);

    expect(config.workspaceRoot).toBe(root);
    expect(config.maxReadBytes).toBe(4096);
    expect(config.requireReview).toEqual([
      "create_file",
      "move_path",
      "run_command",
    ]);
  });

  test("loadFilesystemRuleConfig merges global defaults with project overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-rule-merge-"));
    tempRoots.push(root);
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await mkdir(join(root, ".cyrene"), { recursive: true });
    await writeFile(
      join(globalHome, "config.yaml"),
      [
        "workspace_root: ./global-workspace",
        "max_read_bytes: 4096",
        "require_review:",
        "  - create_file",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, ".cyrene", "config.yaml"),
      [
        "workspace_root: ./project-workspace",
        "require_review:",
        "  - run_command",
      ].join("\n"),
      "utf8"
    );
    await mkdir(join(root, "project-workspace"), { recursive: true });

    const config = await loadFilesystemRuleConfig(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    expect(config.workspaceRoot).toBe(join(root, "project-workspace"));
    expect(config.maxReadBytes).toBe(4096);
    expect(config.requireReview).toEqual(["run_command"]);
  });

  test("loadFilesystemRuleConfig default review list keeps dangerous ops but skips normal file writes", async () => {
    const root = await createWorkspace("");

    const config = await loadFilesystemRuleConfig(root);
    const defaultPresetIds = listLspPresets().map(preset => preset.id).sort();

    expect(config.workspaceRoot).toBe(root);
    expect(config.requireReview).not.toContain("create_file");
    expect(config.requireReview).not.toContain("write_file");
    expect(config.requireReview).not.toContain("edit_file");
    expect(config.requireReview).not.toContain("apply_patch");
    expect(config.requireReview).toContain("delete_file");
    expect(config.requireReview).toContain("run_command");
    expect(config.requireReview).toContain("write_shell");
    expect(config.requireReview).not.toContain("open_shell");
    expect((config.lspServers ?? []).map(server => server.id).sort()).toEqual(
      defaultPresetIds
    );
  });

  test("config loaders prefer the ambient workspace over an unrelated configured app root", async () => {
    const root = await createWorkspace([
      "pin_max_count: 9",
      "workspace_root: .",
      "require_review:",
      "  - run_command",
    ].join("\n"));
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "cyrene-config-other-"));
    tempRoots.push(unrelatedRoot);

    configureAppRootFromArgs({
      cwd: unrelatedRoot,
      argv: ["--root", "."],
      env: {},
    });

    const cyreneConfig = await loadCyreneConfig(undefined, {
      cwd: root,
      env: {},
    });
    const ruleConfig = await loadFilesystemRuleConfig(undefined, {
      cwd: root,
      env: {},
    });

    expect(cyreneConfig.pinMaxCount).toBe(9);
    expect(ruleConfig.workspaceRoot).toBe(root);
    expect(ruleConfig.requireReview).toEqual(["run_command"]);
  });

  test("loaders honor CYRENE_ROOT for global project root override", async () => {
    const root = await createWorkspace([
      "workspace_root: ./workspace",
      "pin_max_count: 11",
      "query_max_tool_steps: 42",
      "require_review:",
      "  - run_shell",
    ].join("\n"));

    await mkdir(join(root, "workspace"), { recursive: true });

    const cyreneConfig = await loadCyreneConfig(undefined, {
      cwd: join(root, "workspace"),
      env: { CYRENE_ROOT: root },
    });
    const ruleConfig = await loadFilesystemRuleConfig(undefined, {
      cwd: join(root, "workspace"),
      env: { CYRENE_ROOT: root },
    });

    expect(cyreneConfig.pinMaxCount).toBe(11);
    expect(cyreneConfig.queryMaxToolSteps).toBe(42);
    expect(cyreneConfig.autoSummaryRefresh).toBe(true);
    expect(ruleConfig.workspaceRoot).toBe(join(root, "workspace"));
    expect(ruleConfig.requireReview).toEqual(["run_shell"]);
  });

  test("loadMcpConfig merges global and project mcp.yaml files and preserves filesystem fallback", async () => {
    const root = await createWorkspace("");
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await writeFile(
      join(globalHome, "mcp.yaml"),
      [
        "primary_server: docs",
        "servers:",
        "  - id: docs",
        "    transport: stdio",
        '    label: "Docs Search"',
        "    cwd: ./tools/docs",
        "    env:",
        "      DOCS_API_KEY: local-docs-key",
        "    aliases:",
        "      - knowledge",
        "    tools:",
        "      - name: search_docs",
        "        capabilities: [read, search]",
        "        risk: low",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "primary_server: filesystem",
        "servers:",
        "  - id: repo",
        "    transport: filesystem",
        '    label: "Repo Files"',
        "    aliases:",
        "      - repofs",
        "    workspace_root: ./packages/app",
        "    max_read_bytes: 8192",
        "    require_review: [write_file, run_command]",
        "    lsp_servers:",
        "      - id: rust",
        "        command: rust-analyzer",
        "        file_patterns: [\"**/*.rs\"]",
        "        root_markers: [Cargo.toml, .git]",
        "        env:",
        "          RUST_LOG: info",
      ].join("\n"),
      "utf8"
    );

    const config = await loadMcpConfig(undefined, {
      cwd: root,
      env: {
        CYRENE_HOME: globalHome,
      },
    });

    expect(config.primaryServerId).toBe("filesystem");
    expect(config.configPaths).toEqual([
      join(globalHome, "mcp.yaml"),
      join(root, ".cyrene", "mcp.yaml"),
    ]);
    expect(config.servers.map(server => server.id)).toEqual(
      expect.arrayContaining(["filesystem", "docs", "repo"])
    );
    expect(config.servers.find(server => server.id === "docs")).toEqual(
      expect.objectContaining({
        transport: "stdio",
        cwd: "./tools/docs",
        aliases: ["knowledge"],
        env: {
          DOCS_API_KEY: "local-docs-key",
        },
      })
    );
    expect(config.servers.find(server => server.id === "repo")).toEqual(
      expect.objectContaining({
        transport: "filesystem",
        aliases: ["repofs"],
        workspaceRoot: join(root, "packages", "app"),
        maxReadBytes: 8192,
        requireReview: ["write_file", "run_command"],
        lspServers: [
          {
            id: "rust",
            command: "rust-analyzer",
            args: [],
            filePatterns: ["**/*.rs"],
            rootMarkers: ["Cargo.toml", ".git"],
            env: {
              RUST_LOG: "info",
            },
          },
        ],
      })
    );
    expect(
      config.servers
        .find(server => server.id === "filesystem")
        ?.aliases.includes("file")
    ).toBe(true);
  });

  test("loadMcpConfig honors project remove_servers overrides and saveProjectMcpConfig persists them", async () => {
    const root = await createWorkspace("");
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await writeFile(
      join(globalHome, "mcp.yaml"),
      [
        "servers:",
        "  - id: docs",
        "    transport: http",
        '    url: "http://127.0.0.1:9000/mcp"',
        "    headers:",
        "      Authorization: Bearer demo-token",
      ].join("\n"),
      "utf8"
    );
    await saveProjectMcpConfig(
      root,
      {
        removeServerIds: ["docs"],
        servers: [],
      },
      {
        cwd: root,
        env: { CYRENE_HOME: globalHome },
      }
    );

    const config = await loadMcpConfig(undefined, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    expect(config.servers.some(server => server.id === "docs")).toBe(false);
    expect(config.editableConfigPath).toBe(join(root, ".cyrene", "mcp.yaml"));

    const saved = await readFile(join(root, ".cyrene", "mcp.yaml"), "utf8");
    expect(saved).toContain("remove_servers");
  });

  test("loadMcpConfig parses generic stdio env/cwd and http headers", async () => {
    const root = await createWorkspace("");
    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: time",
        "    transport: stdio",
        "    command: node",
        "    args: [scripts/time-mcp-server.mjs]",
        "    cwd: ./scripts",
        "    env:",
        "      TZ: Asia/Shanghai",
        "  - id: docs",
        "    transport: http",
        '    url: "https://example.com/mcp"',
        "    allow_private_network: true",
        "    headers:",
        "      Authorization: Bearer test-token",
      ].join("\n"),
      "utf8"
    );

    const config = await loadMcpConfig(undefined, {
      cwd: root,
      env: { CYRENE_HOME: join(root, "user-home") },
    });

    expect(config.servers.find(server => server.id === "time")).toEqual(
      expect.objectContaining({
        transport: "stdio",
        cwd: "./scripts",
        env: {
          TZ: "Asia/Shanghai",
        },
      })
    );
    expect(config.servers.find(server => server.id === "docs")).toEqual(
      expect.objectContaining({
        transport: "http",
        allowPrivateNetwork: true,
        headers: {
          Authorization: "Bearer test-token",
        },
      })
    );
  });

  test("loadMcpConfig treats explicit empty lsp_servers as clearing inherited LSP config", async () => {
    const root = await createWorkspace("");
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await writeFile(
      join(globalHome, "mcp.yaml"),
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
    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: repo",
        "    transport: filesystem",
        "    lsp_servers: []",
      ].join("\n"),
      "utf8"
    );

    const config = await loadMcpConfig(undefined, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    expect(config.servers.find(server => server.id === "repo")?.lspServers).toEqual([]);
  });
});
