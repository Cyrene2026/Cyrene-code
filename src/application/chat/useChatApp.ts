import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  runQuerySession,
  type RunQuerySessionResult,
} from "../../core/query/runQuerySession";
import type { TokenUsage } from "../../core/query/tokenUsage";
import { buildPromptWithContext } from "../../core/session/buildPromptWithContext";
import type { SessionMemoryInput } from "../../core/session/memoryIndex";
import {
  extractPendingChoiceFromAssistantText,
  resolvePendingChoiceInput,
} from "../../core/session/pendingChoice";
import {
  applyParsedStateUpdate,
  applyLocalFallbackStateUpdate,
  buildFallbackPendingDigest,
  parseAssistantStateUpdate,
  type ReducerMode,
} from "../../core/session/stateReducer";
import type { SessionStore } from "../../core/session/store";
import type { QuerySessionState } from "../../core/query/sessionMachine";
import type { QueryTransport } from "../../core/query/transport";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";
import { DEFAULT_QUERY_MAX_TOOL_STEPS } from "../../shared/runtimeDefaults";
import type { AuthLoginInput, AuthStatus } from "../../infra/auth/types";
import type {
  SessionListItem,
  SessionPendingChoice,
  SessionRecord,
  SessionStateUpdateDiagnostic,
} from "../../core/session/types";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import type {
  MpcAction,
  PendingReviewItem,
  ToolRequest,
} from "../../core/tools/mcp/types";
import { createApprovalActionLock } from "./approvalActionLock";
import { summarizeToolMessage } from "./toolMessageSummary";
import { useInputAdapter } from "./inputAdapter";
import {
  clampCursorOffset,
  deleteBackwardAtCursor,
  deleteForwardAtCursor,
  insertTextAtCursor,
  moveCursorLeft,
  moveCursorRight,
  moveCursorVertical,
  type MultilineEditorState,
} from "./multilineInput";
import {
  canRetryBlockedApproval,
  clampPreviewOffset,
  clearApprovalBlockOnSelectionChange,
  computeNextApprovalSelection,
  cycleSelection,
  movePagedSelection,
  shouldKeepApprovalPanelOpen,
  shouldBlockRepeatedApproval,
} from "./chatStateHelpers";

type UseChatAppParams = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
  autoSummaryRefresh?: boolean;
  queryMaxToolSteps?: number;
  mcpService: FileMcpService;
  auth?: {
    status: AuthStatus;
    getStatus: () => Promise<AuthStatus>;
    saveLogin: (input: AuthLoginInput) => Promise<{
      ok: boolean;
      message: string;
      status: AuthStatus;
    }>;
    logout: () => Promise<{
      ok: boolean;
      message: string;
      status: AuthStatus;
    }>;
  };
  runQuerySessionImpl?: typeof runQuerySession;
  inputAdapterHook?: typeof useInputAdapter;
};

type ResumePickerState = {
  active: boolean;
  sessions: SessionListItem[];
  selectedIndex: number;
  pageSize: number;
};

type SessionsPanelState = {
  active: boolean;
  sessions: SessionListItem[];
  selectedIndex: number;
  pageSize: number;
};

type ModelPickerState = {
  active: boolean;
  models: string[];
  selectedIndex: number;
  pageSize: number;
};

type ProviderPickerState = {
  active: boolean;
  providers: string[];
  selectedIndex: number;
  pageSize: number;
};

type ApprovalPreviewMode = "summary" | "full";
type ApprovalActionKind = "approve" | "reject";

type ApprovalPanelState = {
  active: boolean;
  selectedIndex: number;
  previewMode: ApprovalPreviewMode;
  previewOffset: number;
  lastOpenedAt: string | null;
  blockedItemId: string | null;
  blockedReason: string | null;
  blockedAt: number | null;
  lastAction: ApprovalActionKind | null;
  inFlightId: string | null;
  actionState: ApprovalActionKind | null;
  resumePending: boolean;
};

type AuthPanelMode = "auto_onboarding" | "manual_login";
type AuthPanelStep = "provider" | "api_key" | "model" | "confirm";

type AuthPanelState = {
  active: boolean;
  mode: AuthPanelMode;
  step: AuthPanelStep;
  providerBaseUrl: string;
  apiKey: string;
  model: string;
  cursorOffset: number;
  error: string | null;
  info: string | null;
  saving: boolean;
  persistenceTarget: AuthStatus["persistenceTarget"];
};

type SuspendedTaskState = {
  sessionId: string;
  assistantBufferRef: { current: string };
  resume: (toolResultMessage: string) => Promise<RunQuerySessionResult>;
};

type ActiveTurnState = {
  runId: number;
  sessionId: string | null;
  assistantBufferRef: { current: string };
  cancelRequested: boolean;
  clearInFlightState?: () => Promise<void>;
};

type CommandSpec = {
  command: string;
  description: string;
};

type InputMode = "idle" | "command" | "file" | "shell";

type FileMentionSuggestion = {
  path: string;
  description: string;
};

type FileMentionState = {
  references: string[];
  activeQuery: string | null;
  suggestions: FileMentionSuggestion[];
  loading: boolean;
};

type ShellShortcutAction =
  | "run_shell"
  | "open_shell"
  | "read_shell"
  | "shell_status"
  | "interrupt_shell"
  | "close_shell";

type ShellShortcutState = {
  active: boolean;
  action: ShellShortcutAction | null;
  command: string;
  actionLabel: string;
  description: string;
};

type InputCommandState = {
  active: boolean;
  mode: InputMode;
  currentCommand: string | null;
  suggestions: CommandSpec[];
  selectedIndex: number;
  historyPosition: number | null;
  historySize: number;
  shellShortcut: ShellShortcutState;
  fileMentions: FileMentionState;
};

type RuntimeUsageSummary = {
  startedAt: string;
  activeSessionId: string | null;
  currentModel: string;
  requestCount: number;
  stateUpdateCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

const defaultSystemText =
  "Type /help to view commands. Use /login for HTTP auth or /resume to open session picker.";
const RESUME_PAGE_SIZE = 8;
const MODEL_PAGE_SIZE = 8;
const PROVIDER_PAGE_SIZE = 8;
const INPUT_HISTORY_LIMIT = 100;
const STREAMING_RENDER_BATCH_MS = 40;
const STREAMING_RENDER_BATCH_MS_MEDIUM = 80;
const STREAMING_RENDER_BATCH_MS_LARGE = 140;
const TURN_CANCELLED_ERROR = "__CYRENE_TURN_CANCELLED__";
const COMMAND_SPECS: CommandSpec[] = [
  { command: "/help", description: "show command list" },
  { command: "/login", description: "open HTTP login wizard" },
  { command: "/logout", description: "remove managed user auth and rebuild transport" },
  { command: "/auth", description: "show auth mode, source, and persistence target" },
  { command: "/provider", description: "open provider picker" },
  { command: "/provider refresh", description: "refresh current provider models" },
  { command: "/provider <url>", description: "switch provider directly" },
  { command: "/model", description: "open model picker" },
  { command: "/model refresh", description: "refresh available models" },
  { command: "/model <name>", description: "switch model directly" },
  { command: "/system", description: "show current system prompt" },
  { command: "/system <text>", description: "set system prompt for this runtime" },
  { command: "/system reset", description: "restore default system prompt" },
  { command: "/state", description: "show reducer/session state diagnostics" },
  { command: "/sessions", description: "open sessions panel" },
  { command: "/resume", description: "open session resume picker" },
  { command: "/resume <id>", description: "resume a session by id" },
  { command: "/new", description: "start a fresh session" },
  { command: "/cancel", description: "cancel the current running turn" },
  { command: "/undo", description: "undo last approved filesystem mutation" },
  { command: "/search-session <query>", description: "search sessions by id/title/content" },
  { command: "/search-session #<tag> [query]", description: "search sessions by tag + query" },
  { command: "/tag list", description: "list tags of current session" },
  { command: "/tag add <tag>", description: "add tag to current session" },
  { command: "/tag remove <tag>", description: "remove tag from current session" },
  { command: "/pin <note>", description: "pin important context" },
  { command: "/pins", description: "list pinned context" },
  { command: "/unpin <index>", description: "remove a pin" },
  { command: "/review", description: "open approval queue" },
  { command: "/review <id>", description: "inspect one pending operation" },
  { command: "/approve [id]", description: "approve pending operation(s)" },
  { command: "/approve low", description: "approve all non-high-risk operations" },
  { command: "/approve all", description: "approve all pending operations" },
  { command: "/reject [id]", description: "reject pending operation(s)" },
  { command: "/reject all", description: "reject all pending operations" },
];
const HELP_TEXT = [
  "Commands:",
  ...COMMAND_SPECS.map(spec => `${spec.command} - ${spec.description}`),
].join("\n");

const getSlashSuggestions = (rawInput: string) => {
  const value = rawInput.trimStart();
  if (!value.startsWith("/")) {
    return [];
  }

  const normalized = value.toLowerCase();
  const primaryToken = normalized.split(/\s+/, 1)[0] ?? normalized;

  const matches = COMMAND_SPECS
    .filter(spec => {
      const specNormalized = spec.command.toLowerCase();
      return (
        specNormalized.startsWith(normalized) ||
        specNormalized.startsWith(primaryToken) ||
        normalized.startsWith(specNormalized.replace(/\s+<.*$/, ""))
      );
    })
    .sort((left, right) => {
      const leftNormalized = left.command.toLowerCase();
      const rightNormalized = right.command.toLowerCase();
      const leftExact = leftNormalized === normalized ? 3 : 0;
      const rightExact = rightNormalized === normalized ? 3 : 0;
      const leftPrefix = leftNormalized.startsWith(normalized) ? 2 : 0;
      const rightPrefix = rightNormalized.startsWith(normalized) ? 2 : 0;
      const leftToken = leftNormalized.startsWith(primaryToken) ? 1 : 0;
      const rightToken = rightNormalized.startsWith(primaryToken) ? 1 : 0;
      const leftScore = leftExact + leftPrefix + leftToken;
      const rightScore = rightExact + rightPrefix + rightToken;

      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      if (leftNormalized.includes(" ") !== rightNormalized.includes(" ")) {
        return leftNormalized.includes(" ") ? -1 : 1;
      }

      if (leftNormalized.length !== rightNormalized.length) {
        return rightNormalized.length - leftNormalized.length;
      }

      return leftNormalized.localeCompare(rightNormalized);
    });

  return matches.slice(0, 6);
};

const getSlashInsertValue = (command: string) => {
  switch (command) {
    case "/provider <url>":
      return "/provider ";
    case "/model <name>":
      return "/model ";
    case "/system <text>":
      return "/system ";
    case "/resume <id>":
      return "/resume ";
    case "/search-session <query>":
      return "/search-session ";
    case "/search-session #<tag> [query]":
      return "/search-session #";
    case "/tag add <tag>":
      return "/tag add ";
    case "/tag remove <tag>":
      return "/tag remove ";
    case "/pin <note>":
      return "/pin ";
    case "/unpin <index>":
      return "/unpin ";
    case "/review <id>":
      return "/review ";
    case "/approve [id]":
      return "/approve ";
    case "/reject [id]":
      return "/reject ";
    default:
      return command;
  }
};

type ActiveFileMention = {
  start: number;
  end: number;
  query: string;
};

const FILE_MENTION_REGEX = /(^|\s)@([^\s@]*)/g;

const getActiveFileMention = (
  rawInput: string,
  cursorOffset: number
): ActiveFileMention | null => {
  const clampedOffset = clampCursorOffset(rawInput, cursorOffset);
  const beforeCursor = rawInput.slice(0, clampedOffset);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const start = beforeCursor.length - query.length - 1;
  return {
    start,
    end: clampedOffset,
    query,
  };
};

const getFileMentionReferences = (rawInput: string) => {
  const references: string[] = [];
  let match: RegExpExecArray | null = null;
  const pattern = new RegExp(FILE_MENTION_REGEX);
  while ((match = pattern.exec(rawInput)) !== null) {
    const reference = (match[2] ?? "").trim();
    if (!reference) {
      continue;
    }
    if (!references.includes(reference)) {
      references.push(reference);
    }
  }
  return references;
};

const buildFileSearchPattern = (query: string) =>
  `*${query.replace(/\s+/g, "*")}*`;

const buildFileSuggestionDescription = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) {
    return "workspace root";
  }
  return normalized.slice(0, slashIndex);
};

const parseFindFilesSuggestions = (raw: string): FileMentionSuggestion[] => {
  const body = raw.split("\n").slice(1);
  const paths = body
    .map(line => line.trim())
    .filter(
      line =>
        Boolean(line) &&
        !line.startsWith("Found ") &&
        !line.startsWith("note:") &&
        !line.startsWith("(no matches")
    );

  return paths.slice(0, 6).map(path => ({
    path,
    description: buildFileSuggestionDescription(path),
  }));
};

type ParsedShellShortcut = {
  active: boolean;
  request: ToolRequest | null;
  action: ShellShortcutAction | null;
  command: string;
  actionLabel: string;
  description: string;
};

const parseShellShortcut = (rawInput: string): ParsedShellShortcut => {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("!shell")) {
    return {
      active: false,
      request: null,
      action: null,
      command: "",
      actionLabel: "",
      description: "",
    };
  }

  const remainder = trimmed.slice("!shell".length).trim();
  if (!remainder) {
    return {
      active: true,
      request: null,
      action: null,
      command: "",
      actionLabel: "!shell",
      description:
        "Run a safe shell command, or use open/read/status/interrupt/close.",
    };
  }

  const [subcommandRaw = "", ...rest] = remainder.split(/\s+/);
  const subcommand = subcommandRaw.toLowerCase();
  const tail = rest.join(" ").trim();

  if (subcommand === "open") {
    return {
      active: true,
      request: {
        action: "open_shell",
        path: ".",
        ...(tail ? { cwd: tail } : {}),
      },
      action: "open_shell",
      command: tail || ".",
      actionLabel: "open_shell",
      description: tail
        ? `Open a persistent shell session in ${tail}.`
        : "Open a persistent shell session in the workspace root.",
    };
  }

  if (subcommand === "read") {
    return {
      active: true,
      request: { action: "read_shell", path: "." },
      action: "read_shell",
      command: "read",
      actionLabel: "read_shell",
      description: "Read buffered output from the persistent shell session.",
    };
  }

  if (subcommand === "status") {
    return {
      active: true,
      request: { action: "shell_status", path: "." },
      action: "shell_status",
      command: "status",
      actionLabel: "shell_status",
      description: "Inspect persistent shell status, cwd, and pending output.",
    };
  }

  if (subcommand === "interrupt") {
    return {
      active: true,
      request: { action: "interrupt_shell", path: "." },
      action: "interrupt_shell",
      command: "interrupt",
      actionLabel: "interrupt_shell",
      description: "Interrupt the currently running persistent shell command.",
    };
  }

  if (subcommand === "close") {
    return {
      active: true,
      request: { action: "close_shell", path: "." },
      action: "close_shell",
      command: "close",
      actionLabel: "close_shell",
      description: "Close the persistent shell session and discard its state.",
    };
  }

  return {
    active: true,
    request: {
      action: "run_shell",
      path: ".",
      command: remainder,
    },
    action: "run_shell",
    command: remainder,
    actionLabel: "run_shell",
    description: "Run a one-shot shell command through the review lane.",
  };
};

