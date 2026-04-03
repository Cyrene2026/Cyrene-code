import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MpcAction, RuleConfig } from "./types";

const DEFAULT_RULES: RuleConfig = {
  workspaceRoot: process.cwd(),
  maxReadBytes: 120_000,
  requireReview: [
    "create_file",
    "write_file",
    "edit_file",
    "delete_file",
    "copy_path",
    "move_path",
    "run_command",
    "run_shell",
  ],
};

const parseScalar = (value: string) =>
  value.replace(/^["']/, "").replace(/["']$/, "").trim();

const isMpcAction = (value: string): value is MpcAction =>
  [
    "read_file",
    "list_dir",
    "create_dir",
    "create_file",
    "write_file",
    "edit_file",
    "delete_file",
    "stat_path",
    "find_files",
    "search_text",
    "copy_path",
    "move_path",
    "run_command",
    "run_shell",
  ].includes(value);

const readConfigFile = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

export const loadRuleConfig = async (): Promise<RuleConfig> => {
  const configPath = join(process.cwd(), ".cyrene", "config.yaml");
  const rulePath = join(process.cwd(), ".cyrene", "rule.yaml");
  const content = (await readConfigFile(configPath)) || (await readConfigFile(rulePath));
  if (!content) {
    return DEFAULT_RULES;
  }

  let workspaceRoot = DEFAULT_RULES.workspaceRoot;
  let maxReadBytes = DEFAULT_RULES.maxReadBytes;
  const requireReview: MpcAction[] = [];
  let inRequireReview = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("workspace_root:")) {
      const rawPath = parseScalar(line.slice("workspace_root:".length));
      workspaceRoot = resolve(process.cwd(), rawPath || ".");
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
        : DEFAULT_RULES.requireReview
      ).filter(action => action !== "create_dir"),
  };
};
