import {
  parseStreamChunk,
  type QueryCompletionEvent,
} from "../../query/streamProtocol";
import { parseAssistantPlanUpdate } from "../../session/executionPlan";
import {
  createQuerySessionState,
  querySessionReducer,
  type QuerySessionDispatch,
} from "../../query/sessionMachine";
import { DEFAULT_QUERY_MAX_TOOL_STEPS } from "../../../shared/runtimeDefaults";
import {
  normalizeQueryInput,
} from "../../query/transport";
import type { TokenUsage } from "../../query/tokenUsage";
import type {
  RunQuerySessionParams,
  RunQuerySessionResult,
  RunQuerySessionToolResult,
} from "./ExecutionTypes";
import type {
  ConfirmedFileMutation,
  FileReadLedgerEntry,
  MultiFileProgressLedger,
  RunRoundsOptions,
  SearchMemory,
  SemanticProvider,
  SemanticRoutingHint,
  UncertaintyMode,
  UncertaintyPhase,
  UncertaintyState,
} from "./ExecutionSnapshot";
import * as ProgressTracker from "./ProgressTracker";
import * as ToolObservationStore from "./ToolObservationStore";

const COMPLETED_RESULT: RunQuerySessionResult = { status: "completed" };
const CANCELLED_COMPLETION_EVENT: QueryCompletionEvent = {
  type: "completion",
  source: "runtime",
  reason: "cancelled",
  detail: "The active request was cancelled by the user.",
  expected: true,
};
const SILENT_REVIEW_RESUME_RECOVERY_NOTE = [
  "The approved tool result above was applied successfully.",
  "The previous continuation ended without any assistant output or further tool action.",
  "Continue the same task now.",
  "Either take the next concrete step or provide the final answer explicitly; do not end silently.",
].join("\n");

const LATE_TOOL_CALL_VISIBLE_ANSWER_CHAR_GUARD = 200;
const MAX_NON_PROGRESS_CHATTER_CHARS = 240;
const BROAD_DISCOVERY_SCOPE_BUDGET = 3;
const ROUND_PROMPT_TASK_CHAR_LIMIT = 12000;
const ROUND_PROMPT_TOOL_RESULT_CHAR_LIMIT = 16000;
const ROUND_PROMPT_TOOL_RESULT_ITEM_CHAR_LIMIT = 3000;
const ROUND_PROMPT_TOOL_RESULT_KEEP_LIMIT = 8;
const PLAN_EXECUTION_AUTO_CONTINUE_LIMIT = 2;
const PLAN_EXECUTION_PROMPT_MARKER =
  "Continue by executing the active execution plan.";

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
  "read_files",
  "read_range",
  "read_json",
  "read_yaml",
]);

const ACTIONABLE_PRE_MUTATION_ACTIONS = new Set([
  ...TARGETED_SOURCE_READ_ACTIONS,
  "outline_file",
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

const SELF_NARRATION_MARKER_PATTERN =
  /\b(?:let me|i(?:'ll| will)|i should|i need to)\b|(?:我来|我先|让我|我会|先看|先读|先检查|看一下|读一下|继续看|继续读)/giu;

const LONG_REPETITIVE_CHATTER_VISIBLE_CHAR_THRESHOLD = 140;
const LONG_REPETITIVE_CHATTER_MARKER_THRESHOLD = 3;

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

const pickFiniteNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const pickTrimmedString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const pickBoolean = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
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

  const parts =
    normalizedResults.length > selected.length
      ? [
          "[tool results truncated] older results omitted to stay within the prompt budget.",
          ...selected,
        ]
      : selected;

  return parts.join("\n\n");
};

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

const formatPathList = (paths: string[], maxItems = 5) => {
  if (paths.length === 0) {
    return "(none)";
  }
  const visible = paths.slice(0, maxItems).join(", ");
  const hidden = paths.length - Math.min(paths.length, maxItems);
  return hidden > 0 ? `${visible} (+${hidden} more)` : visible;
};

const truncatePreview = (value: string, maxLength = 88) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const formatQuotedPreview = (value: string, maxLength = 40) =>
  JSON.stringify(truncatePreview(value, maxLength));

const getToolDisplayName = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return toolName === "file" && action ? action : toolName;
};

const buildToolStatusMessage = (toolName: string, input: unknown) => {
  const displayName = getToolDisplayName(toolName, input);
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

const isScopeBudgetedBroadDiscoveryAction = (toolName: string, input: unknown) =>
  BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input)) ||
  PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input));

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

const isReadFileAction = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "read_file";

const isImmediateRedundantPostWriteRead = (
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

const taskSuggestsProjectAnalysis = (task: string) =>
  !taskSuggestsWriting(task) && PROJECT_ANALYSIS_TASK_PATTERN.test(task);

const WRITE_FOCUS_TASK_PATTERN =
  /(\bcreate\b|\bwrite\b|\badd\b|\bappend\b|\bfill\b|\bimplement\b|\bfix\b|\bupdate\b|\bmodify\b|\bpatch\b|\bsave\b|\bgenerate\b|\bsplit\b|\bmodulari(?:s|z)e\b|\breorganize\b|\bclassify\b|\bmigrate\b|补|写|创建|修复|更新|修改|实现|填充|补充|写入|拆分|模块化|整理|分类|迁移)/i;

const taskShouldUseWriteFocus = (task: string) =>
  WRITE_FOCUS_TASK_PATTERN.test(task) && !taskSuggestsProjectAnalysis(task);

const taskSuggestsSimpleMultiFile = (
  task: string,
  ledger: MultiFileProgressLedger
) =>
  taskSuggestsWriting(task) &&
  (ProgressTracker.getLedgerExpectedFileCount(ledger) > 1 ||
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
    writeFocus: taskShouldUseWriteFocus(task),
    mutationStarted: false,
    discoverBudgetUsed: 0,
    discoverBudgetMax: mode === "project_analysis" ? 3 : 4,
    analysisSignalCount: 0,
    semanticNavigationCount: 0,
    nonProgressAutoContinueUsed: false,
    nonProgressAutoContinueCount: 0,
    explicitSourceReads: new Set<string>(),
    explicitTaskPaths: new Set(extractExplicitTaskPaths(task)),
    enoughToActPaths: new Set<string>(),
    targetedReadStreakPath: null,
    targetedReadStreakCount: 0,
    stalledTargetedReadPaths: new Set<string>(),
    verifyRequested: taskSuggestsPostWriteVerification(task),
    blockedReason: null,
  };
};

