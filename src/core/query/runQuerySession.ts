import { parseStreamChunk } from "./streamProtocol";
import {
  createQuerySessionState,
  querySessionReducer,
  type QuerySessionDispatch,
  type QuerySessionState,
} from "./sessionMachine";
import { DEFAULT_QUERY_MAX_TOOL_STEPS } from "../../shared/runtimeDefaults";
import {
  normalizeQueryInput,
  type QueryInput,
  type QueryTransport,
} from "./transport";
import type { TokenUsage } from "./tokenUsage";

type RunQuerySessionParams = {
  query: string | QueryInput;
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
    | Promise<RunQuerySessionToolCallResult>
    | RunQuerySessionToolCallResult;
  onError: (message: string) => void;
};

type RunQuerySessionToolResult = {
  message: string;
  metadata?: unknown;
};

type RunQuerySessionToolCallResult = RunQuerySessionToolResult & {
  reviewMode?: "queue" | "block";
};

export type RunQuerySessionResumeInput = string | RunQuerySessionToolResult;

export type RunQuerySessionResult =
  | { status: "completed" }
  | {
      status: "suspended";
      resume: (toolResult: RunQuerySessionResumeInput) => Promise<RunQuerySessionResult>;
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

type SemanticProvider = "lsp" | "ts" | "text";

type SemanticRoutingHint = {
  provider: SemanticProvider;
  reason:
    | "lsp_available"
    | "lsp_unavailable"
    | "ts_available"
    | "text_fallback";
};

type SearchMemory = {
  scopedBroadDiscoveryBudget: Map<string, number>;
  searchedScopes: Set<string>;
  discoveredPaths: Set<string>;
  evidenceSignatures: Set<string>;
  semanticRoutingByPath: Map<string, SemanticRoutingHint>;
};

type FileReadLedgerEntry = {
  path: string;
  revision: number;
  revisionKey: string | null;
  lastReadStartLine: number | null;
  lastReadEndLine: number | null;
  fullyRead: boolean;
  truncated: boolean;
  nextSuggestedStartLine: number | null;
  ranges: Array<{ startLine: number; endLine: number }>;
};

type ProgressSnapshot = {
  mutationRevision: number;
  phase: UncertaintyPhase;
  analysisSignalCount: number;
  semanticNavigationCount: number;
  completedPathCount: number;
  discoveredPathCount: number;
  evidenceCount: number;
};

type RunRoundsOptions = {
  allowSilentPostReviewRetry?: boolean;
};

type UncertaintyMode = "normal" | "simple_multi_file" | "project_analysis";

type UncertaintyPhase =
  | "discover"
  | "collapse"
  | "execute"
  | "verify"
  | "trace"
  | "synthesize"
  | "blocked";

type UncertaintyState = {
  mode: UncertaintyMode;
  phase: UncertaintyPhase;
  discoverBudgetUsed: number;
  discoverBudgetMax: number;
  analysisSignalCount: number;
  semanticNavigationCount: number;
  nonProgressAutoContinueUsed: boolean;
  explicitSourceReads: Set<string>;
  explicitTaskPaths: Set<string>;
  verifyRequested: boolean;
  blockedReason: string | null;
};

const LATE_TOOL_CALL_VISIBLE_ANSWER_CHAR_GUARD = 200;
const MAX_NON_PROGRESS_CHATTER_CHARS = 240;
const MAX_NON_PROGRESS_ROUNDS = 3;
const BROAD_DISCOVERY_SCOPE_BUDGET = 3;
const ROUND_PROMPT_TASK_CHAR_LIMIT = 12000;
const ROUND_PROMPT_TOOL_RESULT_CHAR_LIMIT = 16000;
const ROUND_PROMPT_TOOL_RESULT_ITEM_CHAR_LIMIT = 3000;
const ROUND_PROMPT_TOOL_RESULT_KEEP_LIMIT = 8;
const SEARCH_MEMORY_SCOPE_LIMIT = 6;
const SEARCH_MEMORY_PATH_LIMIT = 6;
const FILE_READ_LEDGER_LIMIT = 8;

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

const PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS = new Set([
  "list_dir",
  "find_files",
  "search_text",
  "stat_path",
  "stat_paths",
  "git_status",
  "git_diff",
]);

const TARGETED_SOURCE_READ_ACTIONS = new Set([
  "read_file",
  "read_range",
  "read_json",
  "read_yaml",
]);

const PROJECT_ANALYSIS_HIGH_SIGNAL_ACTIONS = new Set([
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

const HIGH_VALUE_EVIDENCE_ACTIONS = new Set([
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

const SEMANTIC_NAVIGATION_ACTIONS = new Set([
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

const SIMPLE_MULTI_FILE_TASK_PATTERN =
  /(split|modulari(?:s|z)e|module|reorganize|classify|migrate|move.+into|refactor.+files|拆分|模块化|分类|迁移|整理|拆到|拆成|拆出去)/i;

const PROJECT_ANALYSIS_TASK_PATTERN =
  /(?:(?:explain|analy[sz]e|understand|summari[sz]e|map|trace|inspect|walk(?:\s+me)?\s+through)\s+(?:this\s+)?(?:repo|repository|project|codebase|architecture|structure|stack|main\s+flow|call\s+chain))|(?:(?:repo|repository|project|codebase|architecture|structure|stack|main\s+flow|call\s+chain).*(?:explain|analy[sz]e|understand|summari[sz]e|map|trace|inspect))|(?:(?:看看|分析|梳理|理解|总结|解释|讲讲|追踪|定位|看下|看一下).*(?:这个项目|这个仓库|项目|仓库|代码库|架构|结构|技术栈|主链路|调用链|入口|模块))|(?:(?:项目|仓库|代码库|架构|结构|技术栈|主链路|调用链|入口|模块).*(?:看看|分析|梳理|理解|总结|解释|讲讲|追踪|定位))/iu;

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
  message: string,
  metadata?: unknown
) =>
  isMutatingFileAction(toolName, input) &&
  (MUTATION_RESULT_MARKERS.some(marker => message.includes(marker)) ||
    didApplyStructuredFileMutation(metadata));

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
  message: string,
  metadata?: unknown
): ConfirmedFileMutation | null => {
  if (
    !didApplyFileMutation(toolName, input, message, metadata) ||
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

const createSearchMemory = (): SearchMemory => ({
  scopedBroadDiscoveryBudget: new Map(),
  searchedScopes: new Set(),
  discoveredPaths: new Set(),
  evidenceSignatures: new Set(),
  semanticRoutingByPath: new Map(),
});

const mergeReadRanges = (ranges: Array<{ startLine: number; endLine: number }>) => {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((left, right) =>
    left.startLine === right.startLine
      ? left.endLine - right.endLine
      : left.startLine - right.startLine
  );
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (!previous || current.startLine > previous.endLine + 1) {
      merged.push({ ...current });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, current.endLine);
  }
  return merged;
};

const getReadLedgerPath = (input: unknown) => {
  const path = getToolPath(input);
  if (!path) {
    return null;
  }
  const normalized = normalizeComparedPath(path);
  return normalized || null;
};

const getReadLedgerEntry = (
  ledger: Map<string, FileReadLedgerEntry>,
  input: unknown
) => {
  const path = getReadLedgerPath(input);
  return path ? ledger.get(path) ?? null : null;
};

const getStructuredFileResultMetadata = (metadata: unknown) => {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  if (record.kind !== "file") {
    return null;
  }
  return record;
};

const getStructuredFileReadMetadata = (metadata: unknown) => {
  const fileMetadata = getStructuredFileResultMetadata(metadata);
  if (!fileMetadata) {
    return null;
  }
  const read = fileMetadata.read;
  if (!read || typeof read !== "object") {
    return null;
  }
  return {
    fileMetadata,
    read: read as Record<string, unknown>,
  };
};

const didApplyStructuredFileMutation = (metadata: unknown) => {
  const fileMetadata = getStructuredFileResultMetadata(metadata);
  if (!fileMetadata) {
    return false;
  }
  const mutation = fileMetadata.mutation;
  return (
    !!mutation &&
    typeof mutation === "object" &&
    "applied" in mutation &&
    (mutation as Record<string, unknown>).applied === true
  );
};

const normalizeResumeToolResult = (
  toolResult: RunQuerySessionResumeInput
): RunQuerySessionToolResult =>
  typeof toolResult === "string" ? { message: toolResult } : toolResult;

const updateReadLedgerFromToolResult = (
  ledger: Map<string, FileReadLedgerEntry>,
  toolName: string,
  input: unknown,
  message: string,
  metadata: unknown,
  filesystemMutationRevision: number
) => {
  if (toolName !== "file") {
    return;
  }
  const action = getToolAction(toolName, input);
  if (action !== "read_file" && action !== "read_range") {
    return;
  }
  const structured = getStructuredFileReadMetadata(metadata);
  const structuredFileMetadata = structured?.fileMetadata;
  const structuredRead = structured?.read;
  const path =
    (typeof structuredFileMetadata?.workspacePath === "string" &&
    structuredFileMetadata.workspacePath.trim()
      ? normalizeComparedPath(structuredFileMetadata.workspacePath)
      : null) ?? getReadLedgerPath(input);
  if (!path) {
    return;
  }
  if (message.startsWith("[tool error]")) {
    return;
  }

  const previous = ledger.get(path);
  const revisionKey =
    structuredFileMetadata &&
    structuredFileMetadata.fileRevision &&
    typeof structuredFileMetadata.fileRevision === "object" &&
    "revisionKey" in structuredFileMetadata.fileRevision &&
    typeof (structuredFileMetadata.fileRevision as Record<string, unknown>).revisionKey ===
      "string"
      ? String(
          (structuredFileMetadata.fileRevision as Record<string, unknown>).revisionKey
        )
      : null;
  if (action === "read_file") {
    ledger.set(path, {
      path,
      revision: filesystemMutationRevision,
      revisionKey,
      lastReadStartLine: 1,
      lastReadEndLine:
        structuredRead &&
        typeof structuredRead.endLine === "number" &&
        Number.isFinite(structuredRead.endLine)
          ? Number(structuredRead.endLine)
          : null,
      fullyRead:
        structuredRead && typeof structuredRead.fullyRead === "boolean"
          ? structuredRead.fullyRead
          : true,
      truncated: false,
      nextSuggestedStartLine: null,
      ranges: [],
    });
    return;
  }

  const record = toRecord(input);
  const startLine =
    structuredRead && typeof structuredRead.startLine === "number"
      ? Number(structuredRead.startLine)
      : record
        ? pickFiniteNumber(record, "startLine")
        : undefined;
  const endLine =
    structuredRead && typeof structuredRead.endLine === "number"
      ? Number(structuredRead.endLine)
      : record
        ? pickFiniteNumber(record, "endLine")
        : undefined;
  if (typeof startLine !== "number" || typeof endLine !== "number") {
    return;
  }
  const ranges = mergeReadRanges([
    ...(previous?.revision === filesystemMutationRevision ? previous.ranges : []),
    { startLine, endLine },
  ]);
  const leadingRange = ranges[0];
  const nextSuggestedStartLine =
    leadingRange && leadingRange.startLine === 1 ? leadingRange.endLine + 1 : null;
  ledger.set(path, {
    path,
    revision: filesystemMutationRevision,
    revisionKey,
    lastReadStartLine: startLine,
    lastReadEndLine: endLine,
    fullyRead:
      structuredRead && typeof structuredRead.fullyRead === "boolean"
        ? structuredRead.fullyRead
        : previous?.fullyRead ?? false,
    truncated:
      structuredRead && typeof structuredRead.truncated === "boolean"
        ? structuredRead.truncated
        : true,
    nextSuggestedStartLine:
      structuredRead && typeof structuredRead.nextSuggestedStartLine === "number"
        ? Number(structuredRead.nextSuggestedStartLine)
        : nextSuggestedStartLine,
    ranges,
  });
};

const clearReadLedgerForMutation = (
  ledger: Map<string, FileReadLedgerEntry>,
  mutation: ConfirmedFileMutation | null
) => {
  if (!mutation) {
    return;
  }
  const normalized = normalizeComparedPath(mutation.path);
  if (!normalized) {
    return;
  }
  ledger.delete(normalized);
};

const formatFileReadLedger = (
  ledger: Map<string, FileReadLedgerEntry>,
  filesystemMutationRevision: number
) => {
  const entries = Array.from(ledger.values())
    .filter(entry => entry.revision === filesystemMutationRevision)
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, FILE_READ_LEDGER_LIMIT);
  if (entries.length === 0) {
    return "";
  }

  return entries
    .map(entry => {
      if (entry.fullyRead) {
        return `${entry.path}: fully_read=true; next read only if the file changes`;
      }
      const rangePreview = entry.ranges
        .slice(0, 3)
        .map(range => `${range.startLine}-${range.endLine}`)
        .join(", ");
      const nextHint =
        typeof entry.nextSuggestedStartLine === "number"
          ? `; next_suggested_start_line=${entry.nextSuggestedStartLine}`
          : "";
      return `${entry.path}: fully_read=false; read_ranges=${rangePreview}${nextHint}`;
    })
    .join("\n");
};

const isReadRangeCoveredByLedger = (
  entry: FileReadLedgerEntry,
  startLine: number,
  endLine: number,
  filesystemMutationRevision: number
) =>
  entry.revision === filesystemMutationRevision &&
  entry.ranges.some(
    range => range.startLine <= startLine && range.endLine >= endLine
  );

const isScopeBudgetedBroadDiscoveryAction = (toolName: string, input: unknown) =>
  isBroadDiscoveryAction(toolName, input) ||
  isProjectAnalysisBroadDiscoveryAction(toolName, input);

const getBroadDiscoveryScope = (toolName: string, input: unknown) => {
  if (!isScopeBudgetedBroadDiscoveryAction(toolName, input)) {
    return null;
  }
  return normalizeComparedPath(getToolPath(input) ?? ".") || ".";
};

const getScopedBroadDiscoveryBudgetKey = (
  toolName: string,
  input: unknown,
  filesystemMutationRevision: number
) => {
  const scope = getBroadDiscoveryScope(toolName, input);
  return scope ? `${filesystemMutationRevision}:${scope}` : null;
};

const extractEvidencePaths = (
  toolName: string,
  input: unknown,
  message: string
) => {
  const normalized = new Set<string>();
  const action = getToolAction(toolName, input);
  const inputPath = getToolPath(input);
  if (inputPath && HIGH_VALUE_EVIDENCE_ACTIONS.has(action)) {
    normalized.add(normalizeComparedPath(inputPath));
  }
  for (const path of extractPathsFromText(message)) {
    normalized.add(path);
  }
  return Array.from(normalized).filter(Boolean);
};

const recordSearchObservation = (
  searchMemory: SearchMemory,
  toolName: string,
  input: unknown,
  message: string
) => {
  const action = getToolAction(toolName, input);
  const scope = getBroadDiscoveryScope(toolName, input);
  if (scope) {
    searchMemory.searchedScopes.add(scope);
  }

  const evidencePaths = extractEvidencePaths(toolName, input, message);
  for (const path of evidencePaths) {
    searchMemory.discoveredPaths.add(path);
    searchMemory.evidenceSignatures.add(`${action}:${path}`);
    if (isScopeBudgetedBroadDiscoveryAction(toolName, input)) {
      searchMemory.evidenceSignatures.add(`hit:${path}`);
    }
  }

  const directPath = getToolPath(input);
  if (!directPath) {
    return;
  }
  const normalizedPath = normalizeComparedPath(directPath);
  if (!normalizedPath) {
    return;
  }

  if (action.startsWith("lsp_")) {
    if (message.startsWith("[tool error]") && isLspConfigUnavailableMessage(message)) {
      searchMemory.semanticRoutingByPath.set(normalizedPath, {
        provider: isTypeScriptLikePath(normalizedPath) ? "ts" : "text",
        reason: "lsp_unavailable",
      });
      return;
    }
    if (!message.startsWith("[tool error]")) {
      searchMemory.semanticRoutingByPath.set(normalizedPath, {
        provider: "lsp",
        reason: "lsp_available",
      });
      return;
    }
  }

  if (action.startsWith("ts_") && !message.startsWith("[tool error]")) {
    searchMemory.semanticRoutingByPath.set(normalizedPath, {
      provider: "ts",
      reason: "ts_available",
    });
  }
};

const formatSearchMemory = (searchMemory: SearchMemory) => {
  const searchedScopes = Array.from(searchMemory.searchedScopes).sort();
  const discoveredPaths = Array.from(searchMemory.discoveredPaths).sort();
  const semanticRouting = Array.from(searchMemory.semanticRoutingByPath.entries())
    .map(([path, hint]) => ({ path, hint }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const budgetUsage = Array.from(searchMemory.scopedBroadDiscoveryBudget.entries())
    .map(([key, count]) => {
      const separator = key.indexOf(":");
      return {
        scope: separator >= 0 ? key.slice(separator + 1) : key,
        count,
      };
    })
    .sort((left, right) => left.scope.localeCompare(right.scope));

  if (
    searchedScopes.length === 0 &&
    discoveredPaths.length === 0 &&
    semanticRouting.length === 0 &&
    budgetUsage.length === 0
  ) {
    return "";
  }

  const lines: string[] = [];
  if (searchedScopes.length > 0) {
    lines.push(
      `searched scopes: ${formatPathList(searchedScopes, SEARCH_MEMORY_SCOPE_LIMIT)}`
    );
  }
  if (discoveredPaths.length > 0) {
    lines.push(
      `known hit paths: ${formatPathList(discoveredPaths, SEARCH_MEMORY_PATH_LIMIT)}`
    );
  }
  if (budgetUsage.length > 0) {
    lines.push(
      `broad search budgets: ${budgetUsage
        .slice(0, SEARCH_MEMORY_SCOPE_LIMIT)
        .map(entry => `${entry.scope} ${entry.count}/${BROAD_DISCOVERY_SCOPE_BUDGET}`)
        .join(", ")}`
    );
  }
  if (semanticRouting.length > 0) {
    lines.push(
      `semantic routing: ${semanticRouting
        .slice(0, SEARCH_MEMORY_PATH_LIMIT)
        .map(({ path, hint }) => `${path} -> ${hint.provider}`)
        .join(", ")}`
    );
  }

  return lines.join("\n");
};

const captureProgressSnapshot = (
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger,
  searchMemory: SearchMemory,
  filesystemMutationRevision: number
): ProgressSnapshot => ({
  mutationRevision: filesystemMutationRevision,
  phase: uncertainty.phase,
  analysisSignalCount: uncertainty.analysisSignalCount,
  semanticNavigationCount: uncertainty.semanticNavigationCount,
  completedPathCount: ledger.completedPaths.length,
  discoveredPathCount: searchMemory.discoveredPaths.size,
  evidenceCount: searchMemory.evidenceSignatures.size,
});

const didMakeExecutionProgress = (
  before: ProgressSnapshot,
  after: ProgressSnapshot
) =>
  after.mutationRevision > before.mutationRevision ||
  after.phase !== before.phase ||
  after.analysisSignalCount > before.analysisSignalCount ||
  after.semanticNavigationCount > before.semanticNavigationCount ||
  after.completedPathCount > before.completedPathCount ||
  after.discoveredPathCount > before.discoveredPathCount ||
  after.evidenceCount > before.evidenceCount;

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

const isProjectAnalysisBroadDiscoveryAction = (toolName: string, input: unknown) =>
  PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input));

const isProjectAnalysisHighSignalAction = (toolName: string, input: unknown) =>
  PROJECT_ANALYSIS_HIGH_SIGNAL_ACTIONS.has(getToolAction(toolName, input));

const isSemanticNavigationAction = (toolName: string, input: unknown) =>
  SEMANTIC_NAVIGATION_ACTIONS.has(getToolAction(toolName, input));

const taskSuggestsProjectAnalysis = (task: string) =>
  !taskSuggestsWriting(task) && PROJECT_ANALYSIS_TASK_PATTERN.test(task);

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
    : taskSuggestsProjectAnalysis(task)
      ? "project_analysis"
      : "normal";
  return {
    mode,
    phase: "discover",
    discoverBudgetUsed: 0,
    discoverBudgetMax: mode === "project_analysis" ? 3 : 4,
    analysisSignalCount: 0,
    semanticNavigationCount: 0,
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
  if (uncertainty.mode === "normal") {
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

  if (uncertainty.mode === "project_analysis") {
    lines.push(`architecture evidence: ${uncertainty.analysisSignalCount}`);
    lines.push(`semantic navigation steps: ${uncertainty.semanticNavigationCount}`);
  }

  if (uncertainty.mode === "simple_multi_file" && expected > 0) {
    lines.push(`completed: ${completedCount}/${expected}`);
  }
  if (uncertainty.mode === "simple_multi_file" && remainingPaths.length > 0) {
    lines.push(`remaining known paths: ${formatPathList(remainingPaths, 4)}`);
  } else if (uncertainty.mode === "simple_multi_file" && remainingCount > 0) {
    lines.push(`remaining count: ${remainingCount}`);
  }
  if (uncertainty.mode === "simple_multi_file" && ledger.lastCompletedPath) {
    lines.push(`last completed file: ${ledger.lastCompletedPath}`);
  }
  if (uncertainty.mode === "simple_multi_file" && uncertainty.phase === "execute") {
    lines.push(
      "directive: write remaining files directly; do not reread completed files or re-open broad discovery"
    );
  } else if (uncertainty.mode === "simple_multi_file" && uncertainty.phase === "collapse") {
    lines.push(
      "directive: broad exploration is over; continue with the concrete remaining write/edit steps"
    );
  } else if (uncertainty.mode === "simple_multi_file" && uncertainty.phase === "verify") {
    lines.push(
      "directive: verify the written files directly; avoid reopening broad discovery"
    );
  } else if (uncertainty.mode === "project_analysis" && uncertainty.phase === "discover") {
    lines.push(
      "directive: identify a minimal repo snapshot first: README, manifests, and top-level entrypoints"
    );
  } else if (uncertainty.mode === "project_analysis" && uncertainty.phase === "trace") {
    lines.push(
      "directive: trace one main runtime or call chain through a few core files; stop broad directory scans"
    );
  } else if (uncertainty.mode === "project_analysis" && uncertainty.phase === "synthesize") {
    lines.push(
      "directive: synthesize the architecture now: overview, main chain, key modules, and open questions"
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
  if (uncertainty.mode === "project_analysis") {
    return [
      clipRoundPromptText(query, ROUND_PROMPT_TASK_CHAR_LIMIT),
      "",
      "Project analysis memo:",
      "- Goal: explain the project by reconstructing the main runtime chain, not by exhaustively listing files.",
      `- phase: ${uncertainty.phase}`,
      `- broad discovery budget: ${uncertainty.discoverBudgetUsed}/${uncertainty.discoverBudgetMax}`,
      "- Start with one minimal repo snapshot: README, package/manifest files, and top-level entrypoints only.",
      "- Identify likely entrypoints or primary commands before opening many files.",
      "- Trace one main execution/call path through 2-4 core files before widening out.",
      "- Prefer semantic navigation when available through the matching provider for that path.",
      "- If a matching lsp_server covers the path, use lsp_document_symbols/lsp_workspace_symbols/lsp_definition/lsp_references.",
      "- If the path is TS/JS and no matching lsp_server covers it, use ts_hover/ts_definition/ts_references/ts_diagnostics instead.",
      "- Once a concrete source anchor is known, try one semantic navigation step through the matching provider before spending more broad discovery budget.",
      "- Use search_text/find_files mainly for literals, config keys, filenames, or when semantic tools cannot answer the question.",
      "- Prefer read_range, outline_file, and search_text_context over dumping whole large files when they can answer the same question.",
      "- Once entrypoints are known, stop broad directory scans and synthesize the architecture.",
      "- Final summary shape: overall architecture, main execution chain, key modules, and open questions.",
      "- Distinguish confirmed facts from inference. Keep file inventories minimal unless the user explicitly asks for exhaustive coverage.",
      "- Later rounds may include runtime fact sections derived from structured tool metadata. Treat those sections as authoritative current state; do not restart discovery just because the raw tool text is abbreviated.",
      `Original user task: ${clipRoundPromptText(originalTask, ROUND_PROMPT_TASK_CHAR_LIMIT)}`,
    ].join("\n");
  }

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
    "- Later rounds may include runtime fact sections derived from structured tool metadata. Treat those sections as authoritative current state; do not rerun reads/searches just because the visible tool text is short.",
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

const LIKELY_SEMANTIC_SOURCE_PATH_PATTERN =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|vue|svelte|c|cc|cpp|h|hpp)$/i;

const isLikelySemanticSourcePath = (path: string) =>
  LIKELY_SEMANTIC_SOURCE_PATH_PATTERN.test(path);

const TYPESCRIPT_LIKE_PATH_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

const isTypeScriptLikePath = (path: string) => TYPESCRIPT_LIKE_PATH_PATTERN.test(path);

const isLspConfigUnavailableMessage = (message: string) =>
  /LSP config error:/i.test(message) &&
  /(no configured LSP server matches|no lsp_servers are configured)/i.test(message);

const getSemanticProviderForPath = (
  path: string,
  searchMemory: SearchMemory
): SemanticProvider => {
  const normalized = normalizeComparedPath(path);
  const remembered = searchMemory.semanticRoutingByPath.get(normalized);
  if (remembered) {
    return remembered.provider;
  }
  return isTypeScriptLikePath(normalized) ? "ts" : "lsp";
};

const describeSemanticProviderRoute = (
  provider: SemanticProvider,
  paths: string[]
) => {
  const preview = formatPathList(paths, 3);
  if (provider === "ts") {
    return `Use ts_hover/ts_definition/ts_references/ts_diagnostics for ${preview}.`;
  }
  if (provider === "lsp") {
    return `Use lsp_document_symbols/lsp_workspace_symbols/lsp_definition/lsp_references for ${preview}.`;
  }
  return `Use outline_file/read_range/search_text_context for ${preview}.`;
};

const getProjectAnalysisSemanticAnchors = (
  uncertainty: UncertaintyState,
  searchMemory: SearchMemory,
  accumulatedToolResults: string[],
  roundToolResults: string[]
) =>
  normalizeUniquePaths([
    ...uncertainty.explicitTaskPaths,
    ...searchMemory.discoveredPaths,
    ...getRecentDiscoveredPaths(accumulatedToolResults, roundToolResults),
  ]).filter(isLikelySemanticSourcePath);

const shouldAllowTargetedSourceRead = (
  path: string | undefined,
  uncertainty: UncertaintyState,
  searchMemory: SearchMemory,
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

  if (searchMemory.discoveredPaths.has(normalizedPath)) {
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
  searchMemory: SearchMemory,
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
    ...searchMemory.discoveredPaths,
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
  message: string,
  ledger: MultiFileProgressLedger
) => {
  if (uncertainty.mode === "project_analysis") {
    const broadDiscovery = isProjectAnalysisBroadDiscoveryAction(toolName, input);
    const hasConcretePath =
      Boolean(getToolPath(input)) || extractPathsFromText(message).length > 0;
    const highSignal =
      isProjectAnalysisHighSignalAction(toolName, input) || hasConcretePath;
    if (isSemanticNavigationAction(toolName, input)) {
      uncertainty.semanticNavigationCount += 1;
    }

    if (highSignal) {
      uncertainty.analysisSignalCount += 1;
    }

    if (
      uncertainty.phase === "discover" &&
      (!broadDiscovery ||
        uncertainty.discoverBudgetUsed >= uncertainty.discoverBudgetMax ||
        hasConcretePath)
    ) {
      uncertainty.phase = "trace";
    }

    if (uncertainty.phase === "trace" && uncertainty.analysisSignalCount >= 3) {
      uncertainty.phase = "synthesize";
    }
    return;
  }

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
  progressLedger: MultiFileProgressLedger,
  searchMemory: SearchMemory
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

  const discoveredPaths = Array.from(searchMemory.discoveredPaths).sort();
  if (discoveredPaths.length > 0) {
    nudges.push(
      `Known search hits already exist: ${formatPathList(discoveredPaths, 4)}. Continue from one of those concrete paths instead of reopening broad search.`
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
  uncertainty: UncertaintyState,
  searchMemory: SearchMemory,
  readLedger: Map<string, FileReadLedgerEntry>,
  filesystemMutationRevision: number
) => {
  const heuristicNudges = buildHeuristicNudges(
    originalTask,
    toolResults,
    recentConfirmedFileMutations,
    progressLedger,
    searchMemory
  );
  const recentMutationFacts = formatRecentConfirmedFileMutations(
    recentConfirmedFileMutations
  );
  const multiFileProgressFacts = formatMultiFileProgressLedger(progressLedger);
  const searchMemoryFacts = formatSearchMemory(searchMemory);
  const fileReadLedgerFacts = formatFileReadLedger(
    readLedger,
    filesystemMutationRevision
  );
  const executionState = formatExecutionState(uncertainty, progressLedger);
  const analysisRules =
    uncertainty.mode === "project_analysis"
      ? [
          "Project analysis rules:",
          "- Prefer entrypoints, manifests, and bootstrap/runtime files over exhaustive file inventories.",
          "- After one lightweight repo snapshot, trace one main execution or call chain through a few core files.",
          "- Prefer lsp_/ts_ semantic tools for symbols, definitions, references, and document structure before falling back to text search.",
          "- Use search_text/find_files for literals, filenames, or config strings; not as the default way to chase code structure.",
          "- Use targeted reads and structure tools before opening additional unrelated files.",
          "- Once the main chain is clear enough, stop broad exploration and synthesize the architecture.",
          "- Organize the final answer around overall architecture, main chain, key modules, and open questions.",
        ].join("\n")
      : "";
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
    "For symbol lookup, definition lookup, references, call chains, and file structure, prefer lsp_/ts_ semantic tools before broad list_dir/find_files/search_text exploration when those tools can answer the question.",
    "Use search_text/find_files mainly for literals, filenames, config keys, or as a fallback when semantic navigation cannot answer the request.",
    "Runtime fact sections below may be synthesized from structured tool metadata, including approved review results. Treat `Recent confirmed file mutations`, `Search memory`, and `File read ledger` as authoritative current state even if the raw tool_result text is abbreviated.",
    "After an approval resumes, continue from those runtime facts. Do not rerun the same read/search/write only because the approval text itself was short or opaque.",
    "Execution style rules:",
    "- Continue directly from the latest confirmed result; do not re-announce the whole plan each step.",
    "- Keep progress narration minimal and non-repetitive. Avoid repeated lines like 'I will now...'.",
    "- For multi-file create/edit tasks, batch similar writes naturally and move forward without repeated preambles.",
    "- Keep assistant wording in the same language as the user request unless the user asks to switch.",
    analysisRules,
    recentMutationFacts
      ? `Recent confirmed file mutations:\n${recentMutationFacts}`
      : "",
    multiFileProgressFacts
      ? `Multi-file progress ledger:\n${multiFileProgressFacts}`
      : "",
    searchMemoryFacts ? `Search memory:\n${searchMemoryFacts}` : "",
    fileReadLedgerFacts ? `File read ledger:\n${fileReadLedgerFacts}` : "",
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
  const normalizedQuery = normalizeQueryInput(query);
  let state = createQuerySessionState();
  const task = originalTask ?? normalizedQuery.text;
  let filesystemMutationRevision = 0;
  let recentConfirmedFileMutations: ConfirmedFileMutation[] = [];
  let progressLedger = createInitialMultiFileProgressLedger(task);
  const uncertainty = createUncertaintyState(task, progressLedger);
  const searchMemory = createSearchMemory();
  const readLedger = new Map<string, FileReadLedgerEntry>();
  let latestConfirmedFileMutation: ConfirmedFileMutation | null = null;
  let repeatedImmediatePostWriteReadCount = 0;
  let nonProgressRounds = 0;
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
    metadata: unknown,
    accumulatedToolResults: string[],
    roundToolResults: string[]
  ) => {
    if (isTargetedSourceReadAction(toolName, input)) {
      maybeMarkExplicitSourceRead(uncertainty, getToolPath(input));
    }
    const confirmedFileMutation = getConfirmedFileMutation(
      toolName,
      input,
      message,
      metadata
    );
    if (confirmedFileMutation) {
      recentConfirmedFileMutations = pushRecentConfirmedFileMutation(
        recentConfirmedFileMutations,
        confirmedFileMutation
      );
      clearReadLedgerForMutation(readLedger, confirmedFileMutation);
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
        message,
        progressLedger
      );
    }
    const blockedReason = getBlockedReason(
      task,
      uncertainty,
      progressLedger,
      searchMemory,
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

    const streamUrl = await transport.requestStreamUrl({
      text: roundPrompt,
      attachments: normalizedQuery.attachments,
    });
    let completed = false;
    let sawToolCall = false;
    let streamOpened = false;
    let visibleAnswerChars = 0;
    const toolResults: string[] = [];
    let latestUsage: TokenUsage | null = null;
    let usageReported = false;
    const roundProgressBefore = captureProgressSnapshot(
      uncertainty,
      progressLedger,
      searchMemory,
      filesystemMutationRevision
    );
    let roundUsedProgressSensitiveTool = false;
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

    const finalizeRoundProgress = () => {
      const roundProgressAfter = captureProgressSnapshot(
        uncertainty,
        progressLedger,
        searchMemory,
        filesystemMutationRevision
      );
      if (didMakeExecutionProgress(roundProgressBefore, roundProgressAfter)) {
        nonProgressRounds = 0;
        return false;
      }
      if (!roundUsedProgressSensitiveTool) {
        nonProgressRounds = 0;
        return false;
      }
      nonProgressRounds += 1;
      if (nonProgressRounds < MAX_NON_PROGRESS_ROUNDS) {
        return false;
      }
      emitRoundText(
        [
          "[execution paused]",
          `No new file mutation, high-value evidence, or phase progression was recorded across ${nonProgressRounds} consecutive search/read rounds.`,
          "Stop broad searching and continue from known paths, or ask for a narrower target.",
        ].join("\n")
      );
      return true;
    };

    const createOneShotResume = (
      resumeImpl: (toolResult: RunQuerySessionToolResult) => Promise<RunQuerySessionResult>
    ): RunQuerySessionResult => {
      flushUsage();
      let resumePromise: Promise<RunQuerySessionResult> | null = null;
      return {
        status: "suspended",
        resume: toolResult => {
          if (!resumePromise) {
            resumePromise = resumeImpl(normalizeResumeToolResult(toolResult));
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
            isScopeBudgetedBroadDiscoveryAction(event.toolName, event.input) ||
            isTargetedSourceReadAction(event.toolName, event.input) ||
            isProjectAnalysisHighSignalAction(event.toolName, event.input)
          ) {
            roundUsedProgressSensitiveTool = true;
          }

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
                searchMemory,
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
            uncertainty.mode === "project_analysis" &&
            isProjectAnalysisBroadDiscoveryAction(event.toolName, event.input)
          ) {
            const semanticAnchors =
              uncertainty.semanticNavigationCount === 0
                ? getProjectAnalysisSemanticAnchors(
                    uncertainty,
                    searchMemory,
                    accumulatedToolResults,
                    toolResults
                  )
                : [];
            if (semanticAnchors.length > 0) {
              if (uncertainty.phase === "discover") {
                uncertainty.phase = "trace";
              }
              loopCorrection = [
                "Project analysis semantic navigation preferred:",
                `Skipped ${action} ${toolPath ?? "."} because concrete source anchors are already known: ${formatPathList(semanticAnchors, 3)}.`,
                "Before more broad search, use lsp_document_symbols/lsp_workspace_symbols for structure or lsp_definition/ts_definition/lsp_references/ts_references to trace the main code path.",
              ].join("\n");
              toolResults.push(
                [
                  `[tool skipped] ${action} ${toolPath ?? "."}`.trim(),
                  `Skipped ${action} because semantic navigation should come first once concrete source anchors are known.`,
                  `Known source anchors: ${formatPathList(semanticAnchors, 3)}.`,
                  "Try lsp_document_symbols/lsp_workspace_symbols or definition/reference navigation before another broad search.",
                ].join("\n")
              );
              continue;
            }
            if (uncertainty.phase === "discover") {
              if (uncertainty.discoverBudgetUsed >= uncertainty.discoverBudgetMax) {
                uncertainty.phase = "trace";
              } else {
                uncertainty.discoverBudgetUsed += 1;
              }
            }

            if (uncertainty.phase !== "discover") {
              const knownPaths = getRecentDiscoveredPaths(
                accumulatedToolResults,
                toolResults
              );
              loopCorrection = [
                "Project analysis exploration collapsed:",
                `Skipped ${action} ${toolPath ?? "."} because the initial repo snapshot budget is already exhausted.`,
                knownPaths.length > 0
                  ? `Trace the architecture through known anchors instead: ${formatPathList(knownPaths, 4)}.`
                  : "Trace the architecture through README, manifest files, or already-read entrypoints instead of relisting directories.",
              ].join("\n");
              toolResults.push(
                [
                  `[tool skipped] ${action} ${toolPath ?? "."}`.trim(),
                  `Skipped ${action} because broad repo exploration should stop after the initial snapshot.`,
                  knownPaths.length > 0
                    ? `Continue from known anchors: ${formatPathList(knownPaths, 4)}.`
                    : "Continue with targeted entrypoint tracing and architecture synthesis.",
                ].join("\n")
              );
              continue;
            }
          }

          if (
            uncertainty.mode === "simple_multi_file" &&
            isTargetedSourceReadAction(event.toolName, event.input) &&
            !shouldAllowTargetedSourceRead(
              toolPath,
              uncertainty,
              searchMemory,
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

          const readLedgerEntry = getReadLedgerEntry(readLedger, event.input);
          if (
            readLedgerEntry &&
            readLedgerEntry.revision === filesystemMutationRevision &&
            event.toolName === "file"
          ) {
            if (
              action === "read_file" &&
              readLedgerEntry.fullyRead &&
              !taskSuggestsPostWriteVerification(task)
            ) {
              const repeatedPath = getToolPath(event.input) ?? readLedgerEntry.path;
              loopCorrection = [
                "Repeated full-file read blocked:",
                `${repeatedPath} was already fully read in the current file revision.`,
                "Do not read the whole file again unless it changes. Continue from the known content or switch to a different file.",
              ].join("\n");
              toolResults.push(
                [
                  `[tool skipped] read_file ${repeatedPath}`,
                  `Skipped read_file for ${repeatedPath} because the current revision was already read completely.`,
                  "Reuse the previous read result or move to the next concrete file instead of rereading the whole file.",
                ].join("\n")
              );
              continue;
            }

            if (
              action === "read_file" &&
              !readLedgerEntry.fullyRead &&
              typeof readLedgerEntry.nextSuggestedStartLine === "number"
            ) {
              const repeatedPath = getToolPath(event.input) ?? readLedgerEntry.path;
              loopCorrection = [
                "Whole-file reread blocked after partial reads:",
                `${repeatedPath} already has partial read coverage in the current revision.`,
                `Continue with read_range starting at line ${readLedgerEntry.nextSuggestedStartLine} instead of restarting from the top.`,
              ].join("\n");
              toolResults.push(
                [
                  `[tool skipped] read_file ${repeatedPath}`,
                  `Skipped read_file for ${repeatedPath} because this file already has partial read coverage in the current revision.`,
                  `Use read_range with startLine ${readLedgerEntry.nextSuggestedStartLine} to continue from the next unread region.`,
                ].join("\n")
              );
              continue;
            }

            if (action === "read_range") {
              const record = toRecord(event.input);
              const startLine = record ? pickFiniteNumber(record, "startLine") : undefined;
              const endLine = record ? pickFiniteNumber(record, "endLine") : undefined;
              if (
                typeof startLine === "number" &&
                typeof endLine === "number" &&
                isReadRangeCoveredByLedger(
                  readLedgerEntry,
                  startLine,
                  endLine,
                  filesystemMutationRevision
                )
              ) {
                const repeatedPath = getToolPath(event.input) ?? readLedgerEntry.path;
                loopCorrection = [
                  "Repeated range read blocked:",
                  `${repeatedPath} lines ${startLine}-${endLine} were already read in the current file revision.`,
                  "Continue from the next unread range or switch to a different target.",
                ].join("\n");
                toolResults.push(
                  [
                    `[tool skipped] read_range ${repeatedPath}`,
                    `Skipped read_range ${startLine}-${endLine} for ${repeatedPath} because that exact range is already covered in the current revision.`,
                    typeof readLedgerEntry.nextSuggestedStartLine === "number"
                      ? `Continue with read_range starting at line ${readLedgerEntry.nextSuggestedStartLine}.`
                      : "Continue with a new unread range or another file.",
                  ].join("\n")
                );
                continue;
              }
            }
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
          const scopedBudgetKey = getScopedBroadDiscoveryBudgetKey(
            event.toolName,
            event.input,
            filesystemMutationRevision
          );
          if (scopedBudgetKey) {
            const scopedBudgetUsed =
              searchMemory.scopedBroadDiscoveryBudget.get(scopedBudgetKey) ?? 0;
            if (scopedBudgetUsed >= BROAD_DISCOVERY_SCOPE_BUDGET) {
              const repeatedScope = getBroadDiscoveryScope(event.toolName, event.input) ?? ".";
              if (uncertainty.mode === "simple_multi_file" && uncertainty.phase === "discover") {
                uncertainty.phase = "collapse";
              }
              if (uncertainty.mode === "project_analysis" && uncertainty.phase === "discover") {
                uncertainty.phase = "trace";
              }
              loopCorrection = [
                "Broad discovery budget exhausted:",
                `Skipped ${action} ${repeatedScope} because this scope already used ${scopedBudgetUsed}/${BROAD_DISCOVERY_SCOPE_BUDGET} broad discovery steps.`,
                "Use a known hit path or move to read_range/read_file/outline_file instead of reopening broad search in the same scope.",
              ].join("\n");
              toolResults.push(
                [
                  `[tool skipped] ${action} ${repeatedScope}`.trim(),
                  `Skipped ${action} because broad search budget for ${repeatedScope} is already exhausted.`,
                  "Continue from known paths or switch to targeted reads instead of another broad search.",
                ].join("\n")
              );
              continue;
            }
            searchMemory.scopedBroadDiscoveryBudget.set(
              scopedBudgetKey,
              scopedBudgetUsed + 1
            );
            const broadScope = getBroadDiscoveryScope(event.toolName, event.input);
            if (broadScope) {
              searchMemory.searchedScopes.add(broadScope);
            }
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
          if (
            didApplyFileMutation(
              event.toolName,
              event.input,
              toolResult.message,
              toolResult.metadata
            )
          ) {
            filesystemMutationRevision += 1;
            loopCorrection = "";
          }
          applyToolResultSideEffects(
            event.toolName,
            event.input,
            toolResult.message,
            toolResult.metadata,
            accumulatedToolResults,
            toolResults
          );
          updateReadLedgerFromToolResult(
            readLedger,
            event.toolName,
            event.input,
            toolResult.message,
            toolResult.metadata,
            filesystemMutationRevision
          );
          recordSearchObservation(
            searchMemory,
            event.toolName,
            event.input,
            toolResult.message
          );
          if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
            emitRoundText(`${uncertainty.blockedReason}\n`);
            return completeRound();
          }
          if (toolResult.reviewMode) {
            dispatch({ type: "suspended" });
            return createOneShotResume(async resumedToolResult => {
              if (
                didApplyFileMutation(
                  event.toolName,
                  event.input,
                  resumedToolResult.message,
                  resumedToolResult.metadata,
                )
              ) {
                filesystemMutationRevision += 1;
                loopCorrection = "";
              }
              applyToolResultSideEffects(
                event.toolName,
                event.input,
                resumedToolResult.message,
                resumedToolResult.metadata,
                accumulatedToolResults,
                toolResults
              );
              updateReadLedgerFromToolResult(
                readLedger,
                event.toolName,
                event.input,
                resumedToolResult.message,
                resumedToolResult.metadata,
                filesystemMutationRevision
              );
              recordSearchObservation(
                searchMemory,
                event.toolName,
                event.input,
                resumedToolResult.message
              );
              if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
                emitRoundText(`${uncertainty.blockedReason}\n`);
                return completeRound();
              }
              if (finalizeRoundProgress()) {
                return completeRound();
              }
              const nextToolResults = [
                ...accumulatedToolResults,
                ...toolResults,
                `[tool_result] ${event.toolName}\n${resumedToolResult.message}`.trim(),
              ];
              const nextPrompt = buildRoundPrompt(
                task,
                nextToolResults,
                loopCorrection,
                recentConfirmedFileMutations,
                progressLedger,
                uncertainty,
                searchMemory,
                readLedger,
                filesystemMutationRevision
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
            uncertainty,
            searchMemory,
            readLedger,
            filesystemMutationRevision
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
          uncertainty,
          searchMemory,
          readLedger,
          filesystemMutationRevision
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
    if (finalizeRoundProgress()) {
      return completeRound();
    }
    const nextPrompt = buildRoundPrompt(
      task,
      accumulatedToolResults,
      loopCorrection,
      recentConfirmedFileMutations,
      progressLedger,
      uncertainty,
      searchMemory,
      readLedger,
      filesystemMutationRevision
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
      buildInitialExecutionMemo(
        normalizedQuery.text,
        task,
        uncertainty,
        progressLedger
      ),
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
