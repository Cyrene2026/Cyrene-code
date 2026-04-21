import type {
  FileReadLedgerEntry,
  UncertaintyState,
} from "./ExecutionSnapshot";
import {
  BROAD_DISCOVERY_ACTIONS,
  PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS,
  PROJECT_ANALYSIS_HIGH_SIGNAL_ACTIONS,
  SEMANTIC_NAVIGATION_ACTIONS,
  getToolAction,
  getToolPath,
  normalizeComparedPath,
  pickBoolean,
  pickFiniteNumber,
  pickStringArray,
  pickTrimmedString,
  toRecord,
} from "./ExecutionSupport";

export const isExploratoryProbe = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "list_dir";

export const isReadFileAction = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "read_file";

export const isCommandLikeAction = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return (
    action === "run_command" ||
    action === "run_shell" ||
    action === "open_shell" ||
    action === "write_shell"
  );
};

export const isScopeBudgetedBroadDiscoveryAction = (
  toolName: string,
  input: unknown
) =>
  BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input)) ||
  PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input));

export const getBroadDiscoveryScope = (toolName: string, input: unknown) => {
  if (!isScopeBudgetedBroadDiscoveryAction(toolName, input)) {
    return null;
  }
  return normalizeComparedPath(getToolPath(input) ?? ".") || ".";
};

export const getScopedBroadDiscoveryBudgetKey = (
  toolName: string,
  input: unknown,
  filesystemMutationRevision: number
) => {
  const scope = getBroadDiscoveryScope(toolName, input);
  return scope ? `${filesystemMutationRevision}:${scope}` : null;
};

export const shouldTrackRoundForNoProgress = (
  uncertainty: UncertaintyState,
  toolName: string,
  input: unknown
) => {
  if (uncertainty.mode === "project_analysis") {
    return (
      PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input)) ||
      PROJECT_ANALYSIS_HIGH_SIGNAL_ACTIONS.has(getToolAction(toolName, input)) ||
      SEMANTIC_NAVIGATION_ACTIONS.has(getToolAction(toolName, input))
    );
  }

  return isScopeBudgetedBroadDiscoveryAction(toolName, input);
};

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort();
    return `{${keys
      .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const truncatePreview = (value: string, maxLength = 88) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const formatQuotedPreview = (value: string, maxLength = 40) =>
  JSON.stringify(truncatePreview(value, maxLength));

export const buildToolStatusMessage = (toolName: string, input: unknown) => {
  const displayName = getLoopDisplayName(toolName, input);
  const record = toRecord(input);
  if (!record) {
    return `Running ${displayName}...`;
  }

  const action = getToolAction(toolName, input);
  const path = getToolPath(input);
  let detail: string | undefined;
  if (action === "search_text" || action === "search_text_context") {
    const query = pickTrimmedString(record, "query");
    detail = query ? `query ${formatQuotedPreview(query)}` : undefined;
  } else if (action === "find_files") {
    const pattern = pickTrimmedString(record, "pattern");
    detail = pattern ? `pattern ${formatQuotedPreview(pattern)}` : undefined;
  } else if (action === "find_symbol" || action === "find_references") {
    const symbol =
      pickTrimmedString(record, "symbol") ?? pickTrimmedString(record, "query");
    detail = symbol ? `symbol ${formatQuotedPreview(symbol)}` : undefined;
  } else if (action === "lsp_workspace_symbols") {
    const query = pickTrimmedString(record, "query");
    detail = query ? `query ${formatQuotedPreview(query)}` : undefined;
  } else if (
    action === "ts_hover" ||
    action === "ts_definition" ||
    action === "ts_references" ||
    action === "lsp_hover" ||
    action === "lsp_definition" ||
    action === "lsp_implementation" ||
    action === "lsp_type_definition" ||
    action === "lsp_references"
  ) {
    const line = pickFiniteNumber(record, "line");
    const column = pickFiniteNumber(record, "column");
    detail =
      typeof line === "number" && typeof column === "number"
        ? `at ${line}:${column}`
        : undefined;
  } else if (
    action === "ts_prepare_rename" ||
    action === "lsp_prepare_rename" ||
    action === "lsp_rename"
  ) {
    const line = pickFiniteNumber(record, "line");
    const column = pickFiniteNumber(record, "column");
    const newName = pickTrimmedString(record, "newName");
    detail = [
      newName ? `to ${formatQuotedPreview(newName)}` : undefined,
      typeof line === "number" && typeof column === "number"
        ? `at ${line}:${column}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  } else if (action === "lsp_code_actions") {
    const line = pickFiniteNumber(record, "line");
    const column = pickFiniteNumber(record, "column");
    const title = pickTrimmedString(record, "title");
    const kind = pickTrimmedString(record, "kind");
    detail = [
      title ? `title ${formatQuotedPreview(title)}` : "list",
      kind ? `kind ${formatQuotedPreview(kind)}` : undefined,
      typeof line === "number" && typeof column === "number"
        ? `at ${line}:${column}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  } else if (action === "lsp_format_document") {
    const tabSize = pickFiniteNumber(record, "tabSize");
    const insertSpaces = pickBoolean(record, "insertSpaces");
    detail = [
      typeof tabSize === "number" ? `tabSize ${tabSize}` : undefined,
      typeof insertSpaces === "boolean" ? `insertSpaces ${insertSpaces}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  } else if (action === "git_show") {
    const revision = pickTrimmedString(record, "revision");
    detail = revision ? `revision ${revision}` : undefined;
  } else if (action === "copy_path" || action === "move_path") {
    const destination = pickTrimmedString(record, "destination");
    detail = destination ? `to ${destination}` : undefined;
  }

  const summary = truncatePreview(
    [displayName, path && path !== "." ? path : path === "." ? "workspace" : undefined, detail]
      .filter(Boolean)
      .join(" | ")
  );
  return `Running ${summary || displayName}...`;
};

