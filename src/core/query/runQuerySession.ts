import { parseStreamChunk } from "./streamProtocol";
import {
  createQuerySessionState,
  querySessionReducer,
  type QuerySessionDispatch,
  type QuerySessionState,
} from "./sessionMachine";
import { DEFAULT_QUERY_MAX_TOOL_STEPS } from "../../shared/runtimeDefaults";
import type { QueryTransport } from "./transport";
import type { TokenUsage } from "./tokenUsage";

type RunQuerySessionParams = {
  query: string;
  originalTask?: string;
  queryMaxToolSteps?: number;
  transport: QueryTransport;
  onState: (state: QuerySessionState) => void;
  onTextDelta: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onToolStatus?: (message: string) => void;
  onToolCall: (
    toolName: string,
    input: unknown
  ) =>
    | Promise<{ message: string; reviewMode?: "queue" | "block" }>
    | { message: string; reviewMode?: "queue" | "block" };
  onError: (message: string) => void;
};

export type RunQuerySessionResult =
  | { status: "completed" }
  | {
      status: "suspended";
      resume: (toolResultMessage: string) => Promise<RunQuerySessionResult>;
    };

const COMPLETED_RESULT: RunQuerySessionResult = { status: "completed" };
const SILENT_REVIEW_RESUME_RECOVERY_NOTE = [
  "The approved tool result above was applied successfully.",
  "The previous continuation ended without any assistant output or further tool action.",
  "Continue the same task now.",
  "Either take the next concrete step or provide the final answer explicitly; do not end silently.",
].join("\n");

type ConfirmedFileMutation = {
  action: "create_file" | "write_file" | "edit_file" | "apply_patch";
  path: string;
};

type MultiFileProgressLedger = {
  expectedFileCount?: number;
  targetPaths: string[];
  completedPaths: string[];
  lastCompletedPath?: string;
};

type RunRoundsOptions = {
  allowSilentPostReviewRetry?: boolean;
};

type UncertaintyMode = "normal" | "simple_multi_file";

type UncertaintyPhase =
  | "discover"
  | "collapse"
  | "execute"
  | "verify"
  | "blocked";

type UncertaintyState = {
  mode: UncertaintyMode;
  phase: UncertaintyPhase;
  discoverBudgetUsed: number;
  discoverBudgetMax: number;
  nonProgressAutoContinueUsed: boolean;
  explicitSourceReads: Set<string>;
  explicitTaskPaths: Set<string>;
  verifyRequested: boolean;
  blockedReason: string | null;
};

const LATE_TOOL_CALL_VISIBLE_ANSWER_CHAR_GUARD = 200;
const MAX_NON_PROGRESS_CHATTER_CHARS = 240;
const ROUND_PROMPT_TASK_CHAR_LIMIT = 12000;
const ROUND_PROMPT_TOOL_RESULT_CHAR_LIMIT = 16000;
const ROUND_PROMPT_TOOL_RESULT_ITEM_CHAR_LIMIT = 3000;
const ROUND_PROMPT_TOOL_RESULT_KEEP_LIMIT = 8;

