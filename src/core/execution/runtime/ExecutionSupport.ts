const FILE_PATH_PATTERN =
  /(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+/g;

export const BROAD_DISCOVERY_ACTIONS = new Set([
  "list_dir",
  "find_files",
  "search_text",
  "search_text_context",
  "outline_file",
  "find_symbol",
  "find_references",
  "stat_path",
  "stat_paths",
]);

export const PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS = new Set([
  "list_dir",
  "find_files",
  "search_text",
  "stat_path",
  "stat_paths",
  "git_status",
  "git_diff",
]);

export const TARGETED_SOURCE_READ_ACTIONS = new Set([
  "read_file",
  "read_range",
  "read_json",
  "read_yaml",
]);

export const PROJECT_ANALYSIS_HIGH_SIGNAL_ACTIONS = new Set([
  "read_file",
  "read_range",
  "read_json",
  "read_yaml",
  "outline_file",
  "search_text_context",
  "find_symbol",
  "find_references",
  "git_show",
  "git_log",
  "git_blame",
  "ts_hover",
  "ts_definition",
  "ts_references",
  "ts_diagnostics",
  "ts_prepare_rename",
  "lsp_hover",
  "lsp_definition",
  "lsp_implementation",
  "lsp_type_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_diagnostics",
  "lsp_code_actions",
]);

export const HIGH_VALUE_EVIDENCE_ACTIONS = new Set([
  ...TARGETED_SOURCE_READ_ACTIONS,
  ...PROJECT_ANALYSIS_HIGH_SIGNAL_ACTIONS,
  "ts_hover",
  "ts_definition",
  "ts_references",
  "lsp_hover",
  "lsp_definition",
  "lsp_implementation",
  "lsp_type_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_diagnostics",
  "lsp_code_actions",
]);

export const SEMANTIC_NAVIGATION_ACTIONS = new Set([
  "ts_hover",
  "ts_definition",
  "ts_references",
  "lsp_hover",
  "lsp_definition",
  "lsp_implementation",
  "lsp_type_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
]);

const TYPESCRIPT_LIKE_PATH_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

export const getToolAction = (toolName: string, input: unknown) => {
  if (
    input &&
    typeof input === "object" &&
    "action" in (input as Record<string, unknown>) &&
    typeof (input as Record<string, unknown>).action === "string"
  ) {
    return String((input as Record<string, unknown>).action);
  }
  return toolName;
};

export const getToolPath = (input: unknown) => {
  if (
    input &&
    typeof input === "object" &&
    "path" in (input as Record<string, unknown>) &&
    typeof (input as Record<string, unknown>).path === "string"
  ) {
    return String((input as Record<string, unknown>).path).trim() || undefined;
  }
  return undefined;
};

export const toRecord = (input: unknown): Record<string, unknown> | null =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;

export const pickTrimmedString = (
  record: Record<string, unknown>,
  key: string
) => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const pickStringArray = (
  record: Record<string, unknown>,
  key: string
) => {
  const value = record[key];
  return Array.isArray(value) && value.every(item => typeof item === "string")
    ? value
    : undefined;
};

export const pickFiniteNumber = (
  record: Record<string, unknown>,
  key: string
) => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const pickBoolean = (
  record: Record<string, unknown>,
  key: string
) => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

export const normalizeComparedPath = (path: string) =>
  path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");

export const normalizeUniquePaths = (paths: string[]) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    const candidate = normalizeComparedPath(path);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
};

export const extractPathsFromText = (text: string) =>
  normalizeUniquePaths(text.match(FILE_PATH_PATTERN) ?? []);

export const isTypeScriptLikePath = (path: string) =>
  TYPESCRIPT_LIKE_PATH_PATTERN.test(path);

export const isLspConfigUnavailableMessage = (message: string) =>
  /(no configured LSP server matches|no lsp_servers are configured)/i.test(
    message
  );