const formatExecutionState = (
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger
) => {
  if (uncertainty.mode === "normal" && !uncertainty.writeFocus) {
    return "";
  }

  const expected = ProgressTracker.getLedgerExpectedFileCount(ledger);
  const completedCount = ledger.completedPaths.length;
  const remainingPaths = ProgressTracker.getLedgerRemainingPaths(ledger);
  const remainingCount = ProgressTracker.getLedgerRemainingCount(ledger);
  const explicitPaths = Array.from(uncertainty.explicitTaskPaths).sort();
  const lines = [
    "Execution state:",
    `mode: ${
      uncertainty.mode === "normal" && uncertainty.writeFocus
        ? "write_focus"
        : uncertainty.mode
    }`,
    `phase: ${uncertainty.phase}`,
    `broad discovery budget: ${uncertainty.discoverBudgetUsed}/${uncertainty.discoverBudgetMax}`,
  ];

  if (uncertainty.writeFocus) {
    lines.push(
      `write focus: ${uncertainty.mutationStarted ? "mutation_started" : "pre_mutation"}`
    );
    if (explicitPaths.length > 0) {
      lines.push(`explicit task paths: ${formatPathList(explicitPaths, 4)}`);
    }
    if (
      !uncertainty.mutationStarted &&
      uncertainty.enoughToActPaths.size > 0
    ) {
      lines.push(
        `enough_to_act paths: ${formatPathList(
          Array.from(uncertainty.enoughToActPaths).sort(),
          4
        )}`
      );
    }
    if (
      !uncertainty.mutationStarted &&
      uncertainty.stalledTargetedReadPaths.size > 0
    ) {
      lines.push(
        `stalled read paths: ${formatPathList(
          Array.from(uncertainty.stalledTargetedReadPaths).sort(),
          4
        )}`
      );
    }
  }

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

  if (
    uncertainty.writeFocus &&
    !uncertainty.mutationStarted &&
    uncertainty.phase !== "blocked"
  ) {
    lines.push(
      uncertainty.enoughToActPaths.size > 0
        ? "directive: enough facts already exist for the actionable path; stop reading it and move directly to edit/write/apply_patch"
        : uncertainty.stalledTargetedReadPaths.size > 0
        ? "directive: stop rereading stalled paths; switch to outline_file/search_text_context or a smaller read_range around the suspected lines"
        : "directive: use at most one targeted source read, then move directly to the next write/edit step"
    );
  } else if (
    uncertainty.writeFocus &&
    uncertainty.mutationStarted &&
    uncertainty.phase !== "blocked"
  ) {
    lines.push(
      "directive: continue remaining writes, explicit verification, or finalize; do not drift back into broad discovery"
    );
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

  if (!uncertainty.writeFocus) {
    if (uncertainty.mode !== "simple_multi_file") {
      return clipRoundPromptText(query, ROUND_PROMPT_TASK_CHAR_LIMIT);
    }
  }

  if (!uncertainty.writeFocus && uncertainty.mode !== "simple_multi_file") {
    return clipRoundPromptText(query, ROUND_PROMPT_TASK_CHAR_LIMIT);
  }

  const expected = ProgressTracker.getLedgerExpectedFileCount(ledger);
  const explicitPaths = Array.from(uncertainty.explicitTaskPaths).sort();
  const memo = [
    clipRoundPromptText(query, ROUND_PROMPT_TASK_CHAR_LIMIT),
    "",
    "Execution memo:",
    uncertainty.writeFocus ? "- This is an explicit code-change task." : "",
    uncertainty.mode === "simple_multi_file" ? "- This is a simple multi-file task." : "",
    uncertainty.writeFocus && uncertainty.mode !== "simple_multi_file"
      ? "- This is a focused write/edit task."
      : "",
    `- phase: ${uncertainty.phase}`,
    `- broad discovery budget: ${uncertainty.discoverBudgetUsed}/${uncertainty.discoverBudgetMax}`,
    expected > 0 ? `- expected files: ${expected}` : "",
    uncertainty.writeFocus && explicitPaths.length > 0
      ? `- explicit task paths: ${formatPathList(explicitPaths, 4)}`
      : "",
    ledger.targetPaths.length > 1
      ? `- known target paths: ${formatPathList(ledger.targetPaths, 4)}`
      : "",
    uncertainty.writeFocus
      ? "- If target paths are already known, use at most one targeted source read before the first write/edit."
      : "- If enough context is already clear, move straight to the remaining writes/edits.",
    uncertainty.writeFocus
      ? "- Once enough context is clear, move directly to create_file/write_file/edit_file/apply_patch."
      : "- If several similar writes are needed, emit multiple tool_call actions in the same round before the final answer.",
    uncertainty.writeFocus
      ? "- Do not spend extra turns re-checking the same path or directory before writing."
      : "",
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

  const normalizedPath = normalizeComparedPath(path);
  const recentlyDiscovered = new Set(
    getRecentDiscoveredPaths(accumulatedToolResults, roundToolResults)
  );

  if (
    uncertainty.writeFocus &&
    !uncertainty.mutationStarted &&
    uncertainty.enoughToActPaths.has(normalizedPath)
  ) {
    return false;
  }

  if (
    uncertainty.writeFocus &&
    !uncertainty.mutationStarted &&
    uncertainty.stalledTargetedReadPaths.has(normalizedPath)
  ) {
    return false;
  }

  if (uncertainty.writeFocus && !uncertainty.mutationStarted && !uncertainty.verifyRequested) {
    const pathIsConcreteTarget =
      uncertainty.explicitTaskPaths.has(normalizedPath) ||
      recentlyDiscovered.has(normalizedPath) ||
      searchMemory.discoveredPaths.has(normalizedPath);
    if (pathIsConcreteTarget) {
      return !uncertainty.explicitSourceReads.has(normalizedPath);
    }
  }

  if (uncertainty.mode !== "simple_multi_file") {
    return true;
  }

  if (uncertainty.phase === "verify" && uncertainty.verifyRequested) {
    return true;
  }

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

const resetEnoughToActState = (uncertainty: UncertaintyState) => {
  uncertainty.enoughToActPaths.clear();
};

const resetTargetedReadFailureTracking = (uncertainty: UncertaintyState) => {
  uncertainty.targetedReadStreakPath = null;
  uncertainty.targetedReadStreakCount = 0;
  uncertainty.stalledTargetedReadPaths.clear();
};

const maybeMarkEnoughToActPath = (
  uncertainty: UncertaintyState,
  toolName: string,
  input: unknown,
  message: string,
  searchMemory: SearchMemory,
  accumulatedToolResults: string[],
  roundToolResults: string[]
) => {
  if (
    !uncertainty.writeFocus ||
    uncertainty.mutationStarted ||
    uncertainty.verifyRequested ||
    message.startsWith("[tool error]")
  ) {
    return;
  }

  const action = getToolAction(toolName, input);
  if (!ACTIONABLE_PRE_MUTATION_ACTIONS.has(action)) {
    return;
  }

  const path = getToolPath(input);
  if (!path) {
    return;
  }
  const normalizedPath = normalizeComparedPath(path);
  if (!normalizedPath || !isLikelySemanticSourcePath(normalizedPath)) {
    return;
  }

  const recentlyDiscovered = new Set(
    getRecentDiscoveredPaths(accumulatedToolResults, roundToolResults)
  );
  const isConcreteTarget =
    uncertainty.explicitTaskPaths.has(normalizedPath) ||
    searchMemory.discoveredPaths.has(normalizedPath) ||
    recentlyDiscovered.has(normalizedPath);
  if (!isConcreteTarget) {
    return;
  }

  uncertainty.enoughToActPaths.add(normalizedPath);
};

const updateTargetedReadFailureTracking = (
  uncertainty: UncertaintyState,
  toolName: string,
  input: unknown
) => {
  if (!uncertainty.writeFocus || uncertainty.mutationStarted || uncertainty.verifyRequested) {
    return;
  }

  if (!isTargetedSourceReadAction(toolName, input)) {
    uncertainty.targetedReadStreakPath = null;
    uncertainty.targetedReadStreakCount = 0;
    return;
  }

  const path = getToolPath(input);
  if (!path) {
    uncertainty.targetedReadStreakPath = null;
    uncertainty.targetedReadStreakCount = 0;
    return;
  }
  const normalizedPath = normalizeComparedPath(path);
  if (!normalizedPath) {
    uncertainty.targetedReadStreakPath = null;
    uncertainty.targetedReadStreakCount = 0;
    return;
  }

  if (uncertainty.targetedReadStreakPath === normalizedPath) {
    uncertainty.targetedReadStreakCount += 1;
  } else {
    uncertainty.targetedReadStreakPath = normalizedPath;
    uncertainty.targetedReadStreakCount = 1;
  }

  if (uncertainty.targetedReadStreakCount >= 2) {
    uncertainty.stalledTargetedReadPaths.add(normalizedPath);
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

  const expected = ProgressTracker.getLedgerExpectedFileCount(ledger);
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
      ProgressTracker.isMeaningfulMultiFileLedger(ledger))
  ) {
    uncertainty.phase = "collapse";
    return;
  }

  if (
    uncertainty.phase === "execute" &&
    ProgressTracker.getLedgerRemainingCount(ledger) === 0 &&
    uncertainty.verifyRequested
  ) {
    uncertainty.phase = "verify";
  }
};

const buildNonProgressStopMessage = (
  ledger: MultiFileProgressLedger
) => {
  const remainingPaths = ProgressTracker.getLedgerRemainingPaths(ledger);
  const remainingCount = ProgressTracker.getLedgerRemainingCount(ledger);
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

const extractPlanExecutionTargetStepId = (query: string) => {
  const match = query.match(/Focus on step ([^:\n]+):/);
  return match?.[1]?.trim() || "";
};

const shouldAutoContinuePlanExecution = (
  assistantText: string,
  targetStepId: string,
  autoContinueCount: number
) => {
  if (autoContinueCount >= PLAN_EXECUTION_AUTO_CONTINUE_LIMIT) {
    return false;
  }

  const parsed = parseAssistantPlanUpdate(assistantText);
  if (!parsed.plan) {
    return false;
  }

  const targetStep = targetStepId
    ? parsed.plan.steps.find(step => step.id === targetStepId)
    : (parsed.plan.steps.find(step => step.status === "in_progress") ??
        parsed.plan.steps.find(step => step.status === "pending"));

  if (!targetStep) {
    return false;
  }

  return (
    targetStep.status === "in_progress" ||
    targetStep.status === "pending"
  );
};

const buildPlanExecutionAutoContinuePrompt = (
  roundPrompt: string,
  targetStepId: string
) =>
  [
    roundPrompt,
    [
      "The previous reply updated the execution plan but did not actually execute the focused step.",
      targetStepId
        ? `Continue executing ${targetStepId} now.`
        : "Continue executing the focused step now.",
      "Do not stop after another plan-only update with no tool usage.",
      "Take the next concrete action or explain a real blocker only after attempting execution.",
    ].join("\n"),
  ].join("\n\n");

const buildImplicitProviderDoneCompletion = (): QueryCompletionEvent => ({
  type: "completion",
  source: "provider",
  reason: "done_without_reason",
  detail:
    "The stream ended with done but no structured provider completion reason was reported.",
  expected: false,
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const parsePositiveDelayMs = (value: string | undefined) => {
  if (!value?.trim()) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
};

const hasDeepSeekMarker = (value: string) => {
  try {
    return new URL(value).hostname.toLowerCase().includes("deepseek");
  } catch {
    return value.toLowerCase().includes("deepseek");
  }
};

const resolveDeepSeekCacheSettleDelayMs = (
  provider: string,
  model: string,
  env?: NodeJS.ProcessEnv
) => {
  if (!hasDeepSeekMarker(provider) && !hasDeepSeekMarker(model)) {
    return 0;
  }
  if (env?.CYRENE_DEEPSEEK_CACHE_SETTLE_MS === "0") {
    return 0;
  }
  return parsePositiveDelayMs(env?.CYRENE_DEEPSEEK_CACHE_SETTLE_MS) ?? 2500;
};

const resolveAnthropicCacheSettleDelayMs = (
  transport: Pick<
    RunQuerySessionParams["transport"],
    "getProvider" | "getProviderFormat"
  >,
  env?: NodeJS.ProcessEnv
) => {
  if (transport.getProviderFormat?.() !== "anthropic_messages") {
    return 0;
  }
  if (env?.CYRENE_ANTHROPIC_CACHE_SETTLE_MS === "0") {
    return 0;
  }
  return parsePositiveDelayMs(env?.CYRENE_ANTHROPIC_CACHE_SETTLE_MS) ?? 2500;
};

const isAbortError = (error: unknown) =>
  error instanceof Error ? error.name === "AbortError" : false;

const countPatternMatches = (text: string, pattern: RegExp) => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(matcher)).length;
};

const isLongRepetitiveSelfNarration = (assistantText: string) => {
  const visibleChars = assistantText.replace(/\s+/g, "").length;
  if (visibleChars < LONG_REPETITIVE_CHATTER_VISIBLE_CHAR_THRESHOLD) {
    return false;
  }
  return (
    countPatternMatches(assistantText, SELF_NARRATION_MARKER_PATTERN) >=
    LONG_REPETITIVE_CHATTER_MARKER_THRESHOLD
  );
};

const shouldAutoContinueNonProgress = (
  assistantText: string,
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger
) => {
  const visibleChars = assistantText.replace(/\s+/g, "").length;
  const autoContinueLimit =
    uncertainty.writeFocus && !uncertainty.mutationStarted ? 2 : 1;
  const repetitiveSelfNarration = isLongRepetitiveSelfNarration(assistantText);
  return (
    ((uncertainty.mode === "simple_multi_file" &&
      uncertainty.phase === "execute" &&
      ProgressTracker.getLedgerRemainingCount(ledger) > 0) ||
      (uncertainty.writeFocus && !uncertainty.mutationStarted)) &&
    !uncertainty.blockedReason &&
    visibleChars > 0 &&
    ((visibleChars < MAX_NON_PROGRESS_CHATTER_CHARS &&
      NON_PROGRESS_CHATTER_PATTERN.test(assistantText)) ||
      repetitiveSelfNarration) &&
    uncertainty.nonProgressAutoContinueCount < autoContinueLimit
  );
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
  const remainingPaths = ProgressTracker.getLedgerRemainingPaths(progressLedger);
  const remainingCount = ProgressTracker.getLedgerRemainingCount(progressLedger);
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
    ProgressTracker.isMeaningfulMultiFileLedger(progressLedger) &&
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
      const expected = ProgressTracker.getLedgerExpectedFileCount(progressLedger);
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
  runtimeCorrection: string,
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
  const recentMutationFacts = ProgressTracker.formatRecentConfirmedFileMutations(
    recentConfirmedFileMutations
  );
  const multiFileProgressFacts =
    ProgressTracker.formatMultiFileProgressLedger(progressLedger);
  const searchMemoryFacts = ToolObservationStore.formatSearchMemory(searchMemory);
  const fileReadLedgerFacts = ToolObservationStore.formatFileReadLedger(
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
  const writeFocusRules =
    uncertainty.writeFocus
      ? [
          "Write-focus rules:",
          "- This is an explicit code-change task. Bias toward concrete writes/edits once the target path is known.",
          "- If a target path is already explicit or just discovered, use at most one targeted source read before the first write/edit on that path.",
          "- After the first confirmed mutation, spend later rounds on remaining writes, explicit verification, or the final answer.",
          "- Do not reopen broad discovery once a concrete target path or confirmed mutation already gives enough context.",
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
    writeFocusRules,
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
    runtimeCorrection ? `\n${runtimeCorrection}\n` : "",
    "Tool results:",
    formatToolResultsForRoundPrompt(toolResults),
    "If more tool usage is needed, call tools again. Otherwise provide final answer.",
  ].join("\n\n");
};

const runExecutionRuntime = async ({
  query,
  originalTask,
  queryMaxToolSteps = DEFAULT_QUERY_MAX_TOOL_STEPS,
  transport,
  env,
  onState,
  onTextDelta,
  onUsage,
  onToolStatus,
  onToolCall,
  onError,
  abortSignal,
}: RunQuerySessionParams): Promise<RunQuerySessionResult> => {
  const normalizedQuery = normalizeQueryInput(query);
  let state = createQuerySessionState();
  const task = originalTask ?? normalizedQuery.text;
  const deepSeekCacheSettleDelayMs = resolveDeepSeekCacheSettleDelayMs(
    transport.getProvider(),
    transport.getModel(),
    env
  );
  const anthropicCacheSettleDelayMs = resolveAnthropicCacheSettleDelayMs(
    transport,
    env
  );
  let filesystemMutationRevision = 0;
  let recentConfirmedFileMutations: ConfirmedFileMutation[] = [];
  let progressLedger = ProgressTracker.createInitialMultiFileProgressLedger(
    task,
    SIMPLE_MULTI_FILE_TASK_PATTERN
  );
  const uncertainty = createUncertaintyState(task, progressLedger);
  const planExecutionMode = normalizedQuery.text.includes(
    PLAN_EXECUTION_PROMPT_MARKER
  );
  const planExecutionTargetStepId = extractPlanExecutionTargetStepId(
    normalizedQuery.text
  );
  let planExecutionAutoContinueCount = 0;
  const searchMemory = ToolObservationStore.createSearchMemory();
  const readLedger = new Map<string, FileReadLedgerEntry>();
  let latestConfirmedFileMutation: ConfirmedFileMutation | null = null;
  const maxToolSteps =
    Number.isFinite(queryMaxToolSteps) && queryMaxToolSteps > 0
      ? Math.floor(queryMaxToolSteps)
      : DEFAULT_QUERY_MAX_TOOL_STEPS;
  const dispatch: QuerySessionDispatch = event => {
    state = querySessionReducer(state, event);
    onState(state);
  };
  const isCancelled = () => abortSignal?.aborted === true;
  const completeCancelledRound = () => {
    dispatch(CANCELLED_COMPLETION_EVENT);
    dispatch({ type: "complete" });
    return COMPLETED_RESULT;
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
    const confirmedFileMutation = ToolObservationStore.getConfirmedFileMutation(
      toolName,
      input,
      message,
      metadata
    );
    if (confirmedFileMutation) {
      uncertainty.mutationStarted = true;
      resetEnoughToActState(uncertainty);
      resetTargetedReadFailureTracking(uncertainty);
      recentConfirmedFileMutations =
        ToolObservationStore.pushRecentConfirmedFileMutation(
          recentConfirmedFileMutations,
        confirmedFileMutation
      );
      ToolObservationStore.clearReadLedgerForMutation(
        readLedger,
        confirmedFileMutation
      );
      progressLedger = ProgressTracker.pushCompletedPathToLedger(
        progressLedger,
        confirmedFileMutation.path
      );
      latestConfirmedFileMutation = confirmedFileMutation;
      uncertainty.phase =
        ProgressTracker.getLedgerRemainingCount(progressLedger) === 0 &&
        uncertainty.verifyRequested
          ? "verify"
          : "execute";
    } else {
      maybeMarkEnoughToActPath(
        uncertainty,
        toolName,
        input,
        message,
        searchMemory,
        accumulatedToolResults,
        roundToolResults
      );
      updateTargetedReadFailureTracking(uncertainty, toolName, input);
      maybeAdvanceUncertaintyAfterToolResult(
        uncertainty,
        toolName,
        input,
        message,
        progressLedger
      );
      if (
        uncertainty.writeFocus &&
        !uncertainty.mutationStarted &&
        uncertainty.phase === "discover" &&
        (uncertainty.explicitSourceReads.size > 0 ||
          uncertainty.enoughToActPaths.size > 0)
      ) {
        uncertainty.phase = "collapse";
      }
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
    runtimeCorrection: string,
    accumulatedToolResults: string[],
    toolStepsUsed: number,
    options?: RunRoundsOptions
  ): Promise<RunQuerySessionResult> => {
    dispatch({ type: "start" });

    if (isCancelled()) {
      return completeCancelledRound();
    }

    const streamUrl = await transport.requestStreamUrl({
      text: roundPrompt,
      attachments: normalizedQuery.attachments,
    });
    if (isCancelled()) {
      return completeCancelledRound();
    }
    let completed = false;
    let sawToolCall = false;
    let streamOpened = false;
    let visibleAnswerChars = 0;
    const toolResults: string[] = [];
    let latestUsage: TokenUsage | null = null;
    let latestCompletion: QueryCompletionEvent | null = null;
    let implicitProviderDonePending = false;
    let usageReported = false;
    let preToolNarrationText = "";
    let suppressPreToolNarrationOutput = false;
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

    const recordCompletion = (completion: QueryCompletionEvent) => {
      latestCompletion = completion;
      dispatch(completion);
    };

    const emitRoundText = (text: string) => {
      if (!text) {
        return;
      }
      dispatch({ type: "text_delta", text });
      onTextDelta(text);
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
            resumePromise = resumeImpl(
              ToolObservationStore.normalizeResumeToolResult(toolResult)
            );
          }
          return resumePromise;
        },
      };
    };

    try {
      for await (const chunk of transport.stream(streamUrl, { signal: abortSignal })) {
        if (isCancelled()) {
          return completeCancelledRound();
        }
        const events = parseStreamChunk(chunk);
        for (const event of events) {
        if (isCancelled()) {
          return completeCancelledRound();
        }
        if (!streamOpened && event.type !== "done") {
          dispatch({ type: "stream_open" });
          streamOpened = true;
        }

        if (event.type === "text_delta") {
          if (sawToolCall) {
            continue;
          }
          const nextPreToolNarration = preToolNarrationText + event.text;
          const shouldSuppressNarration =
            ((uncertainty.writeFocus && !uncertainty.mutationStarted) ||
              (uncertainty.mode === "simple_multi_file" &&
                uncertainty.phase === "execute" &&
                ProgressTracker.getLedgerRemainingCount(progressLedger) > 0)) &&
            isLongRepetitiveSelfNarration(nextPreToolNarration);
          if (shouldSuppressNarration) {
            suppressPreToolNarrationOutput = true;
          }
          preToolNarrationText = nextPreToolNarration;
          dispatch({ type: "text_delta", text: event.text });
          if (!suppressPreToolNarrationOutput) {
            visibleAnswerChars += event.text.trim() ? event.text.length : 0;
            onTextDelta(event.text);
          }
          continue;
        }

        if (event.type === "tool_call") {
          if (visibleAnswerChars >= LATE_TOOL_CALL_VISIBLE_ANSWER_CHAR_GUARD) {
            continue;
          }
          if (toolStepsUsed >= maxToolSteps) {
            recordCompletion({
              type: "completion",
              source: "runtime",
              reason: "tool_budget_exhausted",
              detail: `Used ${toolStepsUsed}/${maxToolSteps} tool steps. Stopping to avoid runaway execution.`,
              expected: false,
            });
            onTextDelta(
              `\n[tool budget exhausted] Used ${toolStepsUsed}/${maxToolSteps} tool steps. Stopping to avoid runaway execution. Split the task or raise query_max_tool_steps to continue.\n`
            );
            return completeRound();
          }
          toolStepsUsed += 1;
          sawToolCall = true;
          const action = getToolAction(event.toolName, event.input);
          const toolPath = getToolPath(event.input);
          if (
            uncertainty.writeFocus &&
            !uncertainty.verifyRequested &&
            isBroadDiscoveryAction(event.toolName, event.input) &&
            (uncertainty.mutationStarted ||
              searchMemory.discoveredPaths.size > 0 ||
              (uncertainty.explicitTaskPaths.size > 0 &&
                uncertainty.explicitSourceReads.size > 0))
          ) {
            const skipReason = uncertainty.mutationStarted
              ? "a confirmed code mutation already exists"
              : searchMemory.discoveredPaths.size > 0
                ? "concrete target paths are already known"
                : "the explicit target path was already read once";
            runtimeCorrection = [
              "Write-focused discovery blocked:",
              `Skipped ${action} ${toolPath ?? "."} because ${skipReason}.`,
              "Use the known path directly for the next read/edit/write step instead of reopening broad discovery.",
            ].join("\n");
            toolResults.push(
              [
                `[tool skipped] ${action} ${toolPath ?? "."}`.trim(),
                `Skipped ${action} because ${skipReason}.`,
                "Continue with the concrete read/edit/write step instead of broad rediscovery.",
              ].join("\n")
            );
            continue;
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
              const remainingPaths =
                ProgressTracker.getLedgerRemainingPaths(progressLedger);
              const skipReason =
                uncertainty.phase === "execute" || uncertainty.phase === "verify"
                  ? remainingPaths.length > 0 ||
                    ProgressTracker.getLedgerRemainingCount(progressLedger) > 0
                    ? "remaining files are already known"
                    : "completed files are authoritative"
                  : "the broad discovery budget is already exhausted";
              runtimeCorrection = [
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
              runtimeCorrection = [
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
              runtimeCorrection = [
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

          const enforceTargetedSourceReadBudget =
            uncertainty.mode === "simple_multi_file" ||
            (uncertainty.writeFocus &&
              !uncertainty.mutationStarted &&
              !uncertainty.verifyRequested);
          if (
            enforceTargetedSourceReadBudget &&
            isTargetedSourceReadAction(event.toolName, event.input) &&
            !shouldAllowTargetedSourceRead(
              toolPath,
              uncertainty,
              searchMemory,
              accumulatedToolResults,
              toolResults
            )
          ) {
            const skipReason =
              uncertainty.writeFocus &&
              !uncertainty.mutationStarted &&
              toolPath &&
              uncertainty.enoughToActPaths.has(
                normalizeComparedPath(toolPath)
              )
                ? "this path is already marked enough_to_act for the current write task"
                : uncertainty.writeFocus &&
                !uncertainty.mutationStarted &&
                toolPath &&
              uncertainty.stalledTargetedReadPaths.has(
                normalizeComparedPath(toolPath)
              )
                ? "this path already hit the repeated-read failure limit before any concrete edit"
                : uncertainty.mode === "simple_multi_file"
                ? "this path was neither explicitly requested nor just discovered for the current multi-file task"
                : "write-focused pre-mutation tasks only allow one targeted source read per concrete target path";
            runtimeCorrection = [
              "Targeted source read blocked:",
              `Skipped ${action} ${toolPath ?? "."}.`,
              uncertainty.writeFocus &&
              !uncertainty.mutationStarted &&
              toolPath &&
              uncertainty.enoughToActPaths.has(
                normalizeComparedPath(toolPath)
              )
                ? "Enough facts are already available for this path. Stop reading and move directly to edit/write/apply_patch."
                : uncertainty.writeFocus &&
                !uncertainty.mutationStarted &&
                toolPath &&
              uncertainty.stalledTargetedReadPaths.has(
                normalizeComparedPath(toolPath)
              )
                ? "Stop rereading this path. Switch to outline_file for structure, search_text_context for a concrete symbol/string, or a smaller read_range around the suspected lines."
                : uncertainty.mode === "simple_multi_file"
                ? "Read the explicitly requested source path once or use a path that was just discovered for the split/write step."
                : "Reuse the previous read result and move directly to the next write/edit step instead of rereading source.",
            ].join("\n");
            toolResults.push(
              [
                `[tool skipped] ${action} ${toolPath ?? "."}`.trim(),
                `Skipped ${action} because ${skipReason}.`,
                uncertainty.writeFocus &&
                !uncertainty.mutationStarted &&
                toolPath &&
                uncertainty.enoughToActPaths.has(
                  normalizeComparedPath(toolPath)
                )
                  ? "Use edit/write/apply_patch on this path now instead of collecting more source reads."
                  : uncertainty.writeFocus &&
                !uncertainty.mutationStarted &&
                toolPath &&
                uncertainty.stalledTargetedReadPaths.has(
                  normalizeComparedPath(toolPath)
                )
                  ? "Use outline_file/search_text_context or a smaller read_range instead of another full retry on the same path."
                  : uncertainty.mode === "simple_multi_file"
                  ? "Continue with the concrete remaining write/edit steps instead of adding more source reads."
                  : "Continue with the concrete write/edit step instead of adding more source reads.",
              ].join("\n")
            );
            continue;
          }

          const readLedgerEntry = ToolObservationStore.getReadLedgerEntry(
            readLedger,
            event.input
          );
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
              runtimeCorrection = [
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
              runtimeCorrection = [
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
                ToolObservationStore.isReadRangeCoveredByLedger(
                  readLedgerEntry,
                  startLine,
                  endLine,
                  filesystemMutationRevision
                )
              ) {
                const repeatedPath = getToolPath(event.input) ?? readLedgerEntry.path;
                runtimeCorrection = [
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

          const scopedBudgetKey = getScopedBroadDiscoveryBudgetKey(
            event.toolName,
            event.input,
            filesystemMutationRevision
          );
          if (scopedBudgetKey) {
            const scopedBudgetUsed =
              searchMemory.scopedBroadDiscoveryBudget.get(scopedBudgetKey) ?? 0;
            if (scopedBudgetUsed >= BROAD_DISCOVERY_SCOPE_BUDGET) {
              const repeatedScope =
                getBroadDiscoveryScope(event.toolName, event.input) ?? ".";
              if (uncertainty.mode === "simple_multi_file" && uncertainty.phase === "discover") {
                uncertainty.phase = "collapse";
              }
              if (uncertainty.mode === "project_analysis" && uncertainty.phase === "discover") {
                uncertainty.phase = "trace";
              }
              runtimeCorrection = [
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
            const broadScope = getBroadDiscoveryScope(
              event.toolName,
              event.input
            );
            if (broadScope) {
              searchMemory.searchedScopes.add(broadScope);
            }
          }
          if (
            isImmediateRedundantPostWriteRead(
              event.toolName,
              event.input,
              latestConfirmedFileMutation,
              taskSuggestsPostWriteVerification(task)
            )
          ) {
            const repeatedPath =
              getToolPath(event.input) ?? latestConfirmedFileMutation?.path ?? ".";
            const sourceAction = latestConfirmedFileMutation?.action ?? "write_file";
            runtimeCorrection = [
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
            continue;
          }
          if (latestConfirmedFileMutation) {
            latestConfirmedFileMutation = null;
          }
          dispatch({
            type: "tool_call",
            toolName: event.toolName,
            input: event.input,
          });
          onToolStatus?.(buildToolStatusMessage(event.toolName, event.input));
          if (isCancelled()) {
            return completeCancelledRound();
          }
          const toolResult = await onToolCall(event.toolName, event.input);
          if (isCancelled()) {
            return completeCancelledRound();
          }
          if (
            ToolObservationStore.didApplyFileMutation(
              event.toolName,
              event.input,
              toolResult.message,
              toolResult.metadata
            )
          ) {
            filesystemMutationRevision += 1;
            runtimeCorrection = "";
          }
          applyToolResultSideEffects(
            event.toolName,
            event.input,
            toolResult.message,
            toolResult.metadata,
            accumulatedToolResults,
            toolResults
          );
          ToolObservationStore.updateReadLedgerFromToolResult(
            readLedger,
            event.toolName,
            event.input,
            toolResult.message,
            toolResult.metadata,
            filesystemMutationRevision
          );
          ToolObservationStore.recordSearchObservation(
            searchMemory,
            event.toolName,
            event.input,
            toolResult.message
          );
          if (
            uncertainty.writeFocus &&
            !uncertainty.mutationStarted &&
            uncertainty.phase === "discover" &&
            searchMemory.discoveredPaths.size > 0
          ) {
            uncertainty.phase = "collapse";
          }
          if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
            emitRoundText(`${uncertainty.blockedReason}\n`);
            return completeRound();
          }
          if (toolResult.reviewMode) {
            dispatch({ type: "suspended" });
            return createOneShotResume(async resumedToolResult => {
              if (
                ToolObservationStore.didApplyFileMutation(
                  event.toolName,
                  event.input,
                  resumedToolResult.message,
                  resumedToolResult.metadata,
                )
              ) {
                filesystemMutationRevision += 1;
                runtimeCorrection = "";
              }
              applyToolResultSideEffects(
                event.toolName,
                event.input,
                resumedToolResult.message,
                resumedToolResult.metadata,
                accumulatedToolResults,
                toolResults
              );
              ToolObservationStore.updateReadLedgerFromToolResult(
                readLedger,
                event.toolName,
                event.input,
                resumedToolResult.message,
                resumedToolResult.metadata,
                filesystemMutationRevision
              );
              ToolObservationStore.recordSearchObservation(
                searchMemory,
                event.toolName,
                event.input,
                resumedToolResult.message
              );
              if (
                uncertainty.writeFocus &&
                !uncertainty.mutationStarted &&
                uncertainty.phase === "discover" &&
                searchMemory.discoveredPaths.size > 0
              ) {
                uncertainty.phase = "collapse";
              }
              if (uncertainty.phase === "blocked" && uncertainty.blockedReason) {
                emitRoundText(`${uncertainty.blockedReason}\n`);
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
                runtimeCorrection,
                recentConfirmedFileMutations,
                progressLedger,
                uncertainty,
                searchMemory,
                readLedger,
                filesystemMutationRevision
              );
              return runRounds(
                nextPrompt,
                runtimeCorrection,
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

        if (event.type === "completion") {
          recordCompletion(event);
          continue;
        }

        if (event.type === "done") {
          if (!latestCompletion && !sawToolCall) {
            recordCompletion(buildImplicitProviderDoneCompletion());
            implicitProviderDonePending = true;
          }
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
      if (isCancelled() || isAbortError(error)) {
        return completeCancelledRound();
      }
      throw error;
    }

    if (!sawToolCall) {
      if (
        planExecutionMode &&
        shouldAutoContinuePlanExecution(
          state.assistantText,
          planExecutionTargetStepId,
          planExecutionAutoContinueCount
        )
      ) {
        flushUsage();
        planExecutionAutoContinueCount += 1;
        return runRounds(
          buildPlanExecutionAutoContinuePrompt(
            roundPrompt,
            planExecutionTargetStepId
          ),
          runtimeCorrection,
          accumulatedToolResults,
          toolStepsUsed
        );
      }
      if (
        shouldAutoContinueNonProgress(
          state.assistantText,
          uncertainty,
          progressLedger
        )
      ) {
        flushUsage();
        uncertainty.nonProgressAutoContinueUsed = true;
        uncertainty.nonProgressAutoContinueCount += 1;
        const nextPrompt = buildRoundPrompt(
          task,
          accumulatedToolResults,
          uncertainty.writeFocus && !uncertainty.mutationStarted
            ? [
                "The previous reply narrated progress before taking a concrete code step.",
                "Do not narrate. Use the next concrete read/edit/write action now.",
              ].join("\n")
            : [
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
          runtimeCorrection,
          accumulatedToolResults,
          toolStepsUsed
        );
      }
      if (
        uncertainty.mode === "simple_multi_file" &&
        uncertainty.phase === "execute" &&
        ProgressTracker.getLedgerRemainingCount(progressLedger) > 0 &&
        NON_PROGRESS_CHATTER_PATTERN.test(state.assistantText)
      ) {
        emitRoundText(`\n${buildNonProgressStopMessage(progressLedger)}\n`);
        return completeRound();
      }
      if (visibleAnswerChars === 0 && options?.allowSilentPostReviewRetry) {
        flushUsage();
        const nextPrompt = buildRoundPrompt(
          task,
          accumulatedToolResults,
          [runtimeCorrection, SILENT_REVIEW_RESUME_RECOVERY_NOTE]
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
          runtimeCorrection,
          accumulatedToolResults,
          toolStepsUsed,
          { allowSilentPostReviewRetry: false }
        );
      }
      if (implicitProviderDonePending && visibleAnswerChars === 0) {
        emitRoundText(
          "\n[model stream interrupted] The stream ended without a structured provider completion reason.\n"
        );
      }
      return completeRound();
    }

    accumulatedToolResults = [...accumulatedToolResults, ...toolResults];
    flushUsage();
    const roundGapMs = Math.max(
      deepSeekCacheSettleDelayMs,
      anthropicCacheSettleDelayMs
    );
    if (roundGapMs > 0) {
      await sleep(roundGapMs, abortSignal);
      if (isCancelled()) {
        return completeCancelledRound();
      }
    }
    const nextPrompt = buildRoundPrompt(
      task,
      accumulatedToolResults,
      runtimeCorrection,
      recentConfirmedFileMutations,
      progressLedger,
      uncertainty,
      searchMemory,
      readLedger,
      filesystemMutationRevision
    );
    if (isCancelled()) {
      return completeCancelledRound();
    }
    return runRounds(
      nextPrompt,
      runtimeCorrection,
      accumulatedToolResults,
      toolStepsUsed,
      options
    );
  };

  try {
    if (isCancelled()) {
      return completeCancelledRound();
    }
    return await runRounds(
      buildInitialExecutionMemo(
        normalizedQuery.text,
        task,
        uncertainty,
        progressLedger
      ),
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

export class ExecutionRuntime {
  constructor(private readonly params: RunQuerySessionParams) {}

  run(): Promise<RunQuerySessionResult> {
    return runExecutionRuntime(this.params);
  }
}