const BROAD_DISCOVERY_ACTIONS = new Set([
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

const TARGETED_SOURCE_READ_ACTIONS = new Set([
  "read_file",
  "read_range",
  "read_json",
  "read_yaml",
]);

const SIMPLE_MULTI_FILE_TASK_PATTERN =
  /(split|modulari(?:s|z)e|module|reorganize|classify|migrate|move.+into|refactor.+files|拆分|模块化|分类|迁移|整理|拆到|拆成|拆出去)/i;

const NON_PROGRESS_CHATTER_PATTERN =
  /(继续拆分|继续补齐|我来继续|再看一下|继续完善|继续处理|继续剩余|继续模块化|i(?:'| wi)ll continue|let me continue|continue splitting|continue with the remaining|keep going with the remaining)/i;

const getToolAction = (toolName: string, input: unknown) => {
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

const getToolPath = (input: unknown) => {
  if (
    input &&
    typeof input === "object" &&
    "path" in (input as Record<string, unknown>) &&
    typeof (input as Record<string, unknown>).path === "string"
  ) {
    return String((input as Record<string, unknown>).path);
  }
  return undefined;
};

const toRecord = (input: unknown): Record<string, unknown> | null =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : null;

const pickTrimmedString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const pickStringArray = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return Array.isArray(value) && value.every(item => typeof item === "string")
    ? (value as string[])
    : undefined;
};

const pickFiniteNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const pickBoolean = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

const MUTATING_FILE_ACTIONS = new Set([
  "create_dir",
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "copy_path",
  "move_path",
]);

const CONTENT_MUTATING_FILE_ACTIONS = new Set([
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
]);

const MUTATION_RESULT_MARKERS = [
  "Created file:",
  "Created directory:",
  "Wrote file:",
  "Edited file:",
  "Patched file:",
  "Deleted file:",
  "Copied path:",
  "Moved path:",
];

const isExploratoryProbe = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "list_dir";

const isReadFileAction = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "read_file";

const isCommandLikeAction = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return (
    action === "run_command" ||
    action === "run_shell" ||
    action === "open_shell" ||
    action === "write_shell"
  );
};

const clipRoundPromptText = (text: string, maxChars: number) => {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const marker = "\n...[truncated for round prompt budget]...\n";
  const headLength = Math.max(0, Math.floor((maxChars - marker.length) * 0.7));
  const tailLength = Math.max(0, maxChars - marker.length - headLength);
  const head = normalized.slice(0, headLength).trimEnd();
  const tail = normalized.slice(-tailLength).trimStart();
  return `${head}${marker}${tail}`;
};

const formatToolResultsForRoundPrompt = (toolResults: string[]) => {
  const normalizedResults = toolResults
    .map(result => result.trim())
    .filter(Boolean);

  if (normalizedResults.length === 0) {
    return "(none)";
  }

  const selected: string[] = [];
  let remainingBudget = ROUND_PROMPT_TOOL_RESULT_CHAR_LIMIT;

  for (let index = normalizedResults.length - 1; index >= 0; index -= 1) {
    if (selected.length >= ROUND_PROMPT_TOOL_RESULT_KEEP_LIMIT || remainingBudget <= 0) {
      break;
    }

    const nextResult = clipRoundPromptText(
      normalizedResults[index] ?? "",
      Math.min(ROUND_PROMPT_TOOL_RESULT_ITEM_CHAR_LIMIT, remainingBudget)
    );
    if (!nextResult) {
      continue;
    }

    selected.unshift(nextResult);
    remainingBudget -= nextResult.length + 2;
  }

  const omittedCount = normalizedResults.length - selected.length;
  const parts =
    omittedCount > 0
      ? [
          `[tool results truncated] omitted ${omittedCount} older result(s) to stay within the prompt budget.`,
          ...selected,
        ]
      : selected;

  return parts.join("\n\n");
};

const isFilesystemBoundFileAction = (toolName: string, input: unknown) =>
  toolName === "file" && !isCommandLikeAction(toolName, input);

const isMutatingFileAction = (toolName: string, input: unknown) =>
  MUTATING_FILE_ACTIONS.has(getToolAction(toolName, input));

const isContentMutatingFileAction = (toolName: string, input: unknown) =>
  CONTENT_MUTATING_FILE_ACTIONS.has(getToolAction(toolName, input));

const didApplyFileMutation = (
  toolName: string,
  input: unknown,
  message: string
) =>
  isMutatingFileAction(toolName, input) &&
  MUTATION_RESULT_MARKERS.some(marker => message.includes(marker));

const normalizeComparedPath = (path: string) =>
  path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");

const FILE_PATH_PATTERN =
  /(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+/g;

const ENGLISH_FILE_COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const normalizeUniquePaths = (paths: string[]) => {
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

const parseChineseNumber = (token: string) => {
  const normalized = token.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "十") {
    return 10;
  }
  if (normalized.includes("十")) {
    const [left, right] = normalized.split("十");
    const tens = left ? (CHINESE_DIGITS[left] ?? 0) : 1;
    const ones = right ? (CHINESE_DIGITS[right] ?? 0) : 0;
    const value = tens * 10 + ones;
    return value > 0 ? value : undefined;
  }
  if (normalized.length === 1) {
    const digit = CHINESE_DIGITS[normalized];
    return typeof digit === "number" ? digit : undefined;
  }
  return undefined;
};

const parseLooseFileCount = (token: string) => {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  if (normalized in ENGLISH_FILE_COUNT_WORDS) {
    return ENGLISH_FILE_COUNT_WORDS[normalized];
  }
  return parseChineseNumber(token);
};

const extractPathsFromText = (text: string) =>
  normalizeUniquePaths(text.match(FILE_PATH_PATTERN) ?? []);

const extractExplicitTaskPaths = (task: string) =>
  extractPathsFromText(task);

const extractExpectedFileCount = (task: string, explicitPaths: string[]) => {
  const patterns = [
    /(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:new\s+|additional\s+)?(?:[a-z]+\s+)?files?\b/i,
    /(\d+|[零〇一二两三四五六七八九十]+)\s*个?\s*(?:[a-z]+\s*)?(?:文件|脚本|组件|模块)/i,
  ];
  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = parseLooseFileCount(match[1]);
    if (typeof parsed === "number" && parsed > 0) {
      return Math.max(parsed, explicitPaths.length);
    }
  }
  return explicitPaths.length > 1 ? explicitPaths.length : undefined;
};

const createInitialMultiFileProgressLedger = (
  task: string
): MultiFileProgressLedger => {
  const explicitPaths = extractExplicitTaskPaths(task);
  const targetPaths =
    explicitPaths.length === 1 && SIMPLE_MULTI_FILE_TASK_PATTERN.test(task)
      ? []
      : explicitPaths;
  return {
    expectedFileCount: extractExpectedFileCount(task, targetPaths),
    targetPaths,
    completedPaths: [],
  };
};

const getLedgerExpectedFileCount = (ledger: MultiFileProgressLedger) =>
  Math.max(ledger.expectedFileCount ?? 0, ledger.targetPaths.length);

const getLedgerRemainingPaths = (ledger: MultiFileProgressLedger) => {
  const completed = new Set(ledger.completedPaths.map(normalizeComparedPath));
  return ledger.targetPaths.filter(path => !completed.has(normalizeComparedPath(path)));
};

const getLedgerRemainingCount = (ledger: MultiFileProgressLedger) => {
  const expected = getLedgerExpectedFileCount(ledger);
  if (expected > 0) {
    return Math.max(0, expected - ledger.completedPaths.length);
  }
  return getLedgerRemainingPaths(ledger).length;
};

const isMeaningfulMultiFileLedger = (ledger: MultiFileProgressLedger) => {
  const expected = getLedgerExpectedFileCount(ledger);
  return (
    expected > 1 ||
    ledger.targetPaths.length > 1 ||
    ledger.completedPaths.length > 1
  );
};

const pushCompletedPathToLedger = (
  ledger: MultiFileProgressLedger,
  path: string
): MultiFileProgressLedger => {
  const normalizedPath = normalizeComparedPath(path);
  if (!normalizedPath) {
    return ledger;
  }
  const completedPaths = normalizeUniquePaths([
    ...ledger.completedPaths,
    normalizedPath,
  ]);
  const expected = getLedgerExpectedFileCount(ledger);
  return {
    ...ledger,
    expectedFileCount:
      expected > 0 ? Math.max(expected, completedPaths.length) : undefined,
    completedPaths,
    lastCompletedPath: normalizedPath,
  };
};

const formatPathList = (paths: string[], maxItems = 5) => {
  if (paths.length === 0) {
    return "(none)";
  }
  const visible = paths.slice(0, maxItems).join(", ");
  const hidden = paths.length - Math.min(paths.length, maxItems);
  return hidden > 0 ? `${visible} (+${hidden} more)` : visible;
};

const formatMultiFileProgressLedger = (ledger: MultiFileProgressLedger) => {
  if (!isMeaningfulMultiFileLedger(ledger)) {
    return "";
  }

  const expected = getLedgerExpectedFileCount(ledger);
  const completedCount = ledger.completedPaths.length;
  const remainingPaths = getLedgerRemainingPaths(ledger);
  const remainingCount = getLedgerRemainingCount(ledger);
  const extraUnnamedRemaining = Math.max(0, remainingCount - remainingPaths.length);
  const lines: string[] = [];

  if (expected > 0) {
    lines.push(`expected files: ${expected}`);
  }

  if (completedCount > 0) {
    lines.push(
      expected > 0
        ? `completed (${completedCount}/${expected}): ${formatPathList(
            ledger.completedPaths
          )}`
        : `completed (${completedCount}): ${formatPathList(ledger.completedPaths)}`
    );
  } else if (expected > 0) {
    lines.push(`completed (0/${expected}): (none yet)`);
  }

  if (remainingPaths.length > 0) {
    lines.push(
      `remaining known paths (${remainingPaths.length}): ${formatPathList(
        remainingPaths
      )}`
    );
  }

  if (remainingCount > 0 && remainingPaths.length === 0) {
    lines.push(`remaining count: ${remainingCount}`);
  } else if (extraUnnamedRemaining > 0) {
    lines.push(`remaining additional file count: ${extraUnnamedRemaining}`);
  }

  if (ledger.lastCompletedPath) {
    lines.push(`last completed file: ${ledger.lastCompletedPath}`);
  }

  return lines.join("\n");
};

const getConfirmedFileMutation = (
  toolName: string,
  input: unknown,
  message: string
): ConfirmedFileMutation | null => {
  if (
    !didApplyFileMutation(toolName, input, message) ||
    !isContentMutatingFileAction(toolName, input)
  ) {
    return null;
  }

  const path = getToolPath(input);
  const action = getToolAction(toolName, input);
  if (!path || !CONTENT_MUTATING_FILE_ACTIONS.has(action)) {
    return null;
  }

  return {
    action: action as ConfirmedFileMutation["action"],
    path,
  };
};

const pushRecentConfirmedFileMutation = (
  recentMutations: ConfirmedFileMutation[],
  mutation: ConfirmedFileMutation
) => {
  const normalizedPath = normalizeComparedPath(mutation.path);
  const filtered = recentMutations.filter(
    entry => normalizeComparedPath(entry.path) !== normalizedPath
  );
  return [...filtered, mutation].slice(-4);
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
  value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;

const formatQuotedPreview = (value: string, maxLength = 40) =>
  JSON.stringify(truncatePreview(value, maxLength));

const buildToolStatusMessage = (toolName: string, input: unknown) => {
  const displayName = getLoopDisplayName(toolName, input);
  const record = toRecord(input);
  if (!record) {
    return `Running ${displayName}...`;
  }

  if (toolName !== "file") {
    return `Running ${truncatePreview(displayName)}...`;
  }

  const action = getToolAction(toolName, input);
  const path = pickTrimmedString(record, "path");
  let summary = displayName;

  if (action === "run_command") {
    const command = pickTrimmedString(record, "command");
    const args = pickStringArray(record, "args") ?? [];
    const commandPreview = [command, ...args].filter(Boolean).join(" ").trim();
    const cwd = pickTrimmedString(record, "cwd");
    summary = truncatePreview(
      [displayName, commandPreview || path, cwd ? `cwd ${cwd}` : undefined]
        .filter(Boolean)
        .join(" | ")
    );
    return `Running ${summary}...`;
  }

  if (action === "run_shell") {
    const command = pickTrimmedString(record, "command");
    const cwd = pickTrimmedString(record, "cwd") ?? path;
    summary = truncatePreview(
      [displayName, command, cwd ? `cwd ${cwd}` : undefined]
        .filter(Boolean)
        .join(" | ")
    );
    return `Running ${summary}...`;
  }

  if (action === "open_shell") {
    const cwd = pickTrimmedString(record, "cwd") ?? path;
    summary = truncatePreview(
      [displayName, cwd ? `cwd ${cwd}` : undefined].filter(Boolean).join(" | ")
    );
    return `Running ${summary}...`;
  }

  if (action === "write_shell") {
    const inputPreview =
      pickTrimmedString(record, "input") ?? pickTrimmedString(record, "text");
    summary = truncatePreview([displayName, inputPreview].filter(Boolean).join(" | "));
    return `Running ${summary}...`;
  }

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
    detail = [newName ? `to ${formatQuotedPreview(newName)}` : undefined,
      typeof line === "number" && typeof column === "number"
        ? `at ${line}:${column}`
        : undefined]
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

  summary = truncatePreview(
    [displayName, path && path !== "." ? path : path === "." ? "workspace" : undefined, detail]
      .filter(Boolean)
      .join(" | ")
  );
  return `Running ${summary || displayName}...`;
};

const getNormalizedLoopInput = (toolName: string, input: unknown): unknown => {
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
      return {
        action,
        path,
        paths: pickStringArray(record, "paths") ?? [],
      };
    case "read_range":
      return {
        action,
        path,
        startLine: pickFiniteNumber(record, "startLine"),
        endLine: pickFiniteNumber(record, "endLine"),
      };
    case "read_json":
      return {
        action,
        path,
        jsonPath: pickTrimmedString(record, "jsonPath"),
      };
    case "read_yaml":
      return {
        action,
        path,
        yamlPath: pickTrimmedString(record, "yamlPath"),
      };
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
      return {
        action,
        path: path ?? ".",
        maxResults: pickFiniteNumber(record, "maxResults"),
      };
    case "git_show":
      return {
        action,
        path: path ?? ".",
        revision: pickTrimmedString(record, "revision"),
      };
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
      return {
        action,
        path,
        destination: pickTrimmedString(record, "destination"),
      };
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
      return {
        action,
        path: path ?? ".",
        cwd: pickTrimmedString(record, "cwd"),
      };
    case "write_shell":
      return {
        action,
        path: path ?? ".",
        input:
          pickTrimmedString(record, "input") ?? pickTrimmedString(record, "text"),
      };
    case "read_shell":
    case "shell_status":
    case "interrupt_shell":
    case "close_shell":
      return {
        action,
        path: path ?? ".",
      };
    default:
      return {
        action,
        ...record,
      };
  }
};

const getLoopDisplayName = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return toolName === "file" && action ? action : toolName;
};

const getLoopSignature = (
  toolName: string,
  input: unknown,
  filesystemMutationRevision: number
) => {
  const scope = isFilesystemBoundFileAction(toolName, input)
    ? `fs:${filesystemMutationRevision}`
    : "global";
  return `${toolName}:${scope}:${stableSerialize(getNormalizedLoopInput(toolName, input))}`;
};

const normalizeForIntent = (text: string) => text.toLowerCase();

const taskSuggestsWriting = (task: string) =>
  /(create|write|add|append|fill|implement|fix|update|modify|patch|save|generate|split|modulari(?:s|z)e|reorganize|classify|migrate|补|写|创建|修复|更新|修改|实现|填充|补充|写入|拆分|模块化|整理|分类|迁移)/i.test(
    task
  );

const taskMentionsEmptyOrMissingContent = (task: string) =>
  /(empty|blank|missing content|no content|didn'?t write|not written|空|为空|空的|没写|没有写|未写入|内容为空|没内容)/i.test(
    task
  );

const taskSuggestsPostWriteVerification = (task: string) =>
  /(verify|verification|validate|check|inspect|review|show|display|print|confirm|read back|double-check|look at|look over|确认|检查|验证|查看|看看|显示|展示|读一下|读取|核对)/i.test(
    task
  );

const isBroadDiscoveryAction = (toolName: string, input: unknown) =>
  BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input));

