import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleConfig } from "../src/core/tools/mcp/loadRuleConfig";
import { resetConfiguredAppRoot } from "../src/infra/config/appRoot";
import { loadCyreneConfig } from "../src/infra/config/loadCyreneConfig";

const originalCwd = process.cwd();
const originalRootEnv = process.env.CYRENE_ROOT;
const tempRoots: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  resetConfiguredAppRoot();
  if (originalRootEnv === undefined) {
    delete process.env.CYRENE_ROOT;
  } else {
    process.env.CYRENE_ROOT = originalRootEnv;
  }
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
  delete process.env.CYRENE_ROOT;
  process.chdir(root);
  return root;
};

describe("config loaders", () => {
  test("loadCyreneConfig reads key runtime params from config.yaml", async () => {
    await createWorkspace([
      "pin_max_count: 9",
      "query_max_tool_steps: 31",
      'system_prompt: "focus on tests"',
    ].join("\n"));

    const config = await loadCyreneConfig();

    expect(config.pinMaxCount).toBe(9);
    expect(config.queryMaxToolSteps).toBe(31);
    expect(config.systemPrompt).toBe("focus on tests");
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

    const config = await loadRuleConfig();

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

    const config = await loadRuleConfig();

    expect(config.workspaceRoot).toBe(root);
    expect(config.requireReview).toContain("write_shell");
    expect(config.requireReview).not.toContain("open_shell");
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
    process.chdir(join(root, "workspace"));
    process.env.CYRENE_ROOT = root;

    const cyreneConfig = await loadCyreneConfig();
    const ruleConfig = await loadRuleConfig();

    expect(cyreneConfig.pinMaxCount).toBe(11);
    expect(cyreneConfig.queryMaxToolSteps).toBe(42);
    expect(ruleConfig.workspaceRoot).toBe(join(root, "workspace"));
    expect(ruleConfig.requireReview).toEqual(["run_shell"]);
  });
});
