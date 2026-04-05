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

const DEFAULT_SYSTEM_PROMPT =
  "You are Cyrene CLI assistant. Be concise, accurate, and execution-focused.";

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