const isTargetedSourceReadAction = (toolName: string, input: unknown) =>
  TARGETED_SOURCE_READ_ACTIONS.has(getToolAction(toolName, input));

const taskSuggestsSimpleMultiFile = (
  task: string,
  ledger: MultiFileProgressLedger
) =>
  taskSuggestsWriting(task) &&
  (getLedgerExpectedFileCount(ledger) > 1 ||
    ledger.targetPaths.length >= 2 ||
    SIMPLE_MULTI_FILE_TASK_PATTERN.test(task));

const createUncertaintyState = (
  task: string,
  ledger: MultiFileProgressLedger
): UncertaintyState => {
  const mode: UncertaintyMode = taskSuggestsSimpleMultiFile(task, ledger)
    ? "simple_multi_file"
    : "normal";
  return {
    mode,
    phase: mode === "simple_multi_file" ? "discover" : "discover",
    discoverBudgetUsed: 0,
    discoverBudgetMax: 4,
    nonProgressAutoContinueUsed: false,
    explicitSourceReads: new Set<string>(),
    explicitTaskPaths: new Set(extractExplicitTaskPaths(task)),
    verifyRequested: taskSuggestsPostWriteVerification(task),
    blockedReason: null,
  };
};

const formatExecutionState = (
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger
) => {
  if (uncertainty.mode !== "simple_multi_file") {
    return "";
  }

  const expected = getLedgerExpectedFileCount(ledger);
  const completedCount = ledger.completedPaths.length;
  const remainingPaths = getLedgerRemainingPaths(ledger);
  const remainingCount = getLedgerRemainingCount(ledger);
  const lines = [
    "Execution state:",
    `mode: ${uncertainty.mode}`,
    `phase: ${uncertainty.phase}`,
    `broad discovery budget: ${uncertainty.discoverBudgetUsed}/${uncertainty.discoverBudgetMax}`,
  ];

  if (expected > 0) {
    lines.push(`completed: ${completedCount}/${expected}`);
  }
  if (remainingPaths.length > 0) {
    lines.push(`remaining known paths: ${formatPathList(remainingPaths, 4)}`);
  } else if (remainingCount > 0) {
    lines.push(`remaining count: ${remainingCount}`);
  }
  if (ledger.lastCompletedPath) {
    lines.push(`last completed file: ${ledger.lastCompletedPath}`);
  }
  if (uncertainty.phase === "execute") {
    lines.push(
      "directive: write remaining files directly; do not reread completed files or re-open broad discovery"
    );
  } else if (uncertainty.phase === "collapse") {
    lines.push(
      "directive: broad exploration is over; continue with the concrete remaining write/edit steps"
    );
  } else if (uncertainty.phase === "verify") {
    lines.push(
      "directive: verify the written files directly; avoid reopening broad discovery"
    );
  } else if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
    lines.push(`blocked: ${uncertainty.blockedReason}`);
  }

  return lines.join("\n");
};

