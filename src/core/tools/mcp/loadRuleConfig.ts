import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCyreneConfigDir, resolveAppRoot } from "../../../infra/config/appRoot";
import type { MpcAction, RuleConfig } from "./types";

const createDefaultRules = (appRoot: string): RuleConfig => ({
  workspaceRoot: appRoot,
  maxReadBytes: 120_000,
  requireReview: [
    "create_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "delete_file",
    "copy_path",
    "move_path",
    "run_command",
    "run_shell",
    "open_shell",
    "write_shell",
  ],
});

const parseScalar = (value: string) =>
  value.replace(/^["']/, "").replace(/["']$/, "").trim();

const isMpcAction = (value: string): value is MpcAction =>
  [
    "read_file",
    "read_files",
    "read_range",
    "read_json",
    "read_yaml",
    "list_dir",
    "create_dir",
    "create_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "delete_file",
    "stat_path",
    "stat_paths",
    "outline_file",
    "find_files",
    "find_symbol",
    "find_references",
    "search_text",
    "search_text_context",
    "copy_path",
    "move_path",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_blame",
    "run_command",
    "run_shell",
    "open_shell",
    "write_shell",
    "read_shell",
    "shell_status",
    "interrupt_shell",
    "close_shell",
  ].includes(value);

const readConfigFile = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

export const loadRuleConfig = async (
  appRoot = resolveAppRoot()
): Promise<RuleConfig> => {
  const defaultRules = createDefaultRules(appRoot);
  const configDir = getCyreneConfigDir(appRoot);
  const configPath = join(configDir, "config.yaml");
  const rulePath = join(configDir, "rule.yaml");
  const content = (await readConfigFile(configPath)) || (await readConfigFile(rulePath));
  if (!content) {
    return defaultRules;
  }

  let workspaceRoot = defaultRules.workspaceRoot;
  let maxReadBytes = defaultRules.maxReadBytes;
  const requireReview: MpcAction[] = [];
  let inRequireReview = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("workspace_root:")) {
      const rawPath = parseScalar(line.slice("workspace_root:".length));
      workspaceRoot = resolve(appRoot, rawPath || ".");
      inRequireReview = false;
      continue;
    }

    if (line.startsWith("max_read_bytes:")) {
      const rawCount = parseScalar(line.slice("max_read_bytes:".length));
      const parsed = Number(rawCount);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxReadBytes = Math.floor(parsed);
      }
      inRequireReview = false;
      continue;
    }

    if (line === "require_review:") {
      inRequireReview = true;
      continue;
    }

    if (inRequireReview && line.startsWith("-")) {
      const action = parseScalar(line.slice(1));
      if (isMpcAction(action)) {
        requireReview.push(action);
      }
      continue;
    }

    inRequireReview = false;
  }

  return {
    workspaceRoot,
    maxReadBytes,
    requireReview:
      (requireReview.length > 0
        ? Array.from(new Set(requireReview))
        : defaultRules.requireReview
      ).filter(action => action !== "create_dir"),
  };
};
