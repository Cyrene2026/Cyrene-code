import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_PIN_MAX_COUNT,
  DEFAULT_QUERY_MAX_TOOL_STEPS,
} from "../../shared/runtimeDefaults";
import {
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  resolveAmbientAppRoot,
} from "./appRoot";

export type CyreneConfig = {
  pinMaxCount: number;
  queryMaxToolSteps: number;
  autoSummaryRefresh: boolean;
  requestTemperature: number;
  systemPrompt?: string;
};

type CyreneConfigLoadContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_CONFIG: CyreneConfig = {
  pinMaxCount: DEFAULT_PIN_MAX_COUNT,
  queryMaxToolSteps: DEFAULT_QUERY_MAX_TOOL_STEPS,
  autoSummaryRefresh: true,
  requestTemperature: 0.2,
};

const parseValue = (raw: string): string | number | boolean => {
  const trimmed = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }
  const quoted = trimmed.match(/^"(.*)"$/) ?? trimmed.match(/^'(.*)'$/);
  if (quoted) {
    return quoted[1] ?? "";
  }
  return trimmed;
};

const readFirstExistingFile = async (paths: string[]) => {
  for (const path of paths) {
    try {
      return await readFile(path, "utf8");
    } catch {
      // Try the next location.
    }
  }
  return "";
};

export const loadCyreneConfig = async (
  appRoot?: string,
  context?: CyreneConfigLoadContext
): Promise<CyreneConfig> => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const content = await readFirstExistingFile([
    join(
      getCyreneConfigDir({
        cwd: resolvedAppRoot,
        env: context?.env,
      }),
      "config.yaml"
    ),
    join(getLegacyProjectCyreneDir(resolvedAppRoot), "config.yaml"),
  ]);
  if (!content) {
    return DEFAULT_CONFIG;
  }

  const map = new Map<string, string | number | boolean>();
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
    typeof pinRaw === "number" && pinRaw > 0
      ? Math.floor(pinRaw)
      : DEFAULT_PIN_MAX_COUNT;

  const queryMaxToolStepsRaw = map.get("query_max_tool_steps");
  const queryMaxToolSteps =
    typeof queryMaxToolStepsRaw === "number" && queryMaxToolStepsRaw > 0
      ? Math.floor(queryMaxToolStepsRaw)
      : DEFAULT_CONFIG.queryMaxToolSteps;

  const autoSummaryRefreshRaw = map.get("auto_summary_refresh");
  const autoSummaryRefresh =
    typeof autoSummaryRefreshRaw === "boolean"
      ? autoSummaryRefreshRaw
      : DEFAULT_CONFIG.autoSummaryRefresh;

  const requestTemperatureRaw = map.get("request_temperature");
  const requestTemperature =
    typeof requestTemperatureRaw === "number" &&
    Number.isFinite(requestTemperatureRaw)
      ? Math.min(2, Math.max(0, requestTemperatureRaw))
      : DEFAULT_CONFIG.requestTemperature;

  const systemRaw = map.get("system_prompt");
  const systemPrompt =
    typeof systemRaw === "string" && systemRaw.trim()
      ? systemRaw.trim()
      : undefined;

  return {
    pinMaxCount,
    queryMaxToolSteps,
    autoSummaryRefresh,
    requestTemperature,
    systemPrompt,
  };
};
