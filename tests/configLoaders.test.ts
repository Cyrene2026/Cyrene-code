import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleConfig } from "../src/core/tools/mcp/loadRuleConfig";
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
      'system_prompt: "focus on tests"',
    ].join("\n"));

    const config = await loadCyreneConfig(root);

    expect(config.pinMaxCount).toBe(9);
    expect(config.queryMaxToolSteps).toBe(31);
    expect(config.autoSummaryRefresh).toBe(false);
    expect(config.systemPrompt).toBe("focus on tests");
  });

  test("loadCyreneConfig falls back to raised default tool budget when config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-config-default-"));
    tempRoots.push(root);

    const config = await loadCyreneConfig(root);

    expect(config.queryMaxToolSteps).toBe(DEFAULT_QUERY_MAX_TOOL_STEPS);
    expect(config.autoSummaryRefresh).toBe(true);
  });

  test("loadRuleConfig falls back to config.yaml for MCP review settings", async () => {
    const root = await createWorkspace([
      "workspace_root: .",
      "max_read_bytes: 4096",
      "require_review:",
      "  - create_file",
      "  - move_path",
      "  - run_command",
    ].join("\n"));

    const config = await loadRuleConfig(root);

    expect(config.workspaceRoot).toBe(root);
    expect(config.maxReadBytes).toBe(4096);
    expect(config.requireReview).toEqual([
      "create_file",
      "move_path",
      "run_command",
    ]);
  });

  test("loadRuleConfig default review list keeps write_shell but not open_shell", async () => {
    const root = await createWorkspace("");

    const config = await loadRuleConfig(root);

    expect(config.workspaceRoot).toBe(root);
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
    const ruleConfig = await loadRuleConfig(undefined, {
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
    const ruleConfig = await loadRuleConfig(undefined, {
      cwd: join(root, "workspace"),
      env: { CYRENE_ROOT: root },
    });

    expect(cyreneConfig.pinMaxCount).toBe(11);
    expect(cyreneConfig.queryMaxToolSteps).toBe(42);
    expect(cyreneConfig.autoSummaryRefresh).toBe(true);
    expect(ruleConfig.workspaceRoot).toBe(join(root, "workspace"));
    expect(ruleConfig.requireReview).toEqual(["run_shell"]);
  });
});
