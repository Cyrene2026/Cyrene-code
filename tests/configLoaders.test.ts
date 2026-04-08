import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFilesystemRuleConfig,
  loadMcpConfig,
  saveProjectMcpConfig,
} from "../src/core/mcp";
import {
  configureAppRootFromArgs,
  resetConfiguredAppRoot,
} from "../src/infra/config/appRoot";
import { loadCyreneConfig } from "../src/infra/config/loadCyreneConfig";
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
      'system_prompt: "focus on tests"',
    ].join("\n"));

    const config = await loadCyreneConfig(root);

    expect(config.pinMaxCount).toBe(9);
    expect(config.queryMaxToolSteps).toBe(31);
    expect(config.autoSummaryRefresh).toBe(false);
    expect(config.requestTemperature).toBe(0.15);
    expect(config.systemPrompt).toBe("focus on tests");
  });

  test("loadCyreneConfig falls back to raised default tool budget when config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-config-default-"));
    tempRoots.push(root);

    const config = await loadCyreneConfig(root);

    expect(config.queryMaxToolSteps).toBe(DEFAULT_QUERY_MAX_TOOL_STEPS);
    expect(config.autoSummaryRefresh).toBe(true);
    expect(config.requestTemperature).toBe(0.2);
  });

  test("loadCyreneConfig clamps invalid request_temperature into 0..2", async () => {
    const root = await createWorkspace("request_temperature: 9");

    const config = await loadCyreneConfig(root);

    expect(config.requestTemperature).toBe(2);
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

  test("loadFilesystemRuleConfig default review list keeps dangerous ops but skips normal file writes", async () => {
    const root = await createWorkspace("");

    const config = await loadFilesystemRuleConfig(root);

    expect(config.workspaceRoot).toBe(root);
    expect(config.requireReview).not.toContain("create_file");
    expect(config.requireReview).not.toContain("write_file");
    expect(config.requireReview).not.toContain("edit_file");
    expect(config.requireReview).not.toContain("apply_patch");
    expect(config.requireReview).toContain("delete_file");
    expect(config.requireReview).toContain("run_command");
    expect(config.requireReview).toContain("write_shell");
    expect(config.requireReview).not.toContain("open_shell");
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
        aliases: ["knowledge"],
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
