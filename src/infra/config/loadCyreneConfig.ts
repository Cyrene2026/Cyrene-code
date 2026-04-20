import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  debugCaptureAnthropicRequests: boolean;
  debugCaptureAnthropicRequestsDir?: string;
};

type CyreneConfigLoadContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export const DEFAULT_CYRENE_CONFIG: CyreneConfig = {
  pinMaxCount: DEFAULT_PIN_MAX_COUNT,
  queryMaxToolSteps: DEFAULT_QUERY_MAX_TOOL_STEPS,
  autoSummaryRefresh: true,
  requestTemperature: 0.2,
  debugCaptureAnthropicRequests: false,
};

export const DEFAULT_PROJECT_CYRENE_CONFIG_YAML = [
  "# Project-local Cyrene config",
  `pin_max_count: ${DEFAULT_CYRENE_CONFIG.pinMaxCount}`,
  `query_max_tool_steps: ${DEFAULT_CYRENE_CONFIG.queryMaxToolSteps}`,
  `auto_summary_refresh: ${DEFAULT_CYRENE_CONFIG.autoSummaryRefresh}`,
  `request_temperature: ${DEFAULT_CYRENE_CONFIG.requestTemperature}`,
  `debug_capture_anthropic_requests: ${DEFAULT_CYRENE_CONFIG.debugCaptureAnthropicRequests}`,
  "# debug_capture_anthropic_requests_dir: .cyrene/debug/anthropic-requests",
  "",
].join("\n");

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

const readOptionalFile = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

const parseCyreneConfigContent = (content: string): Partial<CyreneConfig> => {
  if (!content.trim()) {
    return {};
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

  const parsed: Partial<CyreneConfig> = {};

  const pinRaw = map.get("pin_max_count");
  if (typeof pinRaw === "number" && pinRaw > 0) {
    parsed.pinMaxCount = Math.floor(pinRaw);
  }

  const queryMaxToolStepsRaw = map.get("query_max_tool_steps");
  if (
    typeof queryMaxToolStepsRaw === "number" &&
    queryMaxToolStepsRaw > 0
  ) {
    parsed.queryMaxToolSteps = Math.floor(queryMaxToolStepsRaw);
  }

  const autoSummaryRefreshRaw = map.get("auto_summary_refresh");
  if (typeof autoSummaryRefreshRaw === "boolean") {
    parsed.autoSummaryRefresh = autoSummaryRefreshRaw;
  }

  const requestTemperatureRaw = map.get("request_temperature");
  if (
    typeof requestTemperatureRaw === "number" &&
    Number.isFinite(requestTemperatureRaw)
  ) {
    parsed.requestTemperature = Math.min(2, Math.max(0, requestTemperatureRaw));
  }

  const systemRaw = map.get("system_prompt");
  if (typeof systemRaw === "string" && systemRaw.trim()) {
    parsed.systemPrompt = systemRaw.trim();
  }

  const debugCaptureAnthropicRequestsRaw = map.get(
    "debug_capture_anthropic_requests"
  );
  if (typeof debugCaptureAnthropicRequestsRaw === "boolean") {
    parsed.debugCaptureAnthropicRequests = debugCaptureAnthropicRequestsRaw;
  }

  const debugCaptureAnthropicRequestsDirRaw = map.get(
    "debug_capture_anthropic_requests_dir"
  );
  if (
    typeof debugCaptureAnthropicRequestsDirRaw === "string" &&
    debugCaptureAnthropicRequestsDirRaw.trim()
  ) {
    parsed.debugCaptureAnthropicRequestsDir =
      debugCaptureAnthropicRequestsDirRaw.trim();
  }

  return parsed;
};

export const ensureProjectCyreneConfig = async (
  appRoot?: string,
  context?: CyreneConfigLoadContext
) => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const configPath = join(
    getLegacyProjectCyreneDir(resolvedAppRoot),
    "config.yaml"
  );

  try {
    await access(configPath);
    return {
      path: configPath,
      created: false,
    };
  } catch {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, DEFAULT_PROJECT_CYRENE_CONFIG_YAML, "utf8");
    return {
      path: configPath,
      created: true,
    };
  }
};

export const loadCyreneConfig = async (
  appRoot?: string,
  context?: CyreneConfigLoadContext
): Promise<CyreneConfig> => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const globalConfig = parseCyreneConfigContent(
    await readOptionalFile(
      join(
        getCyreneConfigDir({
          cwd: resolvedAppRoot,
          env: context?.env,
        }),
        "config.yaml"
      )
    )
  );
  const projectConfig = parseCyreneConfigContent(
    await readOptionalFile(
      join(getLegacyProjectCyreneDir(resolvedAppRoot), "config.yaml")
    )
  );

  return {
    ...DEFAULT_CYRENE_CONFIG,
    ...globalConfig,
    ...projectConfig,
  };
};