const isLikelyLegacyCompressedMarkdown = (text: string) => {
  if (text.includes("\n")) {
    return false;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  const signalCount = [
    /(^|\s)#{1,6}\s+\S/.test(normalized),
    /```/.test(normalized),
    /\*\*[^*]+\*\*/.test(normalized),
    /(?:^|\s)(?:-|\*|\d+\.)\s+\S/.test(normalized),
    /(?:---|\*\*\*|___)/.test(normalized),
    /\s\.\.\.\s/.test(normalized),
  ].filter(Boolean).length;

  return signalCount >= 2;
};

const hasLegacyCompressedMarkdown = (session: SessionRecord) =>
  session.messages.some(
    message =>
      message.role === "assistant" &&
      isLikelyLegacyCompressedMarkdown(message.text)
  );

const actionColor = (action?: MpcAction): ChatItem["color"] => {
  if (!action) {
    return undefined;
  }
  if (
    action === "run_command" ||
    action === "run_shell" ||
    action === "open_shell" ||
    action === "write_shell"
  ) {
    return "red";
  }
  if (action === "delete_file") {
    return "red";
  }
  if (
    action === "create_dir" ||
    action === "create_file" ||
    action === "write_file" ||
    action === "edit_file" ||
    action === "apply_patch" ||
    action === "copy_path" ||
    action === "move_path"
  ) {
    return "green";
  }
  return undefined;
};

const isHighRiskReviewAction = (action: MpcAction) =>
  action === "apply_patch" ||
  action === "edit_file" ||
  action === "delete_file" ||
  action === "run_command" ||
  action === "run_shell" ||
  action === "open_shell" ||
  action === "write_shell";

type ApprovalRisk = "high" | "medium" | "low";

const getApprovalRisk = (action: MpcAction): ApprovalRisk => {
  if (isHighRiskReviewAction(action)) {
    return "high";
  }
  if (
    action === "create_file" ||
    action === "create_dir" ||
    action === "write_file" ||
    action === "move_path" ||
    action === "copy_path"
  ) {
    return "medium";
  }
  return "low";
};

const summarizePendingRisk = (pending: PendingReviewItem[]) =>
  pending.reduce(
    (acc, item) => {
      const risk = getApprovalRisk(item.request.action);
      acc[risk] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 } as Record<ApprovalRisk, number>
  );

const extractMessageBody = (raw: string) => {
  const [, ...rest] = raw.split("\n");
  return rest.join("\n").trim();
};

const buildApprovalMessage = (
  title: string,
  item?: PendingReviewItem,
  extraLines: string[] = []
) =>
  [
    title,
    ...(item
      ? [
          `id: ${item.id}`,
          `action: ${item.request.action}`,
          `path: ${item.request.path}`,
        ]
      : []),
    ...extraLines.filter(Boolean),
  ].join("\n");

const parseToolDetail = (raw: string) => {
  const [header = ""] = raw.split("\n");
  const detail = header
    .replace("[tool result]", "")
    .replace("[tool error]", "")
    .trim();
  const [action = "", path = ""] = detail.split(/\s+/, 2);
  return {
    detail,
    action: action || undefined,
    path: path || undefined,
  };
};

const condensePreview = (text: string, maxLines = 120) => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n... ${lines.length - maxLines} more lines`;
};

const getApprovalPreviewText = (
  item: PendingReviewItem | undefined,
  mode: ApprovalPreviewMode
) => {
  if (!item) {
    return "";
  }
  return mode === "full" ? item.previewFull : item.previewSummary;
};

const getPendingQueueSignature = (pending: PendingReviewItem[]) =>
  pending.map(item => item.id).join("|");

const HOTKEY_REPEAT_COOLDOWN_MS = 900;
const ACTION_REPEAT_COOLDOWN_MS = 400;
const APPROVAL_BLOCK_RETRY_MS = 1500;
const AUTH_PANEL_STEPS: AuthPanelStep[] = [
  "provider",
  "api_key",
  "model",
  "confirm",
];

const createRuntimeUsageSummary = (model: string): RuntimeUsageSummary => ({
  startedAt: new Date().toISOString(),
  activeSessionId: null,
  currentModel: model,
  requestCount: 0,
  stateUpdateCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const addUsageToRuntimeSummary = (
  summary: RuntimeUsageSummary,
  usage: TokenUsage
): RuntimeUsageSummary => ({
  ...summary,
  requestCount: summary.requestCount + 1,
  promptTokens: summary.promptTokens + usage.promptTokens,
  completionTokens: summary.completionTokens + usage.completionTokens,
  totalTokens: summary.totalTokens + usage.totalTokens,
});

const getStreamingRenderBatchMs = (textLength: number) => {
  if (textLength >= 8_000) {
    return STREAMING_RENDER_BATCH_MS_LARGE;
  }
  if (textLength >= 2_000) {
    return STREAMING_RENDER_BATCH_MS_MEDIUM;
  }
  return STREAMING_RENDER_BATCH_MS;
};

const isUsableHttpProvider = (provider: string) =>
  Boolean(provider && provider !== "none" && provider !== "local-core");

const maskApiKey = (apiKey: string) => {
  if (!apiKey) {
    return "";
  }
  if (apiKey.length <= 4) {
    return "•".repeat(apiKey.length);
  }
  return `${"•".repeat(Math.max(4, apiKey.length - 4))}${apiKey.slice(-4)}`;
};

const formatAuthStatusMessage = (status: AuthStatus) => {
  const lines = [
    "Auth status:",
    `mode: ${status.mode}`,
    `provider: ${status.provider}`,
    `model: ${status.model}`,
    `credential source: ${status.credentialSource}`,
    `persistence target: ${status.persistenceTarget?.label ?? "unavailable"}`,
    `persistence path: ${status.persistenceTarget?.path ?? "(none)"}`,
  ];

  if (status.credentialSource === "process_env") {
    lines.push(
      "note: credentials were supplied by the current launch environment and are not owned by Cyrene."
    );
  } else if (status.mode === "local") {
    lines.push("note: local-core fallback is active. Use /login to connect HTTP.");
  }

  return lines.join("\n");
};

export const useChatApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  autoSummaryRefresh = false,
  queryMaxToolSteps = DEFAULT_QUERY_MAX_TOOL_STEPS,
  mcpService,
  auth,
  runQuerySessionImpl = runQuerySession,
  inputAdapterHook = useInputAdapter,
}: UseChatAppParams) => {
  const [input, setInput] = useState("");
  const [inputCursorOffset, setInputCursorOffset] = useState(0);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [items, setItems] = useState<ChatItem[]>([
    {
      role: "system",
      text: defaultSystemText,
      kind: "system_hint",
      tone: "neutral",
      color: "gray",
    },
  ]);
  const [liveAssistantText, setLiveAssistantText] = useState("");
  const [sessionState, setSessionState] = useState<QuerySessionState | null>(
    null
  );
  const [currentModel, setCurrentModel] = useState(() => transport.getModel());
  const [currentProvider, setCurrentProvider] = useState(() => transport.getProvider());
  const [runtimeUsageSummary, setRuntimeUsageSummary] = useState<RuntimeUsageSummary>(
    () => createRuntimeUsageSummary(transport.getModel())
  );
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [resumePicker, setResumePicker] = useState<ResumePickerState>({
    active: false,
    sessions: [],
    selectedIndex: 0,
    pageSize: RESUME_PAGE_SIZE,
  });
  const [sessionsPanel, setSessionsPanel] = useState<SessionsPanelState>({
    active: false,
    sessions: [],
    selectedIndex: 0,
    pageSize: RESUME_PAGE_SIZE,
  });
  const [modelPicker, setModelPicker] = useState<ModelPickerState>({
    active: false,
    models: [],
    selectedIndex: 0,
    pageSize: MODEL_PAGE_SIZE,
  });
  const [providerPicker, setProviderPicker] = useState<ProviderPickerState>({
    active: false,
    providers: [],
    selectedIndex: 0,
    pageSize: PROVIDER_PAGE_SIZE,
  });
  const [pendingReviews, setPendingReviews] = useState<PendingReviewItem[]>([]);
  const [approvalPanel, setApprovalPanel] = useState<ApprovalPanelState>({
    active: false,
    selectedIndex: 0,
    previewMode: "summary",
    previewOffset: 0,
    lastOpenedAt: null,
    blockedItemId: null,
    blockedReason: null,
    blockedAt: null,
    lastAction: null,
    inFlightId: null,
    actionState: null,
    resumePending: false,
  });
  const [authPanel, setAuthPanel] = useState<AuthPanelState>({
    active: false,
    mode: "manual_login",
    step: "provider",
    providerBaseUrl: "",
    apiKey: "",
    model: "gpt-4o-mini",
    cursorOffset: 0,
    error: null,
    info: null,
    saving: false,
    persistenceTarget: auth?.status.persistenceTarget ?? null,
  });
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  const [fileSuggestionIndex, setFileSuggestionIndex] = useState(0);
  const [fileMentionLookup, setFileMentionLookup] = useState<{
    activeQuery: string | null;
    suggestions: FileMentionSuggestion[];
    loading: boolean;
  }>({
    activeQuery: null,
    suggestions: [],
    loading: false,
  });

  const queueRef = useRef(Promise.resolve());
  const approvalActionRef = useRef(createApprovalActionLock());
  const resumePickerRef = useRef(resumePicker);
  const sessionsPanelRef = useRef(sessionsPanel);
  const modelPickerRef = useRef(modelPicker);
  const providerPickerRef = useRef(providerPicker);
  const approvalPanelRef = useRef(approvalPanel);
  const authPanelRef = useRef(authPanel);
  const authRef = useRef(auth);
  const mcpServiceRef = useRef(mcpService);
  const pendingReviewsRef = useRef(pendingReviews);
  const dismissedApprovalQueueSignatureRef = useRef<string | null>(null);
  const lastApprovalIntentRef = useRef<{ token: string; at: number } | null>(null);
  const lastApprovalHintRef = useRef<{ token: string; at: number } | null>(null);
  const lastActionIntentRef = useRef<{ token: string; at: number } | null>(null);
  const suspendedTaskRef = useRef<SuspendedTaskState | null>(null);
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const nextTurnRunIdRef = useRef(0);
  const pendingChoiceRef = useRef<SessionPendingChoice | null>(null);
  const finalizedAssistantBuffersRef = useRef(new WeakSet<{ current: string }>());
  const inputHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef(-1);
  const inputDraftRef = useRef("");
  const preferredInputColumnRef = useRef<number | null>(null);
  const queuedSubmitRef = useRef<{
    rawInput: string;
    query: string;
  } | null>(null);
  const liveAssistantRawTextRef = useRef("");
  const liveAssistantTextRef = useRef("");
  const liveAssistantRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveAssistantRenderedTextRef = useRef("");
  const liveAssistantLastFlushAtRef = useRef(0);
  const authOnboardingHandledRef = useRef(false);
  const authOnboardingSuppressedRef = useRef(false);

  resumePickerRef.current = resumePicker;
  sessionsPanelRef.current = sessionsPanel;
  modelPickerRef.current = modelPicker;
  providerPickerRef.current = providerPicker;
  approvalPanelRef.current = approvalPanel;
  authPanelRef.current = authPanel;
  authRef.current = auth;
  mcpServiceRef.current = mcpService;
  pendingReviewsRef.current = pendingReviews;
  inputHistoryRef.current = inputHistory;
  historyCursorRef.current = historyCursor;

  useEffect(
    () => () => {
      if (liveAssistantRenderTimerRef.current) {
        clearTimeout(liveAssistantRenderTimerRef.current);
        liveAssistantRenderTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    const syncCurrentModel = () => {
      if (!cancelled) {
        updateCurrentModelState(transport.getModel());
        updateCurrentProviderState(transport.getProvider());
      }
    };

    syncCurrentModel();
    void Promise.allSettled([transport.listModels(), transport.listProviders()])
      .then(() => {
        syncCurrentModel();
      });

    return () => {
      cancelled = true;
    };
  }, [transport]);

  useEffect(() => {
    if (!auth || authPanelRef.current.active) {
      return;
    }
    if (authOnboardingHandledRef.current || authOnboardingSuppressedRef.current) {
      return;
    }
    const showStartupView =
      !liveAssistantText &&
      items.every(item => item.role === "system" && item.kind === "system_hint");
    if (!showStartupView || status !== "idle") {
      return;
    }
    if (auth.status.mode !== "local" || !auth.status.onboardingAvailable) {
      return;
    }
    authOnboardingHandledRef.current = true;
    openAuthPanel("auto_onboarding");
  }, [auth, items, liveAssistantText, status]);

  const commandQuery = input.trimStart();
  const commandModeActive = commandQuery.startsWith("/");
  const slashSuggestions = useMemo(() => getSlashSuggestions(input), [input]);
  const activeFileMention = useMemo(
    () => getActiveFileMention(input, inputCursorOffset),
    [input, inputCursorOffset]
  );
  const fileMentionReferences = useMemo(() => getFileMentionReferences(input), [input]);
  const shellShortcutPreview = useMemo(() => parseShellShortcut(input), [input]);
  const commandSelectedIndex =
    slashSuggestions.length > 0
      ? Math.min(commandSuggestionIndex, slashSuggestions.length - 1)
      : 0;
  const fileSelectedIndex =
    fileMentionLookup.suggestions.length > 0
      ? Math.min(fileSuggestionIndex, fileMentionLookup.suggestions.length - 1)
      : 0;

  useEffect(() => {
    setCommandSuggestionIndex(0);
  }, [commandQuery]);

  useEffect(() => {
    setFileSuggestionIndex(0);
  }, [activeFileMention?.query]);

  useEffect(() => {
    if (shellShortcutPreview.active) {
      setFileMentionLookup(previous =>
        previous.activeQuery === null &&
        previous.suggestions.length === 0 &&
        !previous.loading
          ? previous
          : {
              activeQuery: null,
              suggestions: [],
              loading: false,
            }
      );
      return;
    }

    if (!activeFileMention) {
      setFileMentionLookup(previous =>
        previous.activeQuery === null &&
        previous.suggestions.length === 0 &&
        !previous.loading
          ? previous
          : {
              activeQuery: null,
              suggestions: [],
              loading: false,
            }
      );
      return;
    }

    const query = activeFileMention.query.trim();
    if (!query) {
      setFileMentionLookup({
        activeQuery: "",
        suggestions: [],
        loading: false,
      });
      return;
    }

    let cancelled = false;
    setFileMentionLookup(previous => ({
      activeQuery: query,
      suggestions:
        previous.activeQuery === query ? previous.suggestions : [],
      loading: true,
    }));

    void mcpServiceRef.current
      .handleToolCall("file", {
        action: "find_files",
        path: ".",
        pattern: buildFileSearchPattern(query),
        maxResults: 6,
      })
      .then(result => {
        if (cancelled) {
          return;
        }
        setFileMentionLookup({
          activeQuery: query,
          suggestions: result.ok ? parseFindFilesSuggestions(result.message) : [],
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setFileMentionLookup({
          activeQuery: query,
          suggestions: [],
          loading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeFileMention, shellShortcutPreview.active]);

  const updateCurrentModelState = (model: string) => {
    setCurrentModel(model);
    setRuntimeUsageSummary(previous =>
      previous.currentModel === model
        ? previous
        : {
            ...previous,
            currentModel: model,
        }
    );
  };

  const updateCurrentProviderState = (provider: string) => {
    setCurrentProvider(provider);
  };

  const updateActiveSessionIdState = (sessionId: string | null) => {
    setActiveSessionId(sessionId);
    setRuntimeUsageSummary(previous =>
      previous.activeSessionId === sessionId
        ? previous
        : {
            ...previous,
            activeSessionId: sessionId,
          }
    );
  };

  const accumulateRuntimeUsage = (usage: TokenUsage) => {
    setRuntimeUsageSummary(previous => addUsageToRuntimeSummary(previous, usage));
  };

  const incrementStateUpdateCount = () => {
    setRuntimeUsageSummary(previous => ({
      ...previous,
      stateUpdateCount: previous.stateUpdateCount + 1,
    }));
  };

  const clearPendingReviewState = () => {
    pendingReviewsRef.current = [];
    setPendingReviews([]);
  };

  const enqueueTask = (task: () => Promise<void> | void) => {
    queueRef.current = queueRef.current
      .catch(error => {
        pushSystemMessage(
          `Queued action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            kind: "error",
            tone: "danger",
            color: "red",
          }
        );
      })
      .then(task)
      .catch(error => {
        pushSystemMessage(
          `Queued action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            kind: "error",
            tone: "danger",
            color: "red",
          }
        );
      });
  };

  const commitEditorState = (
    next: MultilineEditorState,
    options?: {
      clearHistoryCursor?: boolean;
      updateDraft?: boolean;
      preferredColumn?: number | null;
    }
  ) => {
    const clearHistoryCursor = options?.clearHistoryCursor ?? true;
    const updateDraft = options?.updateDraft ?? true;
    const cursorOffset = clampCursorOffset(next.value, next.cursorOffset);

    preferredInputColumnRef.current =
      options?.preferredColumn === undefined ? null : options.preferredColumn;

    if (clearHistoryCursor && historyCursorRef.current !== -1) {
      historyCursorRef.current = -1;
      setHistoryCursor(-1);
    }

    if (updateDraft) {
      inputDraftRef.current = next.value;
    }

    setInput(next.value);
    setInputCursorOffset(cursorOffset);
  };

  const setInputValue = (next: string) => {
    commitEditorState({
      value: next,
      cursorOffset: next.length,
    });
  };

  const clearInput = () => {
    commitEditorState({
      value: "",
      cursorOffset: 0,
    });
  };

  const applyEditorTransform = (
    transform: (state: MultilineEditorState) => MultilineEditorState,
    options?: {
      preferredColumn?: number | null;
    }
  ) => {
    commitEditorState(
      transform({
        value: input,
        cursorOffset: inputCursorOffset,
      }),
      {
        preferredColumn: options?.preferredColumn,
      }
    );
  };

  const pushInputHistory = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    setInputHistory(previous => {
      const next =
        previous[previous.length - 1] === trimmed
          ? previous
          : [...previous, trimmed].slice(-INPUT_HISTORY_LIMIT);
      inputHistoryRef.current = next;
      return next;
    });
    historyCursorRef.current = -1;
    setHistoryCursor(-1);
    inputDraftRef.current = "";
  };

  const recallInputHistory = (direction: "up" | "down") => {
    const history = inputHistoryRef.current;
    if (history.length === 0) {
      return;
    }

    if (direction === "up") {
      if (historyCursorRef.current === -1) {
        inputDraftRef.current = input;
        const nextIndex = history.length - 1;
        historyCursorRef.current = nextIndex;
        setHistoryCursor(nextIndex);
        const nextValue = history[nextIndex] ?? "";
        setInput(nextValue);
        setInputCursorOffset(nextValue.length);
        preferredInputColumnRef.current = null;
        return;
      }
      const nextIndex = Math.max(0, historyCursorRef.current - 1);
      historyCursorRef.current = nextIndex;
      setHistoryCursor(nextIndex);
      const nextValue = history[nextIndex] ?? "";
      setInput(nextValue);
      setInputCursorOffset(nextValue.length);
      preferredInputColumnRef.current = null;
      return;
    }

    if (historyCursorRef.current === -1) {
      return;
    }
    if (historyCursorRef.current >= history.length - 1) {
      historyCursorRef.current = -1;
      setHistoryCursor(-1);
      setInput(inputDraftRef.current);
      setInputCursorOffset(inputDraftRef.current.length);
      preferredInputColumnRef.current = null;
      return;
    }
    const nextIndex = historyCursorRef.current + 1;
    historyCursorRef.current = nextIndex;
    setHistoryCursor(nextIndex);
    const nextValue = history[nextIndex] ?? "";
    setInput(nextValue);
    setInputCursorOffset(nextValue.length);
    preferredInputColumnRef.current = null;
  };

  const replaceInputRange = (start: number, end: number, nextText: string) => {
    const safeStart = Math.max(0, Math.min(start, input.length));
    const safeEnd = Math.max(safeStart, Math.min(end, input.length));
    const nextValue =
      input.slice(0, safeStart) + nextText + input.slice(safeEnd);
    commitEditorState({
      value: nextValue,
      cursorOffset: safeStart + nextText.length,
    });
  };

  const applySlashSuggestion = (suggestion: CommandSpec | undefined) => {
    if (!suggestion) {
      return;
    }
    const nextValue = getSlashInsertValue(suggestion.command);
    commitEditorState({
      value: nextValue,
      cursorOffset: nextValue.length,
    });
  };

  const applyFileMentionSuggestion = (
    suggestion: FileMentionSuggestion | undefined
  ) => {
    if (!suggestion || !activeFileMention) {
      return;
    }

    const replacement = `@${suggestion.path}`;
    const suffix = input.slice(activeFileMention.end);
    const trailingSpace =
      suffix.length === 0 || !/^\s/.test(suffix) ? " " : "";

    replaceInputRange(
      activeFileMention.start,
      activeFileMention.end,
      `${replacement}${trailingSpace}`
    );
  };

  const executeDirectToolRequest = (request: ToolRequest) => {
    enqueueTask(async () => {
      const result = await mcpService.handleToolCall("file", request);
      if (result.pending) {
        const reviewMode = isHighRiskReviewAction(result.pending.request.action)
          ? "block"
          : "queue";
        pushSystemMessage(
          `Approval required | ${result.pending.request.action} ${result.pending.request.path} | ${result.pending.id} | panel opened`,
          {
            kind: "review_status",
            tone: reviewMode === "block" ? "warning" : "info",
            color: reviewMode === "block" ? "red" : "yellow",
          }
        );
        openApprovalPanel(mcpService.listPending(), {
          focusLatest: true,
          previewMode: "summary",
        });
        return;
      }

      const summarized = summarizeToolMessage(result.message);
      pushSystemMessage(summarized.text, {
        kind: summarized.kind,
        tone: summarized.tone,
        color: summarized.color,
      });
      await recordSessionMemory(getMemorySessionId(), {
        kind: result.ok ? "tool_result" : "error",
        text: summarized.text,
        priority: result.ok ? 72 : 88,
      });
    });
  };

  const pushSystemMessage = (
    text: string,
    options?: Pick<ChatItem, "color" | "kind" | "tone">
  ) => {
    setItems(previous => [
      ...previous,
      {
        role: "system",
        text,
        color: options?.color,
        kind: options?.kind,
        tone: options?.tone,
      },
    ]);
  };

  const getPreferredLoginModel = () =>
    currentModel && currentModel !== "local-core" ? currentModel : "gpt-4o-mini";

  const getSuggestedLoginProvider = () => {
    const authProvider = authRef.current?.status.provider;
    if (authProvider && isUsableHttpProvider(authProvider)) {
      return authProvider;
    }
    return isUsableHttpProvider(currentProvider) ? currentProvider : "";
  };

  const getAuthPanelFieldValue = (panel: AuthPanelState) => {
    if (panel.step === "provider") {
      return panel.providerBaseUrl;
    }
    if (panel.step === "api_key") {
      return panel.apiKey;
    }
    return panel.model;
  };

  const updateAuthPanelFieldValue = (
    panel: AuthPanelState,
    nextValue: string,
    nextCursorOffset: number
  ): AuthPanelState => {
    const sanitizedValue = nextValue.replace(/\r?\n/g, "");
    const cursorOffset = clampCursorOffset(sanitizedValue, nextCursorOffset);
    if (panel.step === "provider") {
      return {
        ...panel,
        providerBaseUrl: sanitizedValue,
        cursorOffset,
        error: null,
      };
    }
    if (panel.step === "api_key") {
      return {
        ...panel,
        apiKey: sanitizedValue,
        cursorOffset,
        error: null,
      };
    }
    return {
      ...panel,
      model: sanitizedValue,
      cursorOffset,
      error: null,
    };
  };

  const setAuthPanelStep = (step: AuthPanelStep) => {
    setAuthPanel(previous => ({
      ...previous,
      step,
      cursorOffset:
        step === "provider"
          ? previous.providerBaseUrl.length
          : step === "api_key"
            ? previous.apiKey.length
            : previous.model.length,
      error: null,
      info: null,
    }));
  };

  const applyAuthEditorTransform = (
    transform: (state: MultilineEditorState) => MultilineEditorState
  ) => {
    setAuthPanel(previous => {
      if (!previous.active || previous.step === "confirm" || previous.saving) {
        return previous;
      }
      const next = transform({
        value: getAuthPanelFieldValue(previous),
        cursorOffset: previous.cursorOffset,
      });
      return updateAuthPanelFieldValue(previous, next.value, next.cursorOffset);
    });
  };

  const formatReducerStateMessage = (session: SessionRecord | null) => {
    const lines = [
      "Reducer state:",
      `auto summary refresh: ${autoSummaryRefresh ? "enabled" : "disabled"}`,
      `runtime state updates: ${runtimeUsageSummary.stateUpdateCount}`,
      `status: ${status}`,
      `model: ${currentModel}`,
      `session: ${session?.id ?? activeSessionId ?? "-"}`,
    ];

    if (!session) {
      lines.push("summary chars: 0");
      lines.push("pending digest chars: 0");
      lines.push("pending choice: (none)");
      lines.push("last state update: (none)");
      lines.push("in-flight turn: no");
      lines.push("note: no active session loaded yet.");
      return lines.join("\n");
    }

    lines.push(`summary chars: ${session.summary.trim().length}`);
    lines.push(`pending digest chars: ${session.pendingDigest.trim().length}`);
    lines.push(
      session.pendingChoice
        ? `pending choice: ${session.pendingChoice.options.length} options`
        : "pending choice: (none)"
    );
    if (session.lastStateUpdate) {
      lines.push(
        `last state update: ${session.lastStateUpdate.code}${
          session.lastStateUpdate.reducerMode
            ? ` / ${session.lastStateUpdate.reducerMode}`
            : ""
        }`
      );
      lines.push(`last update at: ${session.lastStateUpdate.updatedAt}`);
      lines.push(`detail: ${session.lastStateUpdate.message}`);
    } else {
      lines.push("last state update: (none)");
    }
    lines.push(`in-flight turn: ${session.inFlightTurn ? "yes" : "no"}`);
    return lines.join("\n");
  };

  const cancelLiveAssistantRender = () => {
    if (!liveAssistantRenderTimerRef.current) {
      return;
    }
    clearTimeout(liveAssistantRenderTimerRef.current);
    liveAssistantRenderTimerRef.current = null;
  };

  const flushLiveAssistantSegment = (next = liveAssistantTextRef.current) => {
    cancelLiveAssistantRender();
    liveAssistantRenderedTextRef.current = next;
    liveAssistantLastFlushAtRef.current = Date.now();
    startTransition(() => {
      setLiveAssistantText(previous => (previous === next ? previous : next));
    });
  };

  const scheduleLiveAssistantRender = () => {
    if (liveAssistantRenderTimerRef.current) {
      return;
    }
    const elapsed = Date.now() - liveAssistantLastFlushAtRef.current;
    const batchMs = getStreamingRenderBatchMs(liveAssistantTextRef.current.length);
    const waitMs = Math.max(0, batchMs - elapsed);
    if (waitMs === 0) {
      flushLiveAssistantSegment();
      return;
    }
    liveAssistantRenderTimerRef.current = setTimeout(() => {
      liveAssistantRenderTimerRef.current = null;
      flushLiveAssistantSegment();
    }, waitMs);
  };

  const clearLiveAssistantSegment = () => {
    cancelLiveAssistantRender();
    liveAssistantRawTextRef.current = "";
    liveAssistantTextRef.current = "";
    liveAssistantRenderedTextRef.current = "";
    liveAssistantLastFlushAtRef.current = 0;
    setLiveAssistantText(previous => (previous ? "" : previous));
  };

  const pushStreamingSystemMessage = (
    text: string,
    options?: Pick<ChatItem, "color" | "kind" | "tone">
  ) => {
    setItems(previous => {
      const next = [...previous];
      if (liveAssistantTextRef.current) {
        next.push({
          role: "assistant",
          text: liveAssistantTextRef.current,
          kind: "transcript",
          tone: "neutral",
        });
      }
      next.push({
        role: "system",
        text,
        color: options?.color,
        kind: options?.kind,
        tone: options?.tone,
      });
      return next;
    });
    clearLiveAssistantSegment();
  };

  const isRepeatedInteraction = (
    ref: { current: { token: string; at: number } | null },
    token: string,
    cooldownMs = HOTKEY_REPEAT_COOLDOWN_MS
  ) => {
    const now = Date.now();
    const last = ref.current;
    if (last && last.token === token && now - last.at < cooldownMs) {
      return true;
    }
    ref.current = { token, at: now };
    return false;
  };

  const isRepeatedActionInteraction = (
    token: string,
    cooldownMs = ACTION_REPEAT_COOLDOWN_MS
  ) => isRepeatedInteraction(lastActionIntentRef, token, cooldownMs);

  const clearApprovalBlock = (
    state: ApprovalPanelState
  ): ApprovalPanelState => ({
    ...state,
    blockedItemId: null,
    blockedReason: null,
    blockedAt: null,
    lastAction: null,
  });

  const clearApprovalInFlight = (
    state: ApprovalPanelState
  ): ApprovalPanelState => ({
    ...state,
    inFlightId: null,
    actionState: null,
    resumePending: false,
  });

  const syncApprovalBlockToQueue = (
    state: ApprovalPanelState,
    pending: PendingReviewItem[]
  ): ApprovalPanelState => {
    if (
      !state.blockedItemId ||
      pending.some(item => item.id === state.blockedItemId)
    ) {
      return state;
    }

    return clearApprovalBlock(state);
  };

  const recordSessionMemories = async (
    sessionId: string | null,
    entries: SessionMemoryInput[]
  ) => {
    if (!sessionId || entries.length === 0) {
      return;
    }
    try {
      await sessionStore.recordMemories(sessionId, entries);
    } catch {
      // Memory indexing should not break the interactive chat flow.
    }
  };

  const recordSessionMemory = async (
    sessionId: string | null,
    entry: SessionMemoryInput
  ) => recordSessionMemories(sessionId, [entry]);

  const getMemorySessionId = () =>
    suspendedTaskRef.current?.sessionId ?? activeSessionId;

  const syncInFlightTurn = async (
    sessionId: string,
    inFlightTurn: SessionRecord["inFlightTurn"]
  ) => {
    try {
      await sessionStore.updateInFlightTurn(sessionId, inFlightTurn);
    } catch {
      // Recovery snapshots should not break the main chat flow.
    }
  };

  const syncPendingChoice = async (
    sessionId: string,
    pendingChoice: SessionPendingChoice | null
  ) => {
    pendingChoiceRef.current = pendingChoice;
    try {
      await sessionStore.updatePendingChoice(sessionId, pendingChoice);
    } catch {
      // Choice-latch persistence should not break the main chat flow.
    }
  };

  const clearActiveTurnForAssistantBuffer = (
    assistantBufferRef: { current: string } | null
  ) => {
    if (!assistantBufferRef) {
      return;
    }
    if (activeTurnRef.current?.assistantBufferRef === assistantBufferRef) {
      activeTurnRef.current = null;
    }
  };

  const cancelCurrentTurn = async () => {
    const suspended = suspendedTaskRef.current;
    if (suspended) {
      queuedSubmitRef.current = null;
      queueRef.current = Promise.resolve();
      await cancelSuspendedTask(
        "Current turn cancelled. Add requirements and send a new prompt when ready.",
        {
          suppressApprovalQueue: true,
          preserveVisibleAssistant: false,
        }
      );
      return true;
    }

    const activeTurn = activeTurnRef.current;
    if (!activeTurn || activeTurn.cancelRequested) {
      return false;
    }

    activeTurn.cancelRequested = true;
    if (activeTurnRef.current?.runId === activeTurn.runId) {
      activeTurnRef.current = null;
    }
    queuedSubmitRef.current = null;
    queueRef.current = Promise.resolve();
    clearLiveAssistantSegment();
    clearPendingReviewState();
    setSessionState(null);
    setStatus("idle");
    closeApprovalPanel({ suppressCurrentQueue: true });
    pushSystemMessage(
      "Current turn cancelled. Add requirements and send a new prompt when ready.",
      {
        kind: "system_hint",
        tone: "warning",
        color: "yellow",
      }
    );
    try {
      if (activeTurn.clearInFlightState) {
        await activeTurn.clearInFlightState();
      } else if (activeTurn.sessionId) {
        await syncInFlightTurn(activeTurn.sessionId, null);
      }
    } catch {
      // Cancellation should still succeed even if recovery cleanup fails.
    }
    return true;
  };

  const finalizeAssistantBuffer = async (
    sessionId: string,
    assistantBuffer: string
  ) => {
    const parsed = parseAssistantStateUpdate(assistantBuffer);
    const visibleAssistantText = parsed.visibleText.trim();
    const diagnosticTime = new Date().toISOString();
    const nextPendingChoice = extractPendingChoiceFromAssistantText(
      visibleAssistantText,
      diagnosticTime
    );

    if (visibleAssistantText) {
      await sessionStore.appendMessage(sessionId, {
        role: "assistant",
        text: visibleAssistantText,
        createdAt: diagnosticTime,
      });
    }

    const latest = await sessionStore.loadSession(sessionId);
    if (latest) {
      let nextSummary = latest.summary;
      let nextPendingDigest = latest.pendingDigest;
      let diagnostic: SessionStateUpdateDiagnostic;
      const latestUserText =
        [...latest.messages]
          .reverse()
          .find(message => message.role === "user")
          ?.text ?? "";

      const createDiagnostic = (
        code: SessionStateUpdateDiagnostic["code"],
        message: string,
        reducerMode?: SessionStateUpdateDiagnostic["reducerMode"]
      ): SessionStateUpdateDiagnostic => ({
        code,
        message,
        updatedAt: diagnosticTime,
        reducerMode,
        summaryLength: nextSummary.trim().length,
        pendingDigestLength: nextPendingDigest.trim().length,
      });

      const withLocalFallbackState = (message: string) => {
        if (!visibleAssistantText) {
          return message;
        }

        const fallbackState = applyLocalFallbackStateUpdate({
          durableSummary: latest.summary,
          pendingDigest: latest.pendingDigest,
          userText: latestUserText,
          assistantText: visibleAssistantText,
        });

        if (!fallbackState.updated) {
          return message;
        }

        nextSummary = fallbackState.summary;
        nextPendingDigest = fallbackState.pendingDigest;

        if (fallbackState.advancedSummary) {
          return `${message} Locally advanced durable summary from the previous pending digest and captured a fallback pending digest for this turn.`;
        }

        if (fallbackState.capturedPendingDigest) {
          return `${message} Applied local fallback pending digest for this turn.`;
        }

        return message;
      };

      const withLocalFallbackDigest = (message: string) => {
        if (nextPendingDigest.trim() || !visibleAssistantText) {
          return message;
        }
        const fallbackPendingDigest = buildFallbackPendingDigest({
          userText: latestUserText,
          assistantText: visibleAssistantText,
        });
        if (!fallbackPendingDigest) {
          return message;
        }
        nextPendingDigest = fallbackPendingDigest;
        return `${message} Applied local fallback pending digest for this turn.`;
      };

      if (!autoSummaryRefresh) {
        diagnostic = createDiagnostic(
          "disabled",
          "Reducer disabled for this turn because autoSummaryRefresh=false."
        );
      } else if (parsed.parseStatus === "missing_tag") {
        diagnostic = createDiagnostic(
          "missing_tag",
          withLocalFallbackState(
            "Assistant reply finished without a <cyrene_state_update> block."
          )
        );
      } else if (parsed.parseStatus === "incomplete_tag") {
        diagnostic = createDiagnostic(
          "incomplete_tag",
          withLocalFallbackDigest(
            "Assistant reply started a <cyrene_state_update> block, but it did not complete before the turn ended."
          )
        );
      } else if (parsed.parseStatus === "empty_payload") {
        diagnostic = createDiagnostic(
          "empty_payload",
          withLocalFallbackDigest(
            "Assistant reply included an empty <cyrene_state_update> payload."
          )
        );
      } else if (parsed.parseStatus === "invalid_payload") {
        diagnostic = createDiagnostic(
          "invalid_payload",
          withLocalFallbackDigest(
            "Assistant reply included a <cyrene_state_update> block, but the JSON payload was invalid."
          )
        );
      } else {
        const applied = applyParsedStateUpdate({
          durableSummary: latest.summary,
          pendingDigest: latest.pendingDigest,
          update: parsed.update,
        });
        nextSummary = applied.summary;
        nextPendingDigest = applied.pendingDigest;
        diagnostic = createDiagnostic(
          nextSummary.trim() || nextPendingDigest.trim()
            ? "applied"
            : "applied_empty_state",
          nextSummary.trim() || nextPendingDigest.trim()
            ? `State update applied in ${parsed.update?.mode}.`
            : `State update applied in ${parsed.update?.mode}, but it produced empty durable state.`,
          parsed.update?.mode
        );
        if (applied.updated) {
          incrementStateUpdateCount();
        }
      }

      await sessionStore.updateWorkingState(sessionId, {
        summary: nextSummary,
        pendingDigest: nextPendingDigest,
        lastStateUpdate: diagnostic,
      });
    }

    await syncPendingChoice(sessionId, nextPendingChoice);
    await syncInFlightTurn(sessionId, null);
  };

  const consumeQueryRunResult = async (
    sessionId: string,
    assistantBufferRef: { current: string },
    result: RunQuerySessionResult | void
  ) => {
    if (!result || result.status === "completed") {
      if (finalizedAssistantBuffersRef.current.has(assistantBufferRef)) {
        return;
      }
      finalizedAssistantBuffersRef.current.add(assistantBufferRef);
      suspendedTaskRef.current = null;
      try {
        if (liveAssistantTextRef.current) {
          setItems(previous => [
            ...previous,
            {
              role: "assistant",
              text: liveAssistantTextRef.current,
              kind: "transcript",
              tone: "neutral",
            },
          ]);
          clearLiveAssistantSegment();
        }
        await finalizeAssistantBuffer(sessionId, assistantBufferRef.current);
        clearActiveTurnForAssistantBuffer(assistantBufferRef);
        setSessionState(null);
        setStatus("idle");
      } catch (error) {
        finalizedAssistantBuffersRef.current.delete(assistantBufferRef);
        throw error;
      }
      return;
    }

    suspendedTaskRef.current = {
      sessionId,
      assistantBufferRef,
      resume: result.resume,
    };
  };

  const resumeSuspendedTask = async (toolResultMessage: string) => {
    const suspended = suspendedTaskRef.current;
    if (!suspended) {
      return;
    }

    const current = suspendedTaskRef.current;
    if (!current || current.sessionId !== suspended.sessionId) {
      return;
    }
    suspendedTaskRef.current = null;
    const result = await current.resume(toolResultMessage);
    await consumeQueryRunResult(
      current.sessionId,
      current.assistantBufferRef,
      result
    );
  };

  const cancelSuspendedTask = async (
    cancellationMessage?: string,
    options?: {
      suppressApprovalQueue?: boolean;
      preserveVisibleAssistant?: boolean;
    }
  ) => {
    const suspended = suspendedTaskRef.current;
    if (!suspended) {
      return false;
    }

    suspendedTaskRef.current = null;
    clearActiveTurnForAssistantBuffer(suspended.assistantBufferRef);
    finalizedAssistantBuffersRef.current.add(suspended.assistantBufferRef);
    const visibleAssistantText = parseAssistantStateUpdate(
      suspended.assistantBufferRef.current
    ).visibleText.trim();
    const pendingLiveAssistantText =
      options?.preserveVisibleAssistant === false
        ? ""
        : liveAssistantTextRef.current.trim();
    const persistedAssistantText =
      options?.preserveVisibleAssistant === false ? "" : visibleAssistantText;

    if (pendingLiveAssistantText || cancellationMessage?.trim()) {
      setItems(previous => {
        const next = [...previous];
        if (pendingLiveAssistantText) {
          next.push({
            role: "assistant",
            text: pendingLiveAssistantText,
            kind: "transcript",
            tone: "neutral",
          });
        }
        if (cancellationMessage?.trim()) {
          next.push({
            role: "system",
            text: cancellationMessage.trim(),
            kind: "review_status",
            tone: "warning",
            color: "yellow",
          });
        }
        return next;
      });
    }

    clearLiveAssistantSegment();
    clearPendingReviewState();
    setSessionState(null);
    setStatus("idle");

    if (options?.suppressApprovalQueue) {
      closeApprovalPanel({ suppressCurrentQueue: true });
    }

    try {
      if (persistedAssistantText) {
        try {
          await sessionStore.appendMessage(suspended.sessionId, {
            role: "assistant",
            text: persistedAssistantText,
            createdAt: new Date().toISOString(),
          });
        } catch {
          // Cancelling a suspended turn should still clear runtime state even if persistence fails.
        }
      }
    } finally {
      await syncInFlightTurn(suspended.sessionId, null);
    }

    return true;
  };

  const ensureActiveSession = async (titleHint?: string) => {
    if (activeSessionId) {
      const loaded = await sessionStore.loadSession(activeSessionId);
      if (loaded) {
        return loaded;
      }
    }

    const created = await sessionStore.createSession(titleHint);
    pendingChoiceRef.current = null;
    updateActiveSessionIdState(created.id);
    return created;
  };

  const appendToLiveAssistant = (rawAssistantText: string) => {
    if (!rawAssistantText) {
      return;
    }
    liveAssistantRawTextRef.current = rawAssistantText;
    const nextVisible = parseAssistantStateUpdate(rawAssistantText).visibleText;
    if (nextVisible === liveAssistantTextRef.current) {
      return;
    }
    liveAssistantTextRef.current = nextVisible;

    if (!liveAssistantRenderedTextRef.current) {
      flushLiveAssistantSegment(nextVisible);
      return;
    }

    const elapsed = Date.now() - liveAssistantLastFlushAtRef.current;
    if (elapsed >= getStreamingRenderBatchMs(nextVisible.length)) {
      flushLiveAssistantSegment(nextVisible);
      return;
    }

    scheduleLiveAssistantRender();
  };

  const applyLoadedSession = (loaded: SessionRecord) => {
    const shouldShowLegacyHint = hasLegacyCompressedMarkdown(loaded);
    clearLiveAssistantSegment();
    pendingChoiceRef.current = loaded.pendingChoice;
    updateActiveSessionIdState(loaded.id);
    setItems([
      {
        role: "system",
        text: defaultSystemText,
        kind: "system_hint",
        tone: "neutral",
        color: "gray",
      },
      ...loaded.messages.map(message => ({
        role: message.role,
        text: message.text,
        kind: "transcript" as const,
        tone: "neutral" as const,
      })),
      {
        role: "system",
        text: `Resumed session: ${loaded.id}`,
        kind: "system_hint",
        tone: "info",
        color: "cyan",
      },
      ...(shouldShowLegacyHint
        ? [
            {
              role: "system" as const,
              text:
                "Resume note: this older session may include previously compressed assistant text, so some Markdown structure may not fully recover.",
              kind: "system_hint" as const,
              tone: "neutral" as const,
              color: "gray" as const,
            },
          ]
        : []),
    ]);
    setResumePicker({
      active: false,
      sessions: [],
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    });
    setSessionsPanel({
      active: false,
      sessions: [],
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    });
  };

  const closeModelPicker = () => {
    const nextState = {
      active: false,
      models: [],
      selectedIndex: 0,
      pageSize: MODEL_PAGE_SIZE,
    };
    modelPickerRef.current = nextState;
    setModelPicker(nextState);
  };

  const closeProviderPicker = () => {
    const nextState = {
      active: false,
      providers: [],
      selectedIndex: 0,
      pageSize: PROVIDER_PAGE_SIZE,
    };
    providerPickerRef.current = nextState;
    setProviderPicker(nextState);
  };

  const closeResumePicker = () => {
    const nextState = {
      active: false,
      sessions: [],
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    };
    resumePickerRef.current = nextState;
    setResumePicker(nextState);
  };

  const closeSessionsPanel = () => {
    const nextState = {
      active: false,
      sessions: [],
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    };
    sessionsPanelRef.current = nextState;
    setSessionsPanel(nextState);
  };

  const resetAuthPanel = () => {
    const nextState: AuthPanelState = {
      active: false,
      mode: "manual_login",
      step: "provider",
      providerBaseUrl: "",
      apiKey: "",
      model: getPreferredLoginModel(),
      cursorOffset: 0,
      error: null,
      info: null,
      saving: false,
      persistenceTarget: authRef.current?.status.persistenceTarget ?? null,
    };
    authPanelRef.current = nextState;
    setAuthPanel(nextState);
  };

  const closeAllOverlayPanels = (options?: {
    keepAuthPanel?: boolean;
    keepApproval?: boolean;
    keepModelPicker?: boolean;
    keepProviderPicker?: boolean;
    keepResumePicker?: boolean;
    keepSessionsPanel?: boolean;
  }) => {
    if (!options?.keepModelPicker) {
      closeModelPicker();
    }
    if (!options?.keepProviderPicker) {
      closeProviderPicker();
    }
    if (!options?.keepResumePicker) {
      closeResumePicker();
    }
    if (!options?.keepSessionsPanel) {
      closeSessionsPanel();
    }
    if (!options?.keepAuthPanel) {
      resetAuthPanel();
    }
    if (!options?.keepApproval) {
      dismissedApprovalQueueSignatureRef.current = getPendingQueueSignature(
        pendingReviewsRef.current
      );
      approvalPanelRef.current = {
        ...approvalPanelRef.current,
        active: false,
        previewOffset: 0,
      };
      setApprovalPanel(previous => ({
        ...previous,
        active: false,
        previewOffset: 0,
      }));
    }
  };

  const openAuthPanel = (mode: AuthPanelMode) => {
    closeAllOverlayPanels({ keepAuthPanel: true });
    const providerBaseUrl = getSuggestedLoginProvider();
    const model = getPreferredLoginModel();
    const nextState: AuthPanelState = {
      active: true,
      mode,
      step: "provider",
      providerBaseUrl,
      apiKey: "",
      model,
      cursorOffset: providerBaseUrl.length,
      error: null,
      info:
        mode === "auto_onboarding"
          ? "HTTP credentials not found. Press Esc to stay in local-core mode, or continue below."
          : "Connect an OpenAI-compatible HTTP provider. API key input stays local to this panel.",
      saving: false,
      persistenceTarget: authRef.current?.status.persistenceTarget ?? null,
    };
    authPanelRef.current = nextState;
    setAuthPanel(nextState);
  };

  const closeAuthPanel = (options?: { skipped?: boolean; silent?: boolean }) => {
    const wasAutoOnboarding = authPanelRef.current.mode === "auto_onboarding";
    resetAuthPanel();
    if (options?.skipped && wasAutoOnboarding) {
      authOnboardingSuppressedRef.current = true;
      if (!options.silent) {
        pushSystemMessage(
          "Login skipped. Continuing in local-core mode. Use /login whenever you want to connect HTTP.",
          {
            kind: "system_hint",
            tone: "info",
            color: "cyan",
          }
        );
      }
    }
  };

  const advanceAuthPanel = () => {
    const panel = authPanelRef.current;
    if (!panel.active || panel.saving) {
      return;
    }

    if (panel.step === "provider") {
      const providerBaseUrl = panel.providerBaseUrl.trim();
      try {
        const parsed = new URL(providerBaseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Provider base URL must use http or https.");
        }
      } catch (error) {
        setAuthPanel(previous => ({
          ...previous,
          error:
            error instanceof Error
              ? error.message
              : "Provider base URL is invalid.",
        }));
        return;
      }
      setAuthPanelStep("api_key");
      return;
    }

    if (panel.step === "api_key") {
      if (!panel.apiKey.trim()) {
        setAuthPanel(previous => ({
          ...previous,
          error: "API key is required.",
        }));
        return;
      }
      setAuthPanelStep("model");
      return;
    }

    if (panel.step === "model") {
      setAuthPanelStep("confirm");
      return;
    }

    setAuthPanel(previous => ({
      ...previous,
      saving: true,
      error: null,
      info: "Validating provider and loading models...",
    }));
    enqueueTask(async () => {
      const authRuntime = authRef.current;
      if (!authRuntime) {
        setAuthPanel(previous => ({
          ...previous,
          saving: false,
          error: "Auth runtime is unavailable in this build.",
        }));
        return;
      }

      const loginInput: AuthLoginInput = {
        providerBaseUrl: panel.providerBaseUrl.trim(),
        apiKey: panel.apiKey,
        model: panel.model.trim() || getPreferredLoginModel(),
      };
      const result = await authRuntime.saveLogin(loginInput);
      if (!result.ok) {
        setAuthPanel(previous => ({
          ...previous,
          saving: false,
          error: result.message,
          info: "Press 1/2/3 to edit a field, then Enter to retry.",
        }));
        return;
      }

      authOnboardingSuppressedRef.current = false;
      resetAuthPanel();
      pushSystemMessage(result.message, {
        kind: "system_hint",
        tone: "success",
        color: "cyan",
      });
    });
  };

  const loadSessionIntoChat = async (sessionId: string) => {
    const loaded = await sessionStore.loadSession(sessionId);
    if (!loaded) {
      pushSystemMessage(`Session not found: ${sessionId}`, {
        kind: "error",
        tone: "danger",
        color: "red",
      });
      return;
    }
    applyLoadedSession(loaded);
  };

  const confirmModelPickerSelection = () => {
    const selected =
      modelPickerRef.current.models[modelPickerRef.current.selectedIndex];
    if (
      isRepeatedActionInteraction(
        `model-picker:${selected ?? "none"}:${modelPickerRef.current.selectedIndex}`
      )
    ) {
      return;
    }
    enqueueTask(async () => {
      if (!selected) {
        pushSystemMessage("No model selected.", {
          kind: "error",
          tone: "danger",
          color: "red",
        });
        return;
      }
      const result = await transport.setModel(selected);
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        pushSystemMessage(result.message, {
          kind: "system_hint",
          tone: "info",
          color: "cyan",
        });
        closeModelPicker();
      } else {
        pushSystemMessage(`[model switch failed] ${result.message}`, {
          kind: "error",
          tone: "danger",
          color: "red",
        });
      }
    });
  };

  const confirmProviderPickerSelection = () => {
    const selected =
      providerPickerRef.current.providers[providerPickerRef.current.selectedIndex];
    if (
      isRepeatedActionInteraction(
        `provider-picker:${selected ?? "none"}:${providerPickerRef.current.selectedIndex}`
      )
    ) {
      return;
    }
    enqueueTask(async () => {
      if (!selected) {
        pushSystemMessage("No provider selected.", {
          kind: "error",
          tone: "danger",
          color: "red",
        });
        return;
      }
      const result = await transport.setProvider(selected);
      updateCurrentProviderState(transport.getProvider());
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        pushSystemMessage(result.message, {
          kind: "system_hint",
          tone: "info",
          color: "cyan",
        });
        closeProviderPicker();
      } else {
        pushSystemMessage(`[provider switch failed] ${result.message}`, {
          kind: "error",
          tone: "danger",
          color: "red",
        });
      }
    });
  };

  const confirmResumePickerSelection = () => {
    const selected =
      resumePickerRef.current.sessions[resumePickerRef.current.selectedIndex];
    if (
      isRepeatedActionInteraction(
        `resume-picker:${selected?.id ?? "none"}:${resumePickerRef.current.selectedIndex}`
      )
    ) {
      return;
    }
    enqueueTask(async () => {
      if (!selected) {
        pushSystemMessage("No session selected.", {
          kind: "error",
          tone: "danger",
          color: "red",
        });
        return;
      }
      await loadSessionIntoChat(selected.id);
    });
  };

  const confirmSessionsPanelSelection = () => {
    const selected =
      sessionsPanelRef.current.sessions[sessionsPanelRef.current.selectedIndex];
    if (
      isRepeatedActionInteraction(
        `sessions-panel:${selected?.id ?? "none"}:${sessionsPanelRef.current.selectedIndex}`
      )
    ) {
      return;
    }
    enqueueTask(async () => {
      if (!selected) {
        pushSystemMessage("No session selected.", {
          kind: "error",
          tone: "danger",
          color: "red",
        });
        return;
      }
      await loadSessionIntoChat(selected.id);
    });
  };

  const createNextApprovalPanelState = (
    nextPending: PendingReviewItem[],
    options?: {
      open?: boolean;
      focusLatest?: boolean;
      selectId?: string;
      selectedIndex?: number;
      previewMode?: ApprovalPreviewMode;
      clearBlocked?: boolean;
      blocked?: {
        itemId: string;
        reason: string;
        at: number;
        lastAction: ApprovalActionKind;
      } | null;
    }
  ): ApprovalPanelState => {
    const previous = approvalPanelRef.current;

    if (nextPending.length === 0) {
      return {
        active: false,
        selectedIndex: 0,
        previewMode: options?.previewMode ?? previous.previewMode,
        previewOffset: 0,
        lastOpenedAt: previous.lastOpenedAt,
        blockedItemId: null,
        blockedReason: null,
        blockedAt: null,
        lastAction: null,
        inFlightId: null,
        actionState: null,
        resumePending: false,
      };
    }

    let nextIndex = previous.selectedIndex;
    if (typeof options?.selectedIndex === "number") {
      nextIndex = options.selectedIndex;
    } else if (options?.selectId) {
      const matchedIndex = nextPending.findIndex(item => item.id === options.selectId);
      if (matchedIndex >= 0) {
        nextIndex = matchedIndex;
      }
    } else if (options?.focusLatest) {
      nextIndex = nextPending.length - 1;
    }

    const boundedIndex = computeNextApprovalSelection(nextIndex, nextPending.length);
    const nextPreviewMode = options?.previewMode ?? previous.previewMode;
    const selectedItem = nextPending[boundedIndex];
    const selectedPreview = getApprovalPreviewText(selectedItem, nextPreviewMode);
    const previewOffset =
      options?.previewMode && options.previewMode !== previous.previewMode
        ? 0
        : boundedIndex !== previous.selectedIndex
          ? 0
          : clampPreviewOffset(selectedPreview, previous.previewOffset);
    const nextActive = options?.open ?? previous.active;
    let nextState: ApprovalPanelState = {
      active: nextActive,
      selectedIndex: boundedIndex,
      previewMode: nextPreviewMode,
      previewOffset,
      lastOpenedAt: nextActive ? new Date().toISOString() : previous.lastOpenedAt,
      blockedItemId: previous.blockedItemId,
      blockedReason: previous.blockedReason,
      blockedAt: previous.blockedAt,
      lastAction: previous.lastAction,
      inFlightId: previous.inFlightId,
      actionState: previous.actionState,
      resumePending: previous.resumePending,
    };

    if (options?.clearBlocked) {
      nextState = clearApprovalBlock(nextState);
    } else if (options?.blocked) {
      nextState = {
        ...nextState,
        blockedItemId: options.blocked.itemId,
        blockedReason: options.blocked.reason,
        blockedAt: options.blocked.at,
        lastAction: options.blocked.lastAction,
      };
    } else if (boundedIndex !== previous.selectedIndex) {
      nextState = clearApprovalBlock(nextState);
    }

    return syncApprovalBlockToQueue(nextState, nextPending);
  };

  const updatePendingState = (
    nextPending: PendingReviewItem[],
    options?: {
      open?: boolean;
      focusLatest?: boolean;
      selectId?: string;
      selectedIndex?: number;
      previewMode?: ApprovalPreviewMode;
      clearBlocked?: boolean;
      blocked?: {
        itemId: string;
        reason: string;
        at: number;
        lastAction: ApprovalActionKind;
      } | null;
    }
  ) => {
    pendingReviewsRef.current = nextPending;
    if (nextPending.length === 0) {
      dismissedApprovalQueueSignatureRef.current = null;
    }
    const nextPanelState = createNextApprovalPanelState(nextPending, options);
    approvalPanelRef.current = nextPanelState;
    setPendingReviews(nextPending);
    setApprovalPanel(nextPanelState);
  };

  const closeApprovalPanel = (options?: { suppressCurrentQueue?: boolean }) => {
    lastApprovalIntentRef.current = null;
    lastApprovalHintRef.current = null;
    if (options?.suppressCurrentQueue) {
      dismissedApprovalQueueSignatureRef.current = getPendingQueueSignature(
        pendingReviewsRef.current
      );
    }
    approvalPanelRef.current = {
      ...approvalPanelRef.current,
      active: false,
      previewOffset: 0,
      inFlightId: null,
      actionState: null,
      resumePending: false,
    };
    setApprovalPanel(previous => ({
      ...previous,
      active: false,
      previewOffset: 0,
      inFlightId: null,
      actionState: null,
      resumePending: false,
    }));
  };

  const repairSettledReviewState = () => {
    if (pendingReviewsRef.current.length > 0 || suspendedTaskRef.current) {
      return;
    }
    if (approvalPanelRef.current.active) {
      closeApprovalPanel();
    }
    setSessionState(previous =>
      previous?.status === "awaiting_review" ? null : previous
    );
    setStatus(previous => (previous === "awaiting_review" ? "idle" : previous));
  };

  const openApprovalPanel = (
    nextPending: PendingReviewItem[],
    options?: {
      focusLatest?: boolean;
      selectId?: string;
      selectedIndex?: number;
      previewMode?: ApprovalPreviewMode;
    }
  ) => {
    lastApprovalIntentRef.current = null;
    lastApprovalHintRef.current = null;
    dismissedApprovalQueueSignatureRef.current = null;
    closeAllOverlayPanels({ keepApproval: true });
    updatePendingState(nextPending, {
      ...options,
      open: nextPending.length > 0,
    });
  };

  const syncApprovalPanelState = (
    updater: (previous: ApprovalPanelState) => ApprovalPanelState
  ) => {
    const nextState = updater(approvalPanelRef.current);
    approvalPanelRef.current = nextState;
    setApprovalPanel(nextState);
  };

  useEffect(() => {
    if (pendingReviews.length === 0 || approvalPanelRef.current.active) {
      return;
    }

    const queueSignature = getPendingQueueSignature(pendingReviews);
    if (dismissedApprovalQueueSignatureRef.current === queueSignature) {
      return;
    }

    syncApprovalPanelState(previous => ({
      ...createNextApprovalPanelState(pendingReviews, {
        open: true,
        selectedIndex: previous.selectedIndex,
        previewMode: previous.previewMode,
      }),
      lastOpenedAt: new Date().toISOString(),
    }));
  }, [approvalPanel.active, pendingReviews]);

  const isBlockedApprovalAttempt = (id: string, now = Date.now()) =>
    shouldBlockRepeatedApproval(
      approvalPanelRef.current.blockedItemId,
      id,
      approvalPanelRef.current.blockedAt,
      now,
      APPROVAL_BLOCK_RETRY_MS
    );

  const markApprovalInFlight = (
    id: string,
    action: ApprovalActionKind,
    resumePending = false
  ) => {
    syncApprovalPanelState(previous => ({
      ...previous,
      inFlightId: id,
      actionState: action,
      resumePending,
    }));
  };

  const approvePendingReview = (id: string) => {
    if (isBlockedApprovalAttempt(id)) {
      return;
    }
    if (!approvalActionRef.current.acquire(`approve:${id}`)) {
      return;
    }
    enqueueTask(async () => {
      try {
        const before = mcpService.listPending();
        const target = before.find(item => item.id === id);
        const currentIndex = computeNextApprovalSelection(
          before.findIndex(item => item.id === id),
          before.length
        );
        const wasOpen = approvalPanelRef.current.active;
        const optimisticPending = before.filter(item => item.id !== id);
        if (target) {
          updatePendingState(optimisticPending, {
            open: shouldKeepApprovalPanelOpen(optimisticPending.length, wasOpen),
            selectedIndex: computeNextApprovalSelection(
              currentIndex,
              optimisticPending.length
            ),
            clearBlocked: true,
          });
        }
        const result = await mcpService.approve(id);
        const nextPending = mcpService.listPending();

        if (!target) {
          updatePendingState(nextPending, {
            open: shouldKeepApprovalPanelOpen(
              nextPending.length,
              wasOpen
            ),
            selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
            clearBlocked: true,
          });
          pushSystemMessage(buildApprovalMessage("Approval error", undefined, [result.message]), {
            kind: "error",
            tone: "danger",
            color: "red",
          });
          await recordSessionMemory(getMemorySessionId(), {
            kind: "error",
            text: buildApprovalMessage("Approval error", undefined, [result.message]),
            priority: 85,
            entities: {
              status: ["error"],
            },
          });
          return;
        }

        if (!result.ok) {
          const blockedState = {
            itemId: target.id,
            reason: extractMessageBody(result.message) || result.message,
            at: Date.now(),
            lastAction: "approve" as const,
          };
          updatePendingState(nextPending, {
            open: shouldKeepApprovalPanelOpen(
              nextPending.length,
              wasOpen
            ),
            selectedIndex: currentIndex,
            blocked: blockedState,
          });
          if (nextPending.some(item => item.id === target.id)) {
            syncApprovalPanelState(previous => ({
              ...previous,
              blockedItemId: blockedState.itemId,
              blockedReason: blockedState.reason,
              blockedAt: blockedState.at,
              lastAction: blockedState.lastAction,
            }));
          }
          pushSystemMessage(
            buildApprovalMessage("Approval error", target, [
              extractMessageBody(result.message) || result.message,
            ]),
            {
              kind: "error",
              tone: "danger",
              color: "red",
            }
          );
          await recordSessionMemory(getMemorySessionId(), {
            kind: "error",
            text: buildApprovalMessage("Approval error", target, [
              extractMessageBody(result.message) || result.message,
            ]),
            priority: 90,
            entities: {
              path: [target.request.path],
              action: [target.request.action],
              status: ["error"],
            },
          });
          return;
        }

        updatePendingState(nextPending, {
          open: shouldKeepApprovalPanelOpen(
            nextPending.length,
            wasOpen
          ),
          selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
          clearBlocked: true,
        });

        const output = extractMessageBody(result.message);
        pushSystemMessage(
          buildApprovalMessage("Approved", target, output ? [output] : []),
          {
            kind: "review_status",
            tone: "success",
            color: actionColor(target.request.action) ?? "green",
          }
        );
        await recordSessionMemory(getMemorySessionId(), {
          kind: "approval",
          text: buildApprovalMessage("Approved", target, output ? [output] : []),
          priority: 80,
          entities: {
            path: [target.request.path],
            action: [target.request.action],
            status: ["approved"],
          },
        });
        await resumeSuspendedTask(result.message);
        repairSettledReviewState();
      } finally {
        syncApprovalPanelState(previous => clearApprovalInFlight(previous));
        approvalActionRef.current.release();
      }
    });
  };

  const rejectPendingReview = (id: string) => {
    if (!approvalActionRef.current.acquire(`reject:${id}`)) {
      return;
    }
    enqueueTask(async () => {
      try {
        const before = mcpService.listPending();
        const target = before.find(item => item.id === id);
        const currentIndex = computeNextApprovalSelection(
          before.findIndex(item => item.id === id),
          before.length
        );
        const wasOpen = approvalPanelRef.current.active;
        const optimisticPending = before.filter(item => item.id !== id);
        if (target) {
          updatePendingState(optimisticPending, {
            open: shouldKeepApprovalPanelOpen(optimisticPending.length, wasOpen),
            selectedIndex: computeNextApprovalSelection(
              currentIndex,
              optimisticPending.length
            ),
            clearBlocked: true,
          });
        }
        const result = mcpService.reject(id);
        const nextPending = mcpService.listPending();

        if (!target || !result.ok) {
          updatePendingState(nextPending, {
            open: shouldKeepApprovalPanelOpen(
              nextPending.length,
              wasOpen
            ),
            selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
          });
          pushSystemMessage(
            buildApprovalMessage(
              "Approval error",
              target,
              [extractMessageBody(result.message) || result.message]
            ),
            {
              kind: "error",
              tone: "danger",
              color: "red",
            }
          );
          await recordSessionMemory(getMemorySessionId(), {
            kind: "error",
            text: buildApprovalMessage(
              "Approval error",
              target,
              [extractMessageBody(result.message) || result.message]
            ),
            priority: 85,
            entities: {
              path: target?.request.path ? [target.request.path] : undefined,
              action: target?.request.action ? [target.request.action] : undefined,
              status: ["error"],
            },
          });
          return;
        }

        updatePendingState(nextPending, {
          open: shouldKeepApprovalPanelOpen(
            nextPending.length,
            wasOpen
          ),
          selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
          clearBlocked: true,
        });

        const cancelledSuspendedTask = Boolean(suspendedTaskRef.current);
        const rejectionMessage = buildApprovalMessage(
          "Rejected",
          target,
          cancelledSuspendedTask
            ? [
                "current suspended task cancelled",
                "add requirements and send a new prompt when ready",
              ]
            : []
        );
        if (cancelledSuspendedTask) {
          await cancelSuspendedTask(rejectionMessage, {
            suppressApprovalQueue: true,
          });
        } else {
          pushSystemMessage(rejectionMessage, {
            kind: "review_status",
            tone: "warning",
            color: "yellow",
          });
        }
        await recordSessionMemory(getMemorySessionId(), {
          kind: "approval",
          text: rejectionMessage,
          priority: 78,
          entities: {
            path: [target.request.path],
            action: [target.request.action],
            status: ["rejected"],
          },
        });
      } finally {
        syncApprovalPanelState(previous => clearApprovalInFlight(previous));
        approvalActionRef.current.release();
      }
    });
  };

  const processPendingBatch = (
    action: ApprovalActionKind,
    selector: (item: PendingReviewItem) => boolean,
    scopeLabel: string
  ) => {
    enqueueTask(async () => {
      try {
        const before = mcpService.listPending();
        const targets = before.filter(selector);
        const wasOpen = approvalPanelRef.current.active;
        const currentIndex = approvalPanelRef.current.selectedIndex;

        if (targets.length === 0) {
          pushSystemMessage(
            `No pending operations matched batch scope: ${scopeLabel}.`,
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          return;
        }

        syncApprovalPanelState(previous => ({
          ...previous,
          inFlightId: `batch:${action}`,
          actionState: action,
          resumePending: Boolean(suspendedTaskRef.current),
        }));

        let success = 0;
        let failed = 0;
        let resumeMessage: string | null = null;
        const failureDetails: string[] = [];
        const hadSuspendedTask = Boolean(suspendedTaskRef.current);

        for (const target of targets) {
          const result =
            action === "approve"
              ? await mcpService.approve(target.id)
              : mcpService.reject(target.id);
          if (result.ok) {
            success += 1;
            if (action === "approve" && !resumeMessage) {
              resumeMessage = result.message;
            }
            continue;
          }

          failed += 1;
          failureDetails.push(
            `${target.id}: ${extractMessageBody(result.message) || result.message}`
          );
        }

        const nextPending = mcpService.listPending();
        updatePendingState(nextPending, {
          open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
          selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
          clearBlocked: true,
        });

        const processedRisk = summarizePendingRisk(targets);
        const remainingRisk = summarizePendingRisk(nextPending);
        const title =
          action === "approve" ? "Batch approved" : "Batch rejected";
        const tone =
          failed > 0
            ? "warning"
            : action === "approve"
              ? "success"
              : "warning";
        const color = failed > 0 ? "yellow" : action === "approve" ? "green" : "yellow";
        const lines = [
          `scope: ${scopeLabel}`,
          `processed: ${targets.length}`,
          `success: ${success}`,
          `failed: ${failed}`,
          `remaining: ${nextPending.length}`,
          action === "reject" && hadSuspendedTask && success > 0
            ? "suspended task: cancelled"
            : "",
          `processed_risk: high ${processedRisk.high} | medium ${processedRisk.medium} | low ${processedRisk.low}`,
          `remaining_risk: high ${remainingRisk.high} | medium ${remainingRisk.medium} | low ${remainingRisk.low}`,
          ...failureDetails.slice(0, 3).map(detail => `failure: ${detail}`),
          failureDetails.length > 3
            ? `failure: ... ${failureDetails.length - 3} more`
            : "",
        ].filter(Boolean);

        const summaryMessage = buildApprovalMessage(title, undefined, lines);
        if (action === "reject" && hadSuspendedTask && success > 0) {
          await cancelSuspendedTask(summaryMessage, {
            suppressApprovalQueue: true,
          });
        } else {
          pushSystemMessage(summaryMessage, {
            kind: "review_status",
            tone,
            color,
          });
        }
        await recordSessionMemory(getMemorySessionId(), {
          kind: failed > 0 ? "error" : "approval",
          text: summaryMessage,
          priority: failed > 0 ? 86 : 79,
          entities: {
            action: [action],
            status: [failed > 0 ? "partial" : "ok"],
          },
        });

        if (resumeMessage) {
          await resumeSuspendedTask(resumeMessage);
        }
        repairSettledReviewState();
      } finally {
        syncApprovalPanelState(previous => clearApprovalInFlight(previous));
      }
    });
  };

  const approveCurrentPendingReview = () => {
    const target =
      pendingReviewsRef.current[approvalPanelRef.current.selectedIndex];
    if (!target) {
      pushSystemMessage("Approval error\nNo pending operation selected.", {
        kind: "error",
        tone: "danger",
        color: "red",
      });
      return;
    }
    if (approvalActionRef.current.isLocked()) {
      return;
    }
    const now = Date.now();
    if (
      !canRetryBlockedApproval(
        approvalPanelRef.current.blockedItemId,
        target.id,
        approvalPanelRef.current.blockedAt,
        now,
        APPROVAL_BLOCK_RETRY_MS
      )
    ) {
      return;
    }
    if (
      isRepeatedInteraction(
        lastApprovalIntentRef,
        `approve:${target.id}:${approvalPanelRef.current.selectedIndex}`
      )
    ) {
      return;
    }
    markApprovalInFlight(
      target.id,
      "approve",
      Boolean(suspendedTaskRef.current)
    );
    pushSystemMessage(`Approving ${target.id}...`, {
      kind: "system_hint",
      tone: "info",
      color: "cyan",
    });
    approvePendingReview(target.id);
  };

  const rejectCurrentPendingReview = () => {
    const target =
      pendingReviewsRef.current[approvalPanelRef.current.selectedIndex];
    if (!target) {
      pushSystemMessage("Approval error\nNo pending operation selected.", {
        kind: "error",
        tone: "danger",
        color: "red",
      });
      return;
    }
    if (approvalActionRef.current.isLocked()) {
      return;
    }
    if (
      isRepeatedInteraction(
        lastApprovalIntentRef,
        `reject:${target.id}:${approvalPanelRef.current.selectedIndex}`
      )
    ) {
      return;
    }
    markApprovalInFlight(
      target.id,
      "reject",
      Boolean(suspendedTaskRef.current)
    );
    pushSystemMessage(`Rejecting ${target.id}...`, {
      kind: "system_hint",
      tone: "info",
      color: "cyan",
    });
    rejectPendingReview(target.id);
  };

  inputAdapterHook((inputValue, key) => {
    if (authPanelRef.current.active) {
      if (key.escape) {
        closeAuthPanel({
          skipped: authPanelRef.current.mode === "auto_onboarding",
        });
        return;
      }

      if (key.return || (key.ctrl && inputValue.toLowerCase() === "d")) {
        advanceAuthPanel();
        return;
      }

      if (authPanelRef.current.step === "confirm") {
        if (!key.ctrl && !key.meta && /^[123]$/.test(inputValue)) {
          const index = Number(inputValue) - 1;
          const targetStep = AUTH_PANEL_STEPS[index];
          if (targetStep && targetStep !== "confirm") {
            setAuthPanelStep(targetStep);
          }
        }
        return;
      }

      if (key.leftArrow) {
        applyAuthEditorTransform(moveCursorLeft);
        return;
      }

      if (key.rightArrow) {
        applyAuthEditorTransform(moveCursorRight);
        return;
      }

      if (key.backspace) {
        applyAuthEditorTransform(deleteBackwardAtCursor);
        return;
      }

      if (key.delete) {
        applyAuthEditorTransform(deleteForwardAtCursor);
        return;
      }

      if (inputValue && !key.ctrl && !key.meta) {
        applyAuthEditorTransform(state =>
          insertTextAtCursor(state, inputValue.replace(/\r?\n/g, ""))
        );
      }
      return;
    }

    if (modelPickerRef.current.active) {
      if (key.escape) {
        closeModelPicker();
        pushSystemMessage("Model picker closed.");
        return;
      }

      if (key.upArrow) {
        setModelPicker(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.models.length,
            "up"
          ),
        }));
        return;
      }

      if (key.downArrow) {
        setModelPicker(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.models.length,
            "down"
          ),
        }));
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setModelPicker(previous => {
          const total = previous.models.length;
          if (total === 0) {
            return previous;
          }
          return {
            ...previous,
            selectedIndex: movePagedSelection(
              previous.selectedIndex,
              total,
              previous.pageSize,
              key.leftArrow ? "left" : "right"
            ),
          };
        });
        return;
      }

      if (key.return) {
        confirmModelPickerSelection();
      }
      return;
    }

    if (providerPickerRef.current.active) {
      if (key.escape) {
        closeProviderPicker();
        pushSystemMessage("Provider picker closed.");
        return;
      }

      if (key.upArrow) {
        setProviderPicker(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.providers.length,
            "up"
          ),
        }));
        return;
      }

      if (key.downArrow) {
        setProviderPicker(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.providers.length,
            "down"
          ),
        }));
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setProviderPicker(previous => {
          const total = previous.providers.length;
          if (total === 0) {
            return previous;
          }
          return {
            ...previous,
            selectedIndex: movePagedSelection(
              previous.selectedIndex,
              total,
              previous.pageSize,
              key.leftArrow ? "left" : "right"
            ),
          };
        });
        return;
      }

      if (key.return) {
        confirmProviderPickerSelection();
      }
      return;
    }

    if (resumePickerRef.current.active) {
      if (key.escape) {
        closeResumePicker();
        pushSystemMessage("Resume picker closed.");
        return;
      }

      if (key.upArrow) {
        setResumePicker(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.sessions.length,
            "up"
          ),
        }));
        return;
      }

      if (key.downArrow) {
        setResumePicker(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.sessions.length,
            "down"
          ),
        }));
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setResumePicker(previous => {
          const total = previous.sessions.length;
          if (total === 0) {
            return previous;
          }
          return {
            ...previous,
            selectedIndex: movePagedSelection(
              previous.selectedIndex,
              total,
              previous.pageSize,
              key.leftArrow ? "left" : "right"
            ),
          };
        });
        return;
      }

      if (key.return) {
        confirmResumePickerSelection();
      }
      return;
    }

    if (sessionsPanelRef.current.active) {
      if (key.escape) {
        closeSessionsPanel();
        pushSystemMessage("Sessions panel closed.");
        return;
      }

      if (key.upArrow) {
        setSessionsPanel(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.sessions.length,
            "up"
          ),
        }));
        return;
      }

      if (key.downArrow) {
        setSessionsPanel(previous => ({
          ...previous,
          selectedIndex: cycleSelection(
            previous.selectedIndex,
            previous.sessions.length,
            "down"
          ),
        }));
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setSessionsPanel(previous => {
          const total = previous.sessions.length;
          if (total === 0) {
            return previous;
          }
          return {
            ...previous,
            selectedIndex: movePagedSelection(
              previous.selectedIndex,
              total,
              previous.pageSize,
              key.leftArrow ? "left" : "right"
            ),
          };
        });
        return;
      }

      if (key.return) {
        confirmSessionsPanelSelection();
      }
      return;
    }

    if (!approvalPanelRef.current.active) {
      if (key.tab) {
        if (
          !shellShortcutPreview.active &&
          activeFileMention &&
          fileMentionLookup.suggestions.length > 0
        ) {
          applyFileMentionSuggestion(
            fileMentionLookup.suggestions[fileSelectedIndex]
          );
          return;
        }

        if (commandModeActive && slashSuggestions.length > 0) {
          applySlashSuggestion(slashSuggestions[commandSelectedIndex]);
          return;
        }
      }

      if (key.upArrow) {
        if (
          !shellShortcutPreview.active &&
          activeFileMention &&
          fileMentionLookup.suggestions.length > 0
        ) {
          setFileSuggestionIndex(previous =>
            cycleSelection(
              previous,
              fileMentionLookup.suggestions.length,
              "up"
            )
          );
          return;
        }
        if (commandModeActive && slashSuggestions.length > 0) {
          setCommandSuggestionIndex(previous =>
            cycleSelection(previous, slashSuggestions.length, "up")
          );
          return;
        }
        if (!input) {
          recallInputHistory("up");
          return;
        }
        const moved = moveCursorVertical(
          {
            value: input,
            cursorOffset: inputCursorOffset,
          },
          "up",
          preferredInputColumnRef.current
        );
        commitEditorState(moved.state, {
          preferredColumn: moved.preferredColumn,
        });
        return;
      }

      if (key.downArrow) {
        if (
          !shellShortcutPreview.active &&
          activeFileMention &&
          fileMentionLookup.suggestions.length > 0
        ) {
          setFileSuggestionIndex(previous =>
            cycleSelection(
              previous,
              fileMentionLookup.suggestions.length,
              "down"
            )
          );
          return;
        }
        if (commandModeActive && slashSuggestions.length > 0) {
          setCommandSuggestionIndex(previous =>
            cycleSelection(previous, slashSuggestions.length, "down")
          );
          return;
        }
        if (!input) {
          recallInputHistory("down");
          return;
        }
        const moved = moveCursorVertical(
          {
            value: input,
            cursorOffset: inputCursorOffset,
          },
          "down",
          preferredInputColumnRef.current
        );
        commitEditorState(moved.state, {
          preferredColumn: moved.preferredColumn,
        });
        return;
      }

      if (key.leftArrow) {
        applyEditorTransform(moveCursorLeft);
        return;
      }

      if (key.rightArrow) {
        applyEditorTransform(moveCursorRight);
        return;
      }

      if (key.backspace) {
        applyEditorTransform(deleteBackwardAtCursor);
        return;
      }

      if (key.delete) {
        applyEditorTransform(deleteForwardAtCursor);
        return;
      }

      if (key.return) {
        applyEditorTransform(state => insertTextAtCursor(state, "\n"));
        return;
      }

      if (key.ctrl && inputValue.toLowerCase() === "d") {
        submit();
        return;
      }

      if (inputValue && !key.ctrl && !key.meta) {
        applyEditorTransform(state => insertTextAtCursor(state, inputValue));
        return;
      }
    }

    if (!approvalPanelRef.current.active) {
      return;
    }

    if (pendingReviewsRef.current.length === 0) {
      closeApprovalPanel();
      return;
    }

    if (approvalPanelRef.current.inFlightId) {
      return;
    }

    if (key.escape) {
      closeApprovalPanel({ suppressCurrentQueue: true });
      pushSystemMessage("Approval panel closed.", {
        kind: "system_hint",
        tone: "neutral",
        color: "gray",
      });
      return;
    }

    if (key.upArrow) {
      lastApprovalIntentRef.current = null;
      syncApprovalPanelState(previous => {
        const nextSelectedIndex = cycleSelection(
          previous.selectedIndex,
          pendingReviewsRef.current.length,
          "up"
        );
        return clearApprovalBlockOnSelectionChange(
          {
            ...previous,
            previewOffset: 0,
          },
          nextSelectedIndex
        );
      });
      return;
    }

    if (key.downArrow) {
      lastApprovalIntentRef.current = null;
      syncApprovalPanelState(previous => {
        const nextSelectedIndex = cycleSelection(
          previous.selectedIndex,
          pendingReviewsRef.current.length,
          "down"
        );
        return clearApprovalBlockOnSelectionChange(
          {
            ...previous,
            previewOffset: 0,
          },
          nextSelectedIndex
        );
      });
      return;
    }

    if (key.tab) {
      lastApprovalIntentRef.current = null;
      syncApprovalPanelState(previous => ({
        ...previous,
        previewMode: previous.previewMode === "summary" ? "full" : "summary",
        previewOffset: 0,
      }));
      return;
    }

    if (key.pageDown || inputValue.toLowerCase() === "j") {
      lastApprovalIntentRef.current = null;
      syncApprovalPanelState(previous => ({
        ...previous,
        previewOffset: clampPreviewOffset(
          getApprovalPreviewText(
            pendingReviewsRef.current[previous.selectedIndex],
            previous.previewMode
          ),
          previous.previewOffset + 20
        ),
      }));
      return;
    }

    if (key.pageUp || inputValue.toLowerCase() === "k") {
      lastApprovalIntentRef.current = null;
      syncApprovalPanelState(previous => ({
        ...previous,
        previewOffset: clampPreviewOffset(
          getApprovalPreviewText(
            pendingReviewsRef.current[previous.selectedIndex],
            previous.previewMode
          ),
          previous.previewOffset - 20
        ),
      }));
      return;
    }

    if (!key.ctrl && inputValue.toLowerCase() === "a") {
      approveCurrentPendingReview();
      return;
    }

    if (key.return) {
      const selected = pendingReviewsRef.current[approvalPanelRef.current.selectedIndex];
      const token = `enter-hint:${selected?.id ?? "none"}:${approvalPanelRef.current.selectedIndex}`;
      if (isRepeatedInteraction(lastApprovalHintRef, token, 1500)) {
        return;
      }
      pushSystemMessage(
        "Approval panel uses a to approve and r to reject. Enter is disabled to avoid accidental approval.",
        {
          kind: "system_hint",
          tone: "neutral",
          color: "gray",
        }
      );
      return;
    }

    if (
      !key.ctrl &&
      (inputValue.toLowerCase() === "r" || inputValue.toLowerCase() === "d")
    ) {
      rejectCurrentPendingReview();
    }
  });

  const submit = () => {
    if (authPanelRef.current.active) {
      advanceAuthPanel();
      return;
    }

    const rawInput = input;
    const query = rawInput.trim();

    if (query === "/cancel") {
      void cancelCurrentTurn().then(cancelled => {
        if (!cancelled) {
          pushSystemMessage("No running turn to cancel.", {
            kind: "system_hint",
            tone: "neutral",
            color: "gray",
          });
        }
      });
      clearInput();
      return;
    }

    if (
      status === "preparing" ||
      status === "requesting" ||
      status === "streaming"
    ) {
      return;
    }

    if (!query && modelPicker.active) {
      confirmModelPickerSelection();
      return;
    }

    if (!query && providerPicker.active) {
      confirmProviderPickerSelection();
      return;
    }

    if (!query && resumePicker.active) {
      confirmResumePickerSelection();
      return;
    }

    if (!query && sessionsPanel.active) {
      confirmSessionsPanelSelection();
      return;
    }

    if (
      modelPicker.active ||
      providerPicker.active ||
      resumePicker.active ||
      sessionsPanel.active ||
      approvalPanel.active
    ) {
      return;
    }

    if (!query) {
      return;
    }

    pushInputHistory(rawInput);

    if (shellShortcutPreview.active) {
      if (!shellShortcutPreview.request) {
        pushSystemMessage(
          "Usage: !shell <command> | !shell open [cwd] | !shell read | !shell status | !shell interrupt | !shell close",
          {
            kind: "system_hint",
            tone: "warning",
            color: "yellow",
          }
        );
        clearInput();
        return;
      }

      executeDirectToolRequest(shellShortcutPreview.request);
      clearInput();
      return;
    }

    if (query === "/help") {
      setItems(previous => [
        ...previous,
        {
          role: "system",
          text: HELP_TEXT,
          kind: "system_hint",
          tone: "neutral",
          color: "gray",
        },
      ]);
      clearInput();
      return;
    }

    if (query === "/login") {
      if (!authRef.current) {
        pushSystemMessage("Auth runtime unavailable. HTTP onboarding is not enabled in this build.", {
          kind: "error",
          tone: "danger",
          color: "red",
        });
        clearInput();
        return;
      }
      openAuthPanel("manual_login");
      clearInput();
      return;
    }

    if (query === "/logout") {
      enqueueTask(async () => {
        const authRuntime = authRef.current;
        if (!authRuntime) {
          pushSystemMessage("Auth runtime unavailable. Nothing to log out.", {
            kind: "error",
            tone: "danger",
            color: "red",
          });
          return;
        }
        const result = await authRuntime.logout();
        pushSystemMessage(result.message, {
          kind: "system_hint",
          tone:
            result.status.credentialSource === "process_env" ? "warning" : "info",
          color:
            result.status.credentialSource === "process_env" ? "yellow" : "cyan",
        });
      });
      clearInput();
      return;
    }

    if (query === "/auth") {
      enqueueTask(async () => {
        const nextStatus = authRef.current
          ? await authRef.current.getStatus()
          : ({
              mode: transport.getProvider() === "local-core" ? "local" : "http",
              credentialSource: "none",
              provider: transport.getProvider(),
              model: transport.getModel(),
              persistenceTarget: null,
              onboardingAvailable: false,
              httpReady: transport.getProvider() !== "local-core",
            } as AuthStatus);
        pushSystemMessage(formatAuthStatusMessage(nextStatus), {
          kind: "system_hint",
          tone: "info",
          color: "cyan",
        });
      });
      clearInput();
      return;
    }

    if (query === "/provider") {
      enqueueTask(async () => {
        const providers = await transport.listProviders();
        updateCurrentProviderState(transport.getProvider());
        if (providers.length === 0) {
          pushSystemMessage("No providers available. Set CYRENE_BASE_URL or switch with /provider <url>.");
          return;
        }
        const current = transport.getProvider();
        const selectedIndex = Math.max(0, providers.indexOf(current));
        closeAllOverlayPanels({ keepProviderPicker: true });
        const nextState = {
          active: true,
          providers,
          selectedIndex,
          pageSize: PROVIDER_PAGE_SIZE,
        };
        providerPickerRef.current = nextState;
        setProviderPicker(nextState);
        pushSystemMessage(
          "Provider picker opened: Up/Down select, Left/Right page, Enter switch, Esc cancel."
        );
      });
      clearInput();
      return;
    }

    if (query === "/provider refresh") {
      enqueueTask(async () => {
        const result = await transport.refreshModels();
        updateCurrentProviderState(transport.getProvider());
        updateCurrentModelState(transport.getModel());
        if (result.ok) {
          pushSystemMessage(
            `${result.message}\nProvider: ${transport.getProvider()}\nCurrent model: ${transport.getModel()}`
          );
        } else {
          pushSystemMessage(`[provider refresh failed] ${result.message}`);
        }
      });
      clearInput();
      return;
    }

    if (query.startsWith("/provider ")) {
      const nextProvider = query.slice("/provider ".length).trim();
      enqueueTask(async () => {
        if (!nextProvider) {
          pushSystemMessage("Usage: /provider <base_url> | /provider refresh");
          return;
        }
        if (isRepeatedActionInteraction(`command:provider:${nextProvider}`)) {
          return;
        }
        const result = await transport.setProvider(nextProvider);
        updateCurrentProviderState(transport.getProvider());
        updateCurrentModelState(transport.getModel());
        if (result.ok) {
          pushSystemMessage(result.message);
        } else {
          pushSystemMessage(`[provider switch failed] ${result.message}`);
        }
      });
      clearInput();
      return;
    }

    if (query === "/model") {
      enqueueTask(async () => {
        const models = await transport.listModels();
        updateCurrentModelState(transport.getModel());
      if (models.length === 0) {
          pushSystemMessage("No models available. Try /model refresh.");
          return;
        }
        const current = transport.getModel();
        const selectedIndex = Math.max(0, models.indexOf(current));
        closeAllOverlayPanels({ keepModelPicker: true });
        const nextState = {
          active: true,
          models,
          selectedIndex,
          pageSize: MODEL_PAGE_SIZE,
        };
        modelPickerRef.current = nextState;
        setModelPicker(nextState);
        pushSystemMessage(
          "Model picker opened: Up/Down select, Left/Right page, Enter switch, Esc cancel."
        );
      });
      clearInput();
      return;
    }

    if (query === "/model refresh") {
      enqueueTask(async () => {
        const result = await transport.refreshModels();
        updateCurrentModelState(transport.getModel());
        if (result.ok) {
          pushSystemMessage(
            `${result.message}\nCurrent model: ${transport.getModel()}`
          );
        } else {
          pushSystemMessage(`[model refresh failed] ${result.message}`);
        }
      });
      clearInput();
      return;
    }

    if (query.startsWith("/model ")) {
      const nextModel = query.slice("/model ".length).trim();
      enqueueTask(async () => {
        if (!nextModel) {
          pushSystemMessage("Usage: /model <model_name>");
          return;
        }
        if (isRepeatedActionInteraction(`command:model:${nextModel}`)) {
          return;
        }
        const result = await transport.setModel(nextModel);
        updateCurrentModelState(transport.getModel());
        if (result.ok) {
          pushSystemMessage(result.message);
        } else {
          pushSystemMessage(`[model switch failed] ${result.message}`);
        }
      });
      clearInput();
      return;
    }

    if (queuedSubmitRef.current) {
      return;
    }

    const queuedSubmit = { rawInput, query };
    queuedSubmitRef.current = queuedSubmit;

    enqueueTask(async () => {
      let activeSubmitRunId: number | null = null;
      try {
      if (query === "/new") {
        const created = await sessionStore.createSession();
        pendingChoiceRef.current = null;
        updateActiveSessionIdState(created.id);
        clearLiveAssistantSegment();
        setItems([
          {
            role: "system",
            text: defaultSystemText,
            kind: "system_hint",
            tone: "neutral",
            color: "gray",
          },
          {
            role: "system",
            text: `Started new session: ${created.id}`,
            kind: "system_hint",
            tone: "info",
            color: "cyan",
          },
        ]);
        clearInput();
        return;
      }

      if (query === "/undo") {
        const result = await mcpService.undoLastMutation();
        pushSystemMessage(result.message, {
          kind: result.ok ? "system_hint" : "error",
          tone: result.ok ? "info" : "danger",
          color: result.ok ? "cyan" : "red",
        });
        clearInput();
        return;
      }

      if (query === "/search-session") {
        pushSystemMessage("Usage: /search-session <query> | /search-session #<tag> [query]");
        clearInput();
        return;
      }

      if (query.startsWith("/search-session ")) {
        const raw = query.slice("/search-session ".length).trim();
        if (!raw) {
          pushSystemMessage("Usage: /search-session <query> | /search-session #<tag> [query]");
          clearInput();
          return;
        }

        const parts = raw.split(/\s+/).filter(Boolean);
        const tagToken = parts.find(part => part.startsWith("#"));
        const tag = tagToken ? tagToken.replace(/^#+/, "").trim() : "";
        const textQuery = parts
          .filter(part => !part.startsWith("#"))
          .join(" ")
          .trim();
        const searchQuery = textQuery || (tag ? "" : raw);

        const results = await sessionStore.searchSessions(searchQuery, {
          tag: tag || undefined,
          limit: 12,
        });
        if (results.length === 0) {
          pushSystemMessage(
            `No sessions matched.${tag ? ` (tag: ${tag})` : ""}`
          );
          clearInput();
          return;
        }
        pushSystemMessage(
          [
            `Found ${results.length} session(s):`,
            ...results.map((item, index) => {
              const tagSuffix =
                item.tags.length > 0 ? ` #${item.tags.join(" #")}` : "";
              return `${index + 1}. ${item.id} | ${item.title}${tagSuffix}`;
            }),
          ].join("\n")
        );
        clearInput();
        return;
      }

      if (query === "/tag") {
        pushSystemMessage("Usage: /tag list | /tag add <tag> | /tag remove <tag>");
        clearInput();
        return;
      }

      if (query === "/tag list") {
        const session = await ensureActiveSession();
        if (session.tags.length === 0) {
          pushSystemMessage("No tags yet. Use /tag add <tag>.");
        } else {
          pushSystemMessage(`Session tags:\n${session.tags.map(tag => `#${tag}`).join("\n")}`);
        }
        clearInput();
        return;
      }

      if (query.startsWith("/tag add ")) {
        const tag = query.slice("/tag add ".length).trim();
        if (!tag) {
          pushSystemMessage("Usage: /tag add <tag>");
          clearInput();
          return;
        }
        const session = await ensureActiveSession();
        const next = await sessionStore.addTag(session.id, tag);
        pushSystemMessage(
          next.tags.length > 0
            ? `Tag added. Current tags: ${next.tags.map(item => `#${item}`).join(" ")}`
            : "Tag was not added."
        );
        clearInput();
        return;
      }

      if (query.startsWith("/tag remove ")) {
        const tag = query.slice("/tag remove ".length).trim();
        if (!tag) {
          pushSystemMessage("Usage: /tag remove <tag>");
          clearInput();
          return;
        }
        const session = await ensureActiveSession();
        const next = await sessionStore.removeTag(session.id, tag);
        if (next.tags.length === 0) {
          pushSystemMessage("Tag removed. No tags remain.");
        } else {
          pushSystemMessage(`Tag removed. Current tags: ${next.tags.map(item => `#${item}`).join(" ")}`);
        }
        clearInput();
        return;
      }

      if (query === "/system") {
        pushSystemMessage(`Current system prompt:\n${systemPrompt}`);
        clearInput();
        return;
      }

      if (query === "/state") {
        const activeSession = activeSessionId
          ? await sessionStore.loadSession(activeSessionId)
          : null;
        pushSystemMessage(formatReducerStateMessage(activeSession), {
          kind: "system_hint",
          tone: "info",
          color: "cyan",
        });
        clearInput();
        return;
      }

      if (query === "/system reset") {
        setSystemPrompt(defaultSystemPrompt);
        pushSystemMessage("System prompt reset to default.");
        clearInput();
        return;
      }

      if (query.startsWith("/system ")) {
        const nextPrompt = query.slice("/system ".length).trim();
        if (!nextPrompt) {
          pushSystemMessage("Usage: /system <prompt_text> | /system reset");
          clearInput();
          return;
        }
        setSystemPrompt(nextPrompt);
        pushSystemMessage("System prompt updated for current runtime.");
        clearInput();
        return;
      }

      if (query === "/sessions") {
        const sessions = await sessionStore.listSessions();
        if (sessions.length === 0) {
          pushSystemMessage("No sessions yet.");
        } else {
          closeAllOverlayPanels({ keepSessionsPanel: true });
          const nextState = {
            active: true,
            sessions,
            selectedIndex: 0,
            pageSize: RESUME_PAGE_SIZE,
          };
          sessionsPanelRef.current = nextState;
          setSessionsPanel(nextState);
          pushSystemMessage(
            "Sessions panel opened: Up/Down select, Left/Right page, Enter resume, Esc cancel.",
            { kind: "system_hint", tone: "info", color: "cyan" }
          );
        }
        clearInput();
        return;
      }

        if (query === "/review") {
          const pending = mcpService.listPending();
          if (pending.length === 0) {
            pushSystemMessage(
              "No pending operations.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          } else {
            const risk = summarizePendingRisk(pending);
            pushSystemMessage(
              buildApprovalMessage("Approval required", undefined, [
                `pending: ${pending.length}`,
                `risk: high ${risk.high} | medium ${risk.medium} | low ${risk.low}`,
                "panel: opened",
                "keys: ↑/↓ select  Tab preview  a approve  r reject  Esc close",
                "batch: /approve low | /approve all | /reject all",
              ]),
              { kind: "review_status", tone: "warning", color: "yellow" }
            );
            openApprovalPanel(pending, {
              focusLatest: true,
              previewMode: "summary",
            });
          }
          clearInput();
          return;
        }

      if (query.startsWith("/review ")) {
        const id = query.slice("/review ".length).trim();
        if (!id) {
          pushSystemMessage("Usage: /review <id>");
          clearInput();
          return;
        }

        const pending = mcpService.listPending();
        const target = pending.find(item => item.id === id);
        if (!target) {
          pushSystemMessage(buildApprovalMessage("Approval error", undefined, [
            `pending operation not found: ${id}`,
          ]), {
            kind: "error",
            tone: "danger",
            color: "red",
          });
          clearInput();
          return;
        }

        pushSystemMessage(
          buildApprovalMessage("Approval required", target, [
            "panel: opened",
            "preview: full",
          ]),
          { kind: "review_status", tone: "warning", color: "yellow" }
        );
        openApprovalPanel(pending, {
          selectId: target.id,
          previewMode: "full",
        });
        clearInput();
        return;
      }

      if (query === "/approve") {
        const pending = mcpService.listPending();
        if (pending.length === 0) {
          pushSystemMessage(
            "No pending operations to approve.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          clearInput();
          return;
        }
        if (pending.length > 1) {
          const risk = summarizePendingRisk(pending);
          pushSystemMessage(
            buildApprovalMessage("Approval required", undefined, [
              `pending: ${pending.length}`,
              `risk: high ${risk.high} | medium ${risk.medium} | low ${risk.low}`,
              "use: /approve <id>, /approve low, /approve all, or the approval panel",
            ]),
            { kind: "review_status", tone: "warning", color: "yellow" }
          );
          clearInput();
          return;
        }
        const only = pending[0];
        if (!only) {
          pushSystemMessage(
            "No pending operations to approve.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          clearInput();
          return;
        }
        approvePendingReview(only.id);
        clearInput();
        return;
      }

      if (query === "/approve low") {
        processPendingBatch(
          "approve",
          item => getApprovalRisk(item.request.action) !== "high",
          "low-and-medium"
        );
        clearInput();
        return;
      }

      if (query === "/approve all") {
        processPendingBatch("approve", () => true, "all");
        clearInput();
        return;
      }

      if (query.startsWith("/approve ")) {
        const id = query.slice("/approve ".length).trim();
        if (!id) {
          pushSystemMessage("Usage: /approve <id> | /approve low | /approve all");
          clearInput();
          return;
        }
        approvePendingReview(id);
        clearInput();
        return;
      }

      if (query === "/reject") {
        const pending = mcpService.listPending();
        if (pending.length === 0) {
          pushSystemMessage(
            "No pending operations to reject.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          clearInput();
          return;
        }
        if (pending.length > 1) {
          const risk = summarizePendingRisk(pending);
          pushSystemMessage(
            buildApprovalMessage("Approval required", undefined, [
              `pending: ${pending.length}`,
              `risk: high ${risk.high} | medium ${risk.medium} | low ${risk.low}`,
              "use: /reject <id>, /reject all, or the approval panel",
            ]),
            { kind: "review_status", tone: "warning", color: "yellow" }
          );
          clearInput();
          return;
        }
        const only = pending[0];
        if (!only) {
          pushSystemMessage(
            "No pending operations to reject.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          clearInput();
          return;
        }
        rejectPendingReview(only.id);
        clearInput();
        return;
      }

      if (query === "/reject all") {
        processPendingBatch("reject", () => true, "all");
        clearInput();
        return;
      }

      if (query.startsWith("/reject ")) {
        const id = query.slice("/reject ".length).trim();
        if (!id) {
          pushSystemMessage("Usage: /reject <id> | /reject all");
          clearInput();
          return;
        }
        rejectPendingReview(id);
        clearInput();
        return;
      }

      if (query === "/pins") {
        const session = await ensureActiveSession();
        if (session.focus.length === 0) {
          pushSystemMessage("No pinned focus yet. Use /pin <note>.");
        } else {
          pushSystemMessage(
            `Pinned focus:\n${session.focus
              .map((item, index) => `${index + 1}. ${item}`)
              .join("\n")}`
          );
        }
        clearInput();
        return;
      }

      if (query === "/pin") {
        pushSystemMessage("Usage: /pin <important_note>");
        clearInput();
        return;
      }

      if (query.startsWith("/pin ")) {
        const note = query.slice("/pin ".length).trim();
        if (!note) {
          pushSystemMessage("Usage: /pin <important_note>");
          clearInput();
          return;
        }
        const session = await ensureActiveSession();
        if (session.focus.length >= pinMaxCount) {
          pushSystemMessage(
            `Pin limit reached (${pinMaxCount}). Remove low-value pins with /unpin <index> before adding more.`
          );
          clearInput();
          return;
        }
        const next = await sessionStore.addFocus(session.id, note);
        pushSystemMessage(
          `Pinned to session focus (${next.focus.length}): ${note}`
        );
        clearInput();
        return;
      }

      if (query === "/unpin") {
        pushSystemMessage("Usage: /unpin <index>");
        clearInput();
        return;
      }

      if (query.startsWith("/unpin ")) {
        const raw = query.slice("/unpin ".length).trim();
        const index = Number(raw);
        if (!Number.isInteger(index) || index <= 0) {
          pushSystemMessage("Usage: /unpin <index> (1-based)");
          clearInput();
          return;
        }
        const session = await ensureActiveSession();
        if (session.focus.length === 0) {
          pushSystemMessage("No pinned focus to remove.");
          clearInput();
          return;
        }
        if (index > session.focus.length) {
          pushSystemMessage(
            `Index out of range. Current pin count: ${session.focus.length}`
          );
          clearInput();
          return;
        }
        const removed = session.focus[index - 1];
        const next = await sessionStore.removeFocus(session.id, index - 1);
        pushSystemMessage(
          `Unpinned #${index}: ${removed}\nRemaining pins: ${next.focus.length}`
        );
        clearInput();
        return;
      }

      if (query === "/resume") {
        const sessions = await sessionStore.listSessions();
        if (sessions.length === 0) {
          pushSystemMessage("No sessions to resume.");
        } else {
          closeAllOverlayPanels({ keepResumePicker: true });
          const nextState = {
            active: true,
            sessions,
            selectedIndex: 0,
            pageSize: RESUME_PAGE_SIZE,
          };
          resumePickerRef.current = nextState;
          setResumePicker(nextState);
          pushSystemMessage(
            "Resume picker opened: Up/Down select, Left/Right page, Enter resume, Esc cancel.",
            { kind: "system_hint", tone: "info", color: "cyan" }
          );
        }
        clearInput();
        return;
      }

      if (query.startsWith("/resume ")) {
        const targetId = query.slice("/resume ".length).trim();
        if (!targetId) {
          pushSystemMessage("Usage: /resume <session_id>");
          clearInput();
          return;
        }

        await loadSessionIntoChat(targetId);
        clearInput();
        return;
      }

      if (query.startsWith("/")) {
        pushSystemMessage(
          `Unknown command: ${query}\nUse /help to view available commands.`,
          {
            kind: "error",
            tone: "danger",
            color: "red",
          }
        );
        clearInput();
        return;
      }

      const choiceResolution = resolvePendingChoiceInput(
        query,
        pendingChoiceRef.current
      );
      if (choiceResolution.kind === "missing_choice") {
        pushSystemMessage(
          `No active numbered options to resolve. Re-send the full request instead of just "${query}".`,
          {
            kind: "system_hint",
            tone: "warning",
            color: "yellow",
          }
        );
        clearInput();
        return;
      }
      if (choiceResolution.kind === "unknown_choice") {
        pushSystemMessage(
          `Choice ${choiceResolution.requestedIndex} is not available. Current choices: ${choiceResolution.availableIndexes.join(", ")}.`,
          {
            kind: "system_hint",
            tone: "warning",
            color: "yellow",
          }
        );
        clearInput();
        return;
      }

      const submittedTask =
        choiceResolution.kind === "resolved"
          ? choiceResolution.resolvedQuery
          : rawInput;
      const displayUserText =
        choiceResolution.kind === "resolved"
          ? choiceResolution.displayText
          : rawInput;
      const shouldClearPendingChoiceOnSubmit = Boolean(pendingChoiceRef.current);

      setItems(previous => [
        ...previous,
        { role: "user", text: displayUserText, kind: "transcript", tone: "neutral" },
      ]);
      clearLiveAssistantSegment();
      clearInput();
      setInputCursorOffset(0);
      preferredInputColumnRef.current = null;
      setSessionState(null);
      setStatus("preparing");

      const assistantBufferRef = { current: "" };
      const runId = nextTurnRunIdRef.current + 1;
      nextTurnRunIdRef.current = runId;
      activeSubmitRunId = runId;
      const activeTurn: ActiveTurnState = {
        runId,
        sessionId: null,
        assistantBufferRef,
        cancelRequested: false,
      };
      activeTurnRef.current = activeTurn;
      let recoverySessionId: string | null = null;
      let recoveryStartedAt = "";
      let recoveryUserText = displayUserText;
      let inFlightUpdateChain = Promise.resolve();
      let lastPersistedAssistantText = "";
      let lastPersistedAt = 0;

      const isCurrentTurnActive = () =>
        activeTurnRef.current?.runId === runId && !activeTurn.cancelRequested;

      const queueInFlightUpdate = (
        inFlightTurn: SessionRecord["inFlightTurn"]
      ) => {
        if (!recoverySessionId || activeTurn.cancelRequested) {
          return inFlightUpdateChain;
        }
        inFlightUpdateChain = inFlightUpdateChain.then(async () => {
          if (!isCurrentTurnActive()) {
            return;
          }
          await syncInFlightTurn(recoverySessionId!, inFlightTurn);
        });
        return inFlightUpdateChain;
      };

      const getVisibleAssistantText = () =>
        parseAssistantStateUpdate(assistantBufferRef.current).visibleText.trim();

      const persistInFlightAssistant = async (force = false) => {
        if (!recoverySessionId || !recoveryStartedAt || !isCurrentTurnActive()) {
          return;
        }

        const assistantText = getVisibleAssistantText();
        const nowMs = Date.now();
        if (
          !force &&
          (assistantText === lastPersistedAssistantText ||
            nowMs - lastPersistedAt < 500)
        ) {
          return;
        }

        lastPersistedAssistantText = assistantText;
        lastPersistedAt = nowMs;
        await queueInFlightUpdate({
          userText: recoveryUserText,
          assistantText,
          startedAt: recoveryStartedAt,
          updatedAt: new Date(nowMs).toISOString(),
        });
      };

      activeTurn.clearInFlightState = async () => {
        try {
          await inFlightUpdateChain;
        } catch {
          // Ignore stale recovery update failures while cancelling.
        }
        if (recoverySessionId) {
          await syncInFlightTurn(recoverySessionId, null);
          return;
        }
        if (activeTurn.sessionId) {
          await syncInFlightTurn(activeTurn.sessionId, null);
        }
      };

      try {
        const session = await ensureActiveSession(
          choiceResolution.kind === "resolved" ? submittedTask : query
        );
        activeTurn.sessionId = session.id;
        if (!isCurrentTurnActive()) {
          return;
        }
        if (shouldClearPendingChoiceOnSubmit) {
          await syncPendingChoice(session.id, null);
        }
        const promptContextBase = await sessionStore.getPromptContext(
          session.id,
          submittedTask
        );
        if (!isCurrentTurnActive()) {
          return;
        }
        const promptContext = autoSummaryRefresh
          ? promptContextBase
          : {
              ...promptContextBase,
              reducerMode: "disabled" as ReducerMode,
            };
        const now = new Date().toISOString();
        await sessionStore.appendMessage(session.id, {
          role: "user",
          text: displayUserText,
          createdAt: now,
        });
        if (!isCurrentTurnActive()) {
          return;
        }
        recoverySessionId = session.id;
        recoveryStartedAt = now;
        await queueInFlightUpdate({
          userText: recoveryUserText,
          assistantText: "",
          startedAt: now,
          updatedAt: now,
        });
        if (!isCurrentTurnActive()) {
          return;
        }

        setStatus("requesting");
        const prompt = buildPromptWithContext(
          submittedTask,
          systemPrompt,
          projectPrompt,
          promptContext
        );

        const runResult = await runQuerySessionImpl({
          query: prompt,
          originalTask: submittedTask,
          queryMaxToolSteps,
          transport,
          onState: next => {
            if (!isCurrentTurnActive()) {
              return;
            }
            setSessionState(next);
            setStatus(next.status as ChatStatus);
          },
          onTextDelta: text => {
            if (!isCurrentTurnActive()) {
              return;
            }
            assistantBufferRef.current += text;
            appendToLiveAssistant(assistantBufferRef.current);
            void persistInFlightAssistant();
          },
          onUsage: usage => {
            accumulateRuntimeUsage(usage);
          },
          onToolStatus: message => {
            if (!isCurrentTurnActive()) {
              return;
            }
            pushStreamingSystemMessage(message, {
              kind: "tool_status",
              tone: "info",
              color: "cyan",
            });
          },
          onToolCall: async (toolName, toolInput) => {
            if (!isCurrentTurnActive()) {
              throw new Error(TURN_CANCELLED_ERROR);
            }
            const result = await mcpService.handleToolCall(toolName, toolInput);
            if (!isCurrentTurnActive()) {
              throw new Error(TURN_CANCELLED_ERROR);
            }
            if (result.pending) {
              const reviewMode = isHighRiskReviewAction(result.pending.request.action)
                ? "block"
                : "queue";
              pushStreamingSystemMessage(
                `Approval required | ${result.pending.request.action} ${result.pending.request.path} | ${result.pending.id} | panel opened`,
                {
                  kind: "review_status",
                  tone: reviewMode === "block" ? "warning" : "info",
                  color: reviewMode === "block" ? "red" : "yellow",
                }
              );
              openApprovalPanel(mcpService.listPending(), {
                focusLatest: true,
                previewMode: "summary",
              });
              return {
                message: `Approval required ${result.pending.id} | ${result.pending.request.action} | ${result.pending.request.path}`,
                reviewMode,
              };
            }
            const summarized = summarizeToolMessage(result.message);
            pushStreamingSystemMessage(summarized.text, {
              kind: summarized.kind,
              tone: summarized.tone,
              color: summarized.color,
            });
            const detail = parseToolDetail(result.message);
            await recordSessionMemory(session.id, {
              kind: result.ok ? "tool_result" : "error",
              text: summarized.text,
              priority: result.ok ? 72 : 88,
              entities: {
                path: detail.path ? [detail.path] : undefined,
                toolName: detail.action ? [detail.action] : toolName ? [toolName] : undefined,
                action: detail.action ? [detail.action] : undefined,
                status: [result.ok ? "ok" : "error"],
              },
            });
            return { message: result.message };
          },
          onError: async message => {
            if (!isCurrentTurnActive() && message === TURN_CANCELLED_ERROR) {
              return;
            }
            if (!isCurrentTurnActive()) {
              return;
            }
            pushStreamingSystemMessage(
              `Stream error: ${message}`,
              {
                kind: "error",
                tone: "danger",
                color: "red",
              }
            );
            await recordSessionMemory(session.id, {
              kind: "error",
              text: `Stream error: ${message}`,
              priority: 92,
              entities: {
                status: ["error"],
                queryTerms: [submittedTask],
                },
              });
            await persistInFlightAssistant(true);
          },
        });
        await inFlightUpdateChain;
        if (!isCurrentTurnActive()) {
          return;
        }
        await consumeQueryRunResult(session.id, assistantBufferRef, runResult);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage === TURN_CANCELLED_ERROR ||
          !isCurrentTurnActive()
        ) {
          return;
        }
        await persistInFlightAssistant(true);
        setSessionState(null);
        setStatus("idle");
        throw error;
      }
      } finally {
        const activeTurnForSubmit = activeTurnRef.current;
        const waitingForReviewResume =
          activeTurnForSubmit !== null &&
          suspendedTaskRef.current?.assistantBufferRef ===
            activeTurnForSubmit.assistantBufferRef;
        if (
          activeSubmitRunId !== null &&
          activeTurnForSubmit?.runId === activeSubmitRunId &&
          !waitingForReviewResume
        ) {
          activeTurnRef.current = null;
        }
        if (queuedSubmitRef.current === queuedSubmit) {
          queuedSubmitRef.current = null;
        }
      }
    });
  };

  const inputCommandState: InputCommandState = useMemo(() => {
    const mode: InputMode = shellShortcutPreview.active
      ? "shell"
      : activeFileMention
        ? "file"
        : commandModeActive
          ? "command"
          : "idle";

    return {
      active: mode === "command",
      mode,
      currentCommand:
        mode === "command"
          ? slashSuggestions[commandSelectedIndex]?.command ??
            commandQuery.split(/\s+/, 2).join(" ")
          : null,
      suggestions: slashSuggestions,
      selectedIndex:
        mode === "file"
          ? fileSelectedIndex
          : mode === "command"
            ? commandSelectedIndex
            : 0,
      historyPosition:
        historyCursor >= 0 && inputHistory.length > 0
          ? historyCursor + 1
          : null,
      historySize: inputHistory.length,
      shellShortcut: shellShortcutPreview,
      fileMentions: {
        references: fileMentionReferences,
        activeQuery: activeFileMention?.query ?? null,
        suggestions: fileMentionLookup.suggestions,
        loading: fileMentionLookup.loading,
      },
    };
  }, [
    activeFileMention,
    commandModeActive,
    commandQuery,
    commandSelectedIndex,
    fileMentionLookup.loading,
    fileMentionLookup.suggestions,
    fileMentionReferences,
    fileSelectedIndex,
    historyCursor,
    inputHistory.length,
    shellShortcutPreview,
    slashSuggestions,
  ]);

  return {
    input,
    inputCursorOffset,
    inputCommandState,
    items,
    liveAssistantText,
    status,
    sessionState,
    usage: sessionState?.usage ?? null,
    resumePicker,
    sessionsPanel,
    modelPicker,
    providerPicker,
    pendingReviews,
    approvalPanel,
    authPanel,
    activeSessionId,
    currentModel,
    currentProvider,
    exitSummary: runtimeUsageSummary,
    closeApprovalPanel: () => closeApprovalPanel({ suppressCurrentQueue: true }),
    openApprovalPanel,
    approveCurrentPendingReview,
    rejectCurrentPendingReview,
    setInput: setInputValue,
    submit,
  };
};
