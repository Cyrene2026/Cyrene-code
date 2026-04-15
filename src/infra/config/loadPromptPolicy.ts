import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  resolveAppRoot,
} from "./appRoot";
import type { CyreneConfig } from "./loadCyreneConfig";

export type PromptPolicy = {
  systemPrompt: string;
  projectPrompt: string;
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Cyrene CLI assistant. Be concise, accurate, and execution-focused.",
  "Act autonomously when the task is multi-step: create and maintain an execution plan instead of only narrating intent.",
  "When plan progress changes, include a machine-readable <cyrene_plan> JSON block and mark finished steps completed yourself.",
].join(" ");

export const loadPromptPolicy = async (
  config?: CyreneConfig,
  appRoot = resolveAppRoot()
): Promise<PromptPolicy> => {
  const systemPrompt =
    config?.systemPrompt?.trim() ||
    process.env.CYRENE_SYSTEM_PROMPT?.trim() ||
    DEFAULT_SYSTEM_PROMPT;

  let projectPrompt = "";
  const projectFiles = [
    join(getCyreneConfigDir(appRoot), ".cyrene.md"),
    join(getLegacyProjectCyreneDir(appRoot), ".cyrene.md"),
  ];
  for (const projectFile of projectFiles) {
    try {
      projectPrompt = (await readFile(projectFile, "utf8")).trim();
      break;
    } catch {
      // Try the next compatible location.
    }
  }

  return {
    systemPrompt,
    projectPrompt,
  };
};
