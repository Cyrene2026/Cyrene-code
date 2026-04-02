import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleConfig } from "../src/core/tools/mcp/loadRuleConfig";
import { loadCyreneConfig } from "../src/infra/config/loadCyreneConfig";

const originalCwd = process.cwd();
const tempRoots: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
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
});