const buildInitialExecutionMemo = (
  query: string,
  originalTask: string,
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger
) => {
  if (uncertainty.mode !== "simple_multi_file") {
    return clipRoundPromptText(query, ROUND_PROMPT_TASK_CHAR_LIMIT);
  }

  const expected = getLedgerExpectedFileCount(ledger);
  const memo = [
    clipRoundPromptText(query, ROUND_PROMPT_TASK_CHAR_LIMIT),
    "",
    "Execution memo:",
    "- This is a simple multi-file task.",
    `- phase: ${uncertainty.phase}`,
    `- broad discovery budget: ${uncertainty.discoverBudgetUsed}/${uncertainty.discoverBudgetMax}`,
    expected > 0 ? `- expected files: ${expected}` : "",
    ledger.targetPaths.length > 1
      ? `- known target paths: ${formatPathList(ledger.targetPaths, 4)}`
      : "",
    "- If enough context is already clear, move straight to the remaining writes/edits.",
    "- If several similar writes are needed, emit multiple tool_call actions in the same round before the final answer.",
    "- Keep narration minimal and do not stop after partial progress.",
    `Original user task: ${clipRoundPromptText(originalTask, ROUND_PROMPT_TASK_CHAR_LIMIT)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return memo;
};

const getRecentDiscoveredPaths = (
  accumulatedToolResults: string[],
  roundToolResults: string[]
) => extractPathsFromText([...accumulatedToolResults.slice(-3), ...roundToolResults].join("\n"));

const shouldAllowTargetedSourceRead = (
  path: string | undefined,
  uncertainty: UncertaintyState,
  accumulatedToolResults: string[],
  roundToolResults: string[]
) => {
  if (!path) {
    return false;
  }

  if (uncertainty.mode !== "simple_multi_file") {
    return true;
  }

  if (uncertainty.phase === "verify" && uncertainty.verifyRequested) {
    return true;
  }

  const normalizedPath = normalizeComparedPath(path);
  const recentlyDiscovered = new Set(
    getRecentDiscoveredPaths(accumulatedToolResults, roundToolResults)
  );
  if (recentlyDiscovered.has(normalizedPath)) {
    return true;
  }

  return (
    uncertainty.explicitTaskPaths.has(normalizedPath) &&
    !uncertainty.explicitSourceReads.has(normalizedPath)
  );
};

const maybeMarkExplicitSourceRead = (
  uncertainty: UncertaintyState,
  path: string | undefined
) => {
  if (!path) {
    return;
  }
  const normalizedPath = normalizeComparedPath(path);
  if (uncertainty.explicitTaskPaths.has(normalizedPath)) {
    uncertainty.explicitSourceReads.add(normalizedPath);
  }
};

const getBlockedReason = (
  originalTask: string,
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger,
  accumulatedToolResults: string[],
  roundToolResults: string[]
) => {
  if (
    uncertainty.mode !== "simple_multi_file" ||
    !SIMPLE_MULTI_FILE_TASK_PATTERN.test(originalTask) ||
    (uncertainty.phase !== "collapse" &&
      uncertainty.discoverBudgetUsed < uncertainty.discoverBudgetMax)
  ) {
    return null;
  }

  const expected = getLedgerExpectedFileCount(ledger);
  const knownPaths = new Set([
    ...uncertainty.explicitTaskPaths,
    ...getRecentDiscoveredPaths(accumulatedToolResults, roundToolResults),
  ]);
  if (expected === 0 && knownPaths.size === 0) {
    return "This split/modularization task still lacks a concrete source file or target file count. Stop here and ask for the entry file or target layout.";
  }
  return null;
};

const maybeAdvanceUncertaintyAfterToolResult = (
  uncertainty: UncertaintyState,
  toolName: string,
  input: unknown,
  ledger: MultiFileProgressLedger
) => {
  if (uncertainty.mode !== "simple_multi_file") {
    return;
  }

  if (
    uncertainty.phase === "discover" &&
    (isBroadDiscoveryAction(toolName, input) ||
      isTargetedSourceReadAction(toolName, input)) &&
    (uncertainty.discoverBudgetUsed >= uncertainty.discoverBudgetMax ||
      uncertainty.explicitSourceReads.size > 0 ||
      isMeaningfulMultiFileLedger(ledger))
  ) {
    uncertainty.phase = "collapse";
    return;
  }

  if (
    uncertainty.phase === "execute" &&
    getLedgerRemainingCount(ledger) === 0 &&
    uncertainty.verifyRequested
  ) {
    uncertainty.phase = "verify";
  }
};

const buildNonProgressStopMessage = (
  ledger: MultiFileProgressLedger
) => {
  const remainingPaths = getLedgerRemainingPaths(ledger);
  const remainingCount = getLedgerRemainingCount(ledger);
  const details =
    remainingPaths.length > 0
      ? `Known remaining paths: ${formatPathList(remainingPaths, 5)}.`
      : remainingCount > 0
        ? `Remaining file count: ${remainingCount}.`
        : "There are still unfinished file steps.";
  return [
    "[execution paused]",
    "Progress narration repeated without completing the remaining files.",
    details,
    "Next turn: execute the remaining files directly instead of narrating progress.",
  ].join("\n");
};

const shouldAutoContinueNonProgress = (
  assistantText: string,
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger
) => {
  const visibleChars = assistantText.replace(/\s+/g, "").length;
  return (
    uncertainty.mode === "simple_multi_file" &&
    uncertainty.phase === "execute" &&
    getLedgerRemainingCount(ledger) > 0 &&
    !uncertainty.blockedReason &&
    visibleChars > 0 &&
    visibleChars < MAX_NON_PROGRESS_CHATTER_CHARS &&
    NON_PROGRESS_CHATTER_PATTERN.test(assistantText) &&
    !uncertainty.nonProgressAutoContinueUsed
  );
};

const isImmediateRedundantPostWriteRead = (
  toolName: string,
  input: unknown,
  latestConfirmedFileMutation: ConfirmedFileMutation | null,
  originalTask: string
) => {
  if (
    !latestConfirmedFileMutation ||
    taskSuggestsPostWriteVerification(originalTask) ||
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

const formatRecentConfirmedFileMutations = (
  recentMutations: ConfirmedFileMutation[]
) => {
  if (recentMutations.length === 0) {
    return "";
  }

  return recentMutations
    .map(
      (mutation, index) =>
        `${index + 1}. ${mutation.action} ${mutation.path} (confirmed written or updated; continue instead of rereading just to check)`
    )
    .join("\n");
};

const buildHeuristicNudges = (
  originalTask: string,
  toolResults: string[],
  recentConfirmedFileMutations: ConfirmedFileMutation[],
  progressLedger: MultiFileProgressLedger
) => {
  if (toolResults.length === 0) {
    return "";
  }

  const recentResults = toolResults.slice(-6).join("\n\n");
  const normalizedTask = normalizeForIntent(originalTask);
  const wantsWrite = taskSuggestsWriting(normalizedTask);
  const mentionsEmptyIssue = taskMentionsEmptyOrMissingContent(normalizedTask);
  const wantsVerification = taskSuggestsPostWriteVerification(originalTask);
  const remainingPaths = getLedgerRemainingPaths(progressLedger);
  const remainingCount = getLedgerRemainingCount(progressLedger);
  const completedCount = progressLedger.completedPaths.length;
  const nudges: string[] = [
    "Continue from the confirmed facts in the tool results above. Do not restart exploration from scratch.",
  ];

  const latestConfirmedMutation = recentConfirmedFileMutations.at(-1);
  if (latestConfirmedMutation && !wantsVerification) {
    nudges.push(
      `The latest successful file mutation already confirmed ${latestConfirmedMutation.path}. Continue the task and do not call read_file on the same path just to verify the write.`
    );
  }

  if (
    wantsWrite &&
    !wantsVerification &&
    isMeaningfulMultiFileLedger(progressLedger) &&
    remainingCount > 0
  ) {
    if (remainingPaths.length > 0) {
      nudges.push(
        `This is a multi-file task. Continue with the remaining target files directly: ${formatPathList(
          remainingPaths,
          4
        )}. Do not reread completed files or relist directories just to confirm progress.`
      );
    } else {
      const expected = getLedgerExpectedFileCount(progressLedger);
      nudges.push(
        `This is a multi-file task. ${completedCount}/${expected} files are already complete. Continue with the remaining ${remainingCount} file(s) instead of rereading finished ones.`
      );
    }
  }

  if (wantsWrite && recentResults.includes("[confirmed directory state]")) {
    nudges.push(
      "Stop exploring and start writing: the relevant directory state is already confirmed."
    );
  }

  if ((wantsWrite || mentionsEmptyIssue) && recentResults.includes("(empty file)")) {
    nudges.push(
      "The next action should be write_file/create_file/edit_file, not read_file again, because the file was already confirmed empty."
    );
  }

  if (
    recentResults.includes("[tool result] find_files ") ||
    recentResults.includes("[tool result] find_symbol ") ||
    recentResults.includes("[tool result] find_references ") ||
    recentResults.includes("[tool result] lsp_definition ") ||
    recentResults.includes("[tool result] lsp_implementation ") ||
    recentResults.includes("[tool result] lsp_type_definition ") ||
    recentResults.includes("[tool result] lsp_references ") ||
    recentResults.includes("[tool result] lsp_workspace_symbols ") ||
    recentResults.includes("[tool result] lsp_document_symbols ") ||
    recentResults.includes("[tool result] lsp_code_actions ") ||
    recentResults.includes("[tool result] search_text ") ||
    recentResults.includes("[tool result] search_text_context ") ||
    recentResults.includes("[tool result] stat_path ")
  ) {
    nudges.push(
      "Use the discovered path or search hit directly; do not rediscover it with more list_dir/find_files/search_text calls."
    );
  }

  if (
    (recentResults.includes("[tool result] run_command ") ||
      recentResults.includes("[tool result] run_shell ")) &&
    /status:\s*(failed|timed_out)/i.test(recentResults)
  ) {
    nudges.push(
      "The same process or shell command already failed. Do not rerun it unchanged unless you are changing args, cwd, command text, or the plan."
    );
  }

  return nudges.map((nudge, index) => `${index + 1}. ${nudge}`).join("\n");
};

const buildRoundPrompt = (
  originalTask: string,
  toolResults: string[],
  loopCorrection: string,
  recentConfirmedFileMutations: ConfirmedFileMutation[],
  progressLedger: MultiFileProgressLedger,
  uncertainty: UncertaintyState
) => {
  const heuristicNudges = buildHeuristicNudges(
    originalTask,
    toolResults,
    recentConfirmedFileMutations,
    progressLedger
  );
  const recentMutationFacts = formatRecentConfirmedFileMutations(
    recentConfirmedFileMutations
  );
  const multiFileProgressFacts = formatMultiFileProgressLedger(progressLedger);
  const executionState = formatExecutionState(uncertainty, progressLedger);
  return [
    "Original user task:",
    clipRoundPromptText(originalTask, ROUND_PROMPT_TASK_CHAR_LIMIT),
    "",
    "Continue based on tool results while staying strictly on the original task.",
    "Do not inspect unrelated files unless required for the task.",
    "Treat a confirmed directory state as authoritative until a mutation changes it.",
    "Do not call list_dir again for the same path immediately after it was already confirmed.",
    "Treat `(empty file)` from read_file as a confirmed result and do not re-read the same file unless something changed it.",
    "Treat successful create_file/write_file/edit_file/apply_patch results as confirmed file mutations. Do not immediately call read_file on the same path just to confirm the write unless the user explicitly asked to inspect or verify that file.",
    "Execution style rules:",
    "- Continue directly from the latest confirmed result; do not re-announce the whole plan each step.",
    "- Keep progress narration minimal and non-repetitive. Avoid repeated lines like 'I will now...'.",
    "- For multi-file create/edit tasks, batch similar writes naturally and move forward without repeated preambles.",
    "- Keep assistant wording in the same language as the user request unless the user asks to switch.",
    recentMutationFacts
      ? `Recent confirmed file mutations:\n${recentMutationFacts}`
      : "",
    multiFileProgressFacts
      ? `Multi-file progress ledger:\n${multiFileProgressFacts}`
      : "",
    executionState,
    heuristicNudges ? `Heuristic nudges:\n${heuristicNudges}` : "",
    loopCorrection ? `\n${loopCorrection}\n` : "",
    "Tool results:",
    formatToolResultsForRoundPrompt(toolResults),
    "If more tool usage is needed, call tools again. Otherwise provide final answer.",
  ].join("\n\n");
};

const isFailedCommandResult = (message: string) =>
  /status:\s*(failed|timed_out)/i.test(message) ||
  /exit:\s*(?!0\b)[^\s]+/i.test(message);

export const runQuerySession = async ({
  query,
  originalTask,
  queryMaxToolSteps = DEFAULT_QUERY_MAX_TOOL_STEPS,
  transport,
  onState,
  onTextDelta,
  onUsage,
  onToolStatus,
  onToolCall,
  onError,
}: RunQuerySessionParams): Promise<RunQuerySessionResult> => {
  let state = createQuerySessionState();
  const task = originalTask ?? query;
  let filesystemMutationRevision = 0;
  let recentConfirmedFileMutations: ConfirmedFileMutation[] = [];
  let progressLedger = createInitialMultiFileProgressLedger(task);
  const uncertainty = createUncertaintyState(task, progressLedger);
  let latestConfirmedFileMutation: ConfirmedFileMutation | null = null;
  let repeatedImmediatePostWriteReadCount = 0;
  const maxToolSteps =
    Number.isFinite(queryMaxToolSteps) && queryMaxToolSteps > 0
      ? Math.floor(queryMaxToolSteps)
      : DEFAULT_QUERY_MAX_TOOL_STEPS;
  const dispatch: QuerySessionDispatch = event => {
    state = querySessionReducer(state, event);
    onState(state);
  };

  const applyToolResultSideEffects = (
    toolName: string,
    input: unknown,
    message: string,
    accumulatedToolResults: string[],
    roundToolResults: string[]
  ) => {
    if (isTargetedSourceReadAction(toolName, input)) {
      maybeMarkExplicitSourceRead(uncertainty, getToolPath(input));
    }
    const confirmedFileMutation = getConfirmedFileMutation(
      toolName,
      input,
      message
    );
    if (confirmedFileMutation) {
      recentConfirmedFileMutations = pushRecentConfirmedFileMutation(
        recentConfirmedFileMutations,
        confirmedFileMutation
      );
      progressLedger = pushCompletedPathToLedger(
        progressLedger,
        confirmedFileMutation.path
      );
      latestConfirmedFileMutation = confirmedFileMutation;
      repeatedImmediatePostWriteReadCount = 0;
      uncertainty.phase =
        getLedgerRemainingCount(progressLedger) === 0 && uncertainty.verifyRequested
          ? "verify"
          : "execute";
    } else {
      maybeAdvanceUncertaintyAfterToolResult(
        uncertainty,
        toolName,
        input,
        progressLedger
      );
    }
    const blockedReason = getBlockedReason(
      task,
      uncertainty,
      progressLedger,
      accumulatedToolResults,
      roundToolResults
    );
    if (blockedReason) {
      uncertainty.phase = "blocked";
      uncertainty.blockedReason = blockedReason;
    }
    return confirmedFileMutation;
  };

  const runRounds = async (
    roundPrompt: string,
    repeatedToolCallCount: Map<string, number>,
    loopCorrection: string,
    accumulatedToolResults: string[],
    toolStepsUsed: number,
    options?: RunRoundsOptions
  ): Promise<RunQuerySessionResult> => {
    dispatch({ type: "start" });

    const streamUrl = await transport.requestStreamUrl(roundPrompt);
    let completed = false;
    let sawToolCall = false;
    let streamOpened = false;
    let visibleAnswerChars = 0;
    const toolResults: string[] = [];
    let latestUsage: TokenUsage | null = null;
    let usageReported = false;
    const shouldDeferRoundText =
      uncertainty.mode === "simple_multi_file" &&
      uncertainty.phase === "execute";
    let deferredRoundText = "";

    const flushUsage = () => {
      if (usageReported || !latestUsage) {
        return;
      }
      usageReported = true;
      onUsage?.(latestUsage);
    };

    const completeRound = () => {
      flushUsage();
      dispatch({ type: "complete" });
      return COMPLETED_RESULT;
    };

    const emitRoundText = (text: string) => {
      if (!text) {
        return;
      }
      dispatch({ type: "text_delta", text });
      onTextDelta(text);
    };

    const createOneShotResume = (
      resumeImpl: (toolResultMessage: string) => Promise<RunQuerySessionResult>
    ): RunQuerySessionResult => {
      flushUsage();
      let resumePromise: Promise<RunQuerySessionResult> | null = null;
      return {
        status: "suspended",
        resume: toolResultMessage => {
          if (!resumePromise) {
            resumePromise = resumeImpl(toolResultMessage);
          }
          return resumePromise;
        },
      };
    };

    try {
      for await (const chunk of transport.stream(streamUrl)) {
        const events = parseStreamChunk(chunk);
        for (const event of events) {
        if (!streamOpened && event.type !== "done") {
          dispatch({ type: "stream_open" });
          streamOpened = true;
        }

        if (event.type === "text_delta") {
          if (sawToolCall) {
            continue;
          }
          visibleAnswerChars += event.text.trim() ? event.text.length : 0;
          if (shouldDeferRoundText) {
            deferredRoundText += event.text;
          } else {
            emitRoundText(event.text);
          }
          continue;
        }

        if (event.type === "tool_call") {
          if (visibleAnswerChars >= LATE_TOOL_CALL_VISIBLE_ANSWER_CHAR_GUARD) {
            continue;
          }
          if (toolStepsUsed >= maxToolSteps) {
            onTextDelta(
              `\n[tool budget exhausted] Used ${toolStepsUsed}/${maxToolSteps} tool steps. Stopping to avoid runaway execution. Split the task or raise query_max_tool_steps to continue.\n`
            );
            return completeRound();
          }
          toolStepsUsed += 1;
          sawToolCall = true;
          const action = getToolAction(event.toolName, event.input);
          const toolPath = getToolPath(event.input);
          const displayName = getLoopDisplayName(event.toolName, event.input);

          if (
            uncertainty.mode === "simple_multi_file" &&
            isBroadDiscoveryAction(event.toolName, event.input)
          ) {
            if (uncertainty.phase === "discover") {
              if (uncertainty.discoverBudgetUsed >= uncertainty.discoverBudgetMax) {
                uncertainty.phase = "collapse";
              } else {
                uncertainty.discoverBudgetUsed += 1;
              }
            }

            if (uncertainty.phase !== "discover") {
              const remainingPaths = getLedgerRemainingPaths(progressLedger);
              const skipReason =
                uncertainty.phase === "execute" || uncertainty.phase === "verify"
                  ? remainingPaths.length > 0 || getLedgerRemainingCount(progressLedger) > 0
                    ? "remaining files are already known"
                    : "completed files are authoritative"
                  : "the broad discovery budget is already exhausted";
              loopCorrection = [
                "Exploration collapsed:",
                `Skipped ${action} ${toolPath ?? "."} because ${skipReason}.`,
                "Stop broad exploration and continue with the remaining concrete file actions directly.",
              ].join("\n");
              toolResults.push(
                [
                  `[tool skipped] ${action} ${toolPath ?? "."}`.trim(),
                  `Skipped ${action} because ${skipReason}.`,
                  "Continue with remaining targets directly instead of reopening broad discovery.",
                ].join("\n")
              );
              const blockedReason = getBlockedReason(
                task,
                uncertainty,
                progressLedger,
                accumulatedToolResults,
                toolResults
              );
              if (blockedReason) {
                uncertainty.phase = "blocked";
                uncertainty.blockedReason = blockedReason;
                emitRoundText(`${blockedReason}\n`);
                return completeRound();
              }
              continue;
            }
          }

          if (
            uncertainty.mode === "simple_multi_file" &&
            isTargetedSourceReadAction(event.toolName, event.input) &&
            !shouldAllowTargetedSourceRead(
              toolPath,
              uncertainty,
              accumulatedToolResults,
              toolResults
            )
          ) {
            loopCorrection = [
              "Targeted source read blocked:",
              `Skipped ${action} ${toolPath ?? "."}.`,
              "Read the explicitly requested source path once or use a path that was just discovered for the split/write step.",
            ].join("\n");
            toolResults.push(
              [
                `[tool skipped] ${action} ${toolPath ?? "."}`.trim(),
                `Skipped ${action} because this path was neither explicitly requested nor just discovered for the current multi-file task.`,
                "Continue with the concrete remaining write/edit steps instead of adding more source reads.",
              ].join("\n")
            );
            continue;
          }

          const signature = getLoopSignature(
            event.toolName,
            event.input,
            filesystemMutationRevision
          );
          const seen = (repeatedToolCallCount.get(signature) ?? 0) + 1;
          repeatedToolCallCount.set(signature, seen);
          if (
            uncertainty.mode === "simple_multi_file" &&
            seen >= 2 &&
            (isBroadDiscoveryAction(event.toolName, event.input) ||
              isExploratoryProbe(event.toolName, event.input))
          ) {
            uncertainty.phase = uncertainty.phase === "discover" ? "collapse" : uncertainty.phase;
          }
          if (seen >= 2 && isExploratoryProbe(event.toolName, event.input)) {
            const repeatedPath = getToolPath(event.input) ?? ".";
            loopCorrection = [
              "Repeated directory probe warning:",
              `Directory state for ${repeatedPath} was already confirmed.`,
              "Do NOT call list_dir for the same path again unless a write or directory mutation happened.",
              "Choose the next concrete action toward the original task.",
            ].join("\n");
          } else if (seen >= 2 && isCommandLikeAction(event.toolName, event.input)) {
            const commandKind = action === "run_shell" ? "shell command" : "bounded command";
            loopCorrection = [
              `Repeated ${commandKind} warning:`,
              `Command call was repeated: ${displayName} ${stableSerialize(
                getNormalizedLoopInput(event.toolName, event.input)
              )}`,
              `Do NOT rerun the same ${action} unchanged unless the prior result shows a concrete new reason.`,
              "Prefer the next concrete fix, file edit, or adjusted command.",
            ].join("\n");
          } else if (seen >= 2) {
            loopCorrection = [
              "Loop warning:",
              `Tool call was repeated: ${displayName} ${stableSerialize(
                getNormalizedLoopInput(event.toolName, event.input)
              )}`,
              "Do NOT call the same tool with the same input again.",
              "Choose the next concrete step toward completing the original task.",
            ].join("\n");
          }
          if (seen >= 3 && isExploratoryProbe(event.toolName, event.input)) {
            const repeatedPath = getToolPath(event.input) ?? ".";
            onTextDelta(
              `\n[tool loop detected] list_dir ${repeatedPath} was called repeatedly after directory state was already confirmed. Stopping to prevent infinite loop.\n`
            );
            return completeRound();
          }
          if (seen >= 3 && isCommandLikeAction(event.toolName, event.input)) {
            onTextDelta(
              `\n[tool loop detected] ${action} was called repeatedly with the same command signature. Stopping to prevent infinite loop.\n`
            );
            return completeRound();
          }
          if (seen >= 4) {
            onTextDelta(
              `\n[tool loop detected] ${displayName} was called repeatedly with same input. Stopping to prevent infinite loop.\n`
            );
            return completeRound();
          }
          if (
            isImmediateRedundantPostWriteRead(
              event.toolName,
              event.input,
              latestConfirmedFileMutation,
              task
            )
          ) {
            const repeatedPath =
              getToolPath(event.input) ?? latestConfirmedFileMutation?.path ?? ".";
            repeatedImmediatePostWriteReadCount += 1;
            const sourceAction = latestConfirmedFileMutation?.action ?? "write_file";
            loopCorrection = [
              "Immediate post-write read blocked:",
              `${repeatedPath} was just updated successfully via ${sourceAction}.`,
              "Do NOT call read_file on the same path just to confirm the write.",
              "Continue to the next concrete step unless the user explicitly asked to inspect or verify that file.",
            ].join("\n");
            toolResults.push(
              [
                `[tool skipped] read_file ${repeatedPath}`,
                `Skipped redundant read_file for ${repeatedPath} because it was just updated successfully via ${sourceAction}.`,
                "Treat the successful write result as authoritative and continue the task unless explicit verification is required.",
              ].join("\n")
            );
            if (repeatedImmediatePostWriteReadCount >= 2) {
              onTextDelta(
                `\n[tool loop detected] read_file ${repeatedPath} was attempted repeatedly immediately after a confirmed write. Stopping to prevent needless rereads.\n`
              );
              return completeRound();
            }
            continue;
          }
          if (latestConfirmedFileMutation) {
            latestConfirmedFileMutation = null;
            repeatedImmediatePostWriteReadCount = 0;
          }
          dispatch({
            type: "tool_call",
            toolName: event.toolName,
            input: event.input,
          });
          onToolStatus?.(buildToolStatusMessage(event.toolName, event.input));
          const toolResult = await onToolCall(event.toolName, event.input);
          if (
            seen >= 2 &&
            isReadFileAction(event.toolName, event.input) &&
            toolResult.message.includes("(empty file)")
          ) {
            const repeatedPath = getToolPath(event.input) ?? ".";
            onTextDelta(
              `\n[tool loop detected] read_file ${repeatedPath} was repeated even though the file was already confirmed empty. Stopping to prevent infinite loop.\n`
            );
            return completeRound();
          }
          if (
            seen >= 2 &&
            isCommandLikeAction(event.toolName, event.input) &&
            isFailedCommandResult(toolResult.message)
          ) {
            onTextDelta(
              `\n[tool loop detected] ${action} was retried after the same command already failed. Stop rerunning it unchanged and choose a new concrete step.\n`
            );
            return completeRound();
          }
          if (didApplyFileMutation(event.toolName, event.input, toolResult.message)) {
            filesystemMutationRevision += 1;
            loopCorrection = "";
          }
          applyToolResultSideEffects(
            event.toolName,
            event.input,
            toolResult.message,
            accumulatedToolResults,
            toolResults
          );
          if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
            emitRoundText(`${uncertainty.blockedReason}\n`);
            return completeRound();
          }
          if (toolResult.reviewMode) {
            dispatch({ type: "suspended" });
            return createOneShotResume(async (toolResultMessage: string) => {
                if (didApplyFileMutation(event.toolName, event.input, toolResultMessage)) {
                  filesystemMutationRevision += 1;
                  loopCorrection = "";
                }
                applyToolResultSideEffects(
                  event.toolName,
                  event.input,
                  toolResultMessage,
                  accumulatedToolResults,
                  toolResults
                );
                if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
                  emitRoundText(`${uncertainty.blockedReason}\n`);
                  return completeRound();
                }
                const nextToolResults = [
                  ...accumulatedToolResults,
                  ...toolResults,
                  `[tool_result] ${event.toolName}\n${toolResultMessage}`.trim(),
                ];
                const nextPrompt = buildRoundPrompt(
                  task,
                  nextToolResults,
                  loopCorrection,
                  recentConfirmedFileMutations,
                  progressLedger,
                  uncertainty
                );
                return runRounds(
                  nextPrompt,
                  repeatedToolCallCount,
                  loopCorrection,
                  nextToolResults,
                  toolStepsUsed,
                  { allowSilentPostReviewRetry: true }
                );
              });
          }
          toolResults.push(
            `[tool_result] ${event.toolName}\n${toolResult.message}`.trim()
          );
          continue;
        }

        if (event.type === "usage") {
          latestUsage = {
            promptTokens: event.promptTokens,
            cachedTokens: event.cachedTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
          };
          dispatch({
            type: "usage",
            promptTokens: latestUsage.promptTokens,
            cachedTokens: latestUsage.cachedTokens,
            completionTokens: latestUsage.completionTokens,
            totalTokens: latestUsage.totalTokens,
          });
          continue;
        }

        if (event.type === "done") {
          completed = true;
          break;
        }
      }

        if (completed) {
          break;
        }
      }
    } catch (error) {
      flushUsage();
      throw error;
    }

    if (!sawToolCall) {
      if (shouldDeferRoundText) {
        if (
          shouldAutoContinueNonProgress(
            deferredRoundText,
            uncertainty,
            progressLedger
          )
        ) {
          flushUsage();
          uncertainty.nonProgressAutoContinueUsed = true;
          const nextPrompt = buildRoundPrompt(
            task,
            accumulatedToolResults,
            [
              "The previous reply narrated progress without completing the remaining files.",
              "Do not narrate. Execute the remaining files directly.",
            ].join("\n"),
            recentConfirmedFileMutations,
            progressLedger,
            uncertainty
          );
          return runRounds(
            nextPrompt,
            repeatedToolCallCount,
            loopCorrection,
            accumulatedToolResults,
            toolStepsUsed
          );
        }
        if (
          uncertainty.mode === "simple_multi_file" &&
          uncertainty.phase === "execute" &&
          getLedgerRemainingCount(progressLedger) > 0 &&
          NON_PROGRESS_CHATTER_PATTERN.test(deferredRoundText)
        ) {
          emitRoundText(buildNonProgressStopMessage(progressLedger));
          return completeRound();
        }
        emitRoundText(deferredRoundText);
      }
      if (visibleAnswerChars === 0 && options?.allowSilentPostReviewRetry) {
        flushUsage();
        const nextPrompt = buildRoundPrompt(
          task,
          accumulatedToolResults,
          [loopCorrection, SILENT_REVIEW_RESUME_RECOVERY_NOTE]
            .filter(Boolean)
            .join("\n\n"),
          recentConfirmedFileMutations,
          progressLedger,
          uncertainty
        );
        return runRounds(
          nextPrompt,
          repeatedToolCallCount,
          loopCorrection,
          accumulatedToolResults,
          toolStepsUsed,
          { allowSilentPostReviewRetry: false }
        );
      }
      return completeRound();
    }

    accumulatedToolResults = [...accumulatedToolResults, ...toolResults];
    flushUsage();
    const nextPrompt = buildRoundPrompt(
      task,
      accumulatedToolResults,
      loopCorrection,
      recentConfirmedFileMutations,
      progressLedger,
      uncertainty
    );
    return runRounds(
      nextPrompt,
      repeatedToolCallCount,
      loopCorrection,
      accumulatedToolResults,
      toolStepsUsed,
      options
    );
  };

  try {
    return await runRounds(
      buildInitialExecutionMemo(query, task, uncertainty, progressLedger),
      new Map<string, number>(),
      "",
      [],
      0
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "fail", message });
    onError(message);
    return { status: "completed" };
  }
};
