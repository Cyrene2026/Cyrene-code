import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CyreneConfig = {
  pinMaxCount: number;
  queryMaxToolSteps: number;
  systemPrompt?: string;
};

const DEFAULT_CONFIG: CyreneConfig = {
  pinMaxCount: 6,
  queryMaxToolSteps: 24,
};

const parseValue = (raw: string): string | number => {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const quoted = trimmed.match(/^"(.*)"$/) ?? trimmed.match(/^'(.*)'$/);
  if (quoted) {
    return quoted[1] ?? "";
  }
  return trimmed;
};

export const loadCyreneConfig = async (): Promise<CyreneConfig> => {
  const path = join(process.cwd(), ".cyrene", "config.yaml");
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }

  const map = new Map<string, string | number>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    map.set(key, parseValue(value));
  }

  const pinRaw = map.get("pin_max_count");
  const pinMaxCount =
    typeof pinRaw === "number" && pinRaw > 0 ? Math.floor(pinRaw) : 6;

  const queryMaxToolStepsRaw = map.get("query_max_tool_steps");
  const queryMaxToolSteps =
    typeof queryMaxToolStepsRaw === "number" && queryMaxToolStepsRaw > 0
      ? Math.floor(queryMaxToolStepsRaw)
      : DEFAULT_CONFIG.queryMaxToolSteps;

  const systemRaw = map.get("system_prompt");
  const systemPrompt =
    typeof systemRaw === "string" && systemRaw.trim()
      ? systemRaw.trim()
      : undefined;

  return {
    pinMaxCount,
    queryMaxToolSteps,
    systemPrompt,
  };
};