export const getNormalizedLoopInput = (
  toolName: string,
  input: unknown
): unknown => {
  const record = toRecord(input);
  if (!record) {
    return input ?? null;
  }

  if (toolName !== "file") {
    return record;
  }

  const action = getToolAction(toolName, input);
  const path = pickTrimmedString(record, "path");

  switch (action) {
    case "read_file":
    case "list_dir":
    case "create_dir":
    case "create_file":
    case "write_file":
    case "delete_file":
    case "stat_path":
    case "outline_file":
    case "git_status":
    case "git_diff":
      return { action, path };
    case "read_files":
    case "stat_paths":
      return { action, path, paths: pickStringArray(record, "paths") ?? [] };
    case "read_range":
      return {
        action,
        path,
        startLine: pickFiniteNumber(record, "startLine"),
        endLine: pickFiniteNumber(record, "endLine"),
      };
    case "read_json":
      return { action, path, jsonPath: pickTrimmedString(record, "jsonPath") };
    case "read_yaml":
      return { action, path, yamlPath: pickTrimmedString(record, "yamlPath") };
    case "edit_file":
    case "apply_patch":
      return {
        action,
        path,
        find: typeof record.find === "string" ? record.find : undefined,
        replace: typeof record.replace === "string" ? record.replace : undefined,
      };
    case "find_files":
      return {
        action,
        path: path ?? ".",
        pattern: pickTrimmedString(record, "pattern"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        caseSensitive: pickBoolean(record, "caseSensitive"),
      };
    case "find_symbol":
    case "find_references":
      return {
        action,
        path: path ?? ".",
        symbol: pickTrimmedString(record, "symbol") ?? pickTrimmedString(record, "query"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        caseSensitive: pickBoolean(record, "caseSensitive"),
      };
    case "search_text":
      return {
        action,
        path: path ?? ".",
        query: pickTrimmedString(record, "query"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        caseSensitive: pickBoolean(record, "caseSensitive"),
      };
    case "search_text_context":
      return {
        action,
        path: path ?? ".",
        query: pickTrimmedString(record, "query"),
        before: pickFiniteNumber(record, "before"),
        after: pickFiniteNumber(record, "after"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        caseSensitive: pickBoolean(record, "caseSensitive"),
      };
    case "git_log":
      return { action, path: path ?? ".", maxResults: pickFiniteNumber(record, "maxResults") };
    case "git_show":
      return { action, path: path ?? ".", revision: pickTrimmedString(record, "revision") };
    case "git_blame":
      return {
        action,
        path,
        startLine: pickFiniteNumber(record, "startLine"),
        endLine: pickFiniteNumber(record, "endLine"),
      };
    case "ts_hover":
    case "ts_definition":
    case "lsp_hover":
    case "lsp_definition":
    case "lsp_implementation":
    case "lsp_type_definition":
      return {
        action,
        path,
        line: pickFiniteNumber(record, "line"),
        column: pickFiniteNumber(record, "column"),
        serverId: pickTrimmedString(record, "serverId"),
      };
    case "ts_references":
    case "lsp_references":
      return {
        action,
        path,
        line: pickFiniteNumber(record, "line"),
        column: pickFiniteNumber(record, "column"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        serverId: pickTrimmedString(record, "serverId"),
      };
    case "lsp_workspace_symbols":
      return {
        action,
        path: path ?? ".",
        query: pickTrimmedString(record, "query"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        serverId: pickTrimmedString(record, "serverId"),
      };
    case "ts_diagnostics":
    case "lsp_document_symbols":
    case "lsp_diagnostics":
      return {
        action,
        path,
        maxResults: pickFiniteNumber(record, "maxResults"),
        serverId: pickTrimmedString(record, "serverId"),
      };
    case "ts_prepare_rename":
    case "lsp_prepare_rename":
    case "lsp_rename":
      return {
        action,
        path,
        line: pickFiniteNumber(record, "line"),
        column: pickFiniteNumber(record, "column"),
        newName: pickTrimmedString(record, "newName"),
        findInComments: pickBoolean(record, "findInComments"),
        findInStrings: pickBoolean(record, "findInStrings"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        serverId: pickTrimmedString(record, "serverId"),
      };
    case "lsp_code_actions":
      return {
        action,
        path,
        line: pickFiniteNumber(record, "line"),
        column: pickFiniteNumber(record, "column"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        serverId: pickTrimmedString(record, "serverId"),
        title: pickTrimmedString(record, "title"),
        kind: pickTrimmedString(record, "kind"),
      };
    case "lsp_format_document":
      return {
        action,
        path,
        maxResults: pickFiniteNumber(record, "maxResults"),
        serverId: pickTrimmedString(record, "serverId"),
        tabSize: pickFiniteNumber(record, "tabSize"),
        insertSpaces: pickBoolean(record, "insertSpaces"),
      };
    case "copy_path":
    case "move_path":
      return { action, path, destination: pickTrimmedString(record, "destination") };
    case "run_command":
      return {
        action,
        command: pickTrimmedString(record, "command"),
        args: pickStringArray(record, "args") ?? [],
        cwd: pickTrimmedString(record, "cwd"),
      };
    case "run_shell":
      return {
        action,
        path: path ?? ".",
        command: pickTrimmedString(record, "command"),
        cwd: pickTrimmedString(record, "cwd"),
      };
    case "open_shell":
      return { action, path: path ?? ".", cwd: pickTrimmedString(record, "cwd") };
    case "write_shell":
      return {
        action,
        path: path ?? ".",
        input: pickTrimmedString(record, "input") ?? pickTrimmedString(record, "text"),
      };
    case "read_shell":
    case "shell_status":
    case "interrupt_shell":
    case "close_shell":
      return { action, path: path ?? "." };
    default:
      return { action, ...record };
  }
};

export const getLoopDisplayName = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return toolName === "file" && action ? action : toolName;
};

export const getLoopSignature = (
  toolName: string,
  input: unknown,
  filesystemMutationRevision: number
) => {
  const scope =
    toolName === "file" && !isCommandLikeAction(toolName, input)
      ? `fs:${filesystemMutationRevision}`
      : "global";
  return `${toolName}:${scope}:${stableSerialize(
    getNormalizedLoopInput(toolName, input)
  )}`;
};

export const isImmediateRedundantPostWriteRead = (
  toolName: string,
  input: unknown,
  latestConfirmedFileMutation: { path: string } | null,
  allowPostWriteVerification: boolean
) => {
  if (
    !latestConfirmedFileMutation ||
    allowPostWriteVerification ||
    !isReadFileAction(toolName, input)
  ) {
    return false;
  }

  const path = getToolPath(input);
  if (!path) {
    return false;
  }

  return (
    normalizeComparedPath(path) ===
    normalizeComparedPath(latestConfirmedFileMutation.path)
  );
};
