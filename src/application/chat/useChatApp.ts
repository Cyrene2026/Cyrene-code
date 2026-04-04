import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  runQuerySession,
  type RunQuerySessionResult,
} from "../../core/query/runQuerySession";
import type { TokenUsage } from "../../core/query/tokenUsage";
import { buildPromptWithContext } from "../../core/session/buildPromptWithContext";
import { compressContext } from "../../core/session/contextCompression";
import type { SessionMemoryInput } from "../../core/session/memoryIndex";
import type { SessionStore } from "../../core/session/store";
import type { QuerySessionState } from "../../core/query/sessionMachine";
import type { QueryTransport } from "../../core/query/transport";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";
import type { SessionListItem, SessionRecord } from "../../core/session/types";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import type { MpcAction, PendingReviewItem } from "../../core/tools/mcp/types";
import { createApprovalActionLock } from "./approvalActionLock";
import { summarizeToolMessage } from "./toolMessageSummary";
import { useInputAdapter } from "./inputAdapter";
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
  queryMaxToolSteps?: number;
  mcpService: FileMcpService;
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

type SuspendedTaskState = {
  sessionId: string;
  assistantBufferRef: { current: string };
  resume: (toolResultMessage: string) => Promise<RunQuerySessionResult>;
};

type CommandSpec = {
  command: string;
  description: string;
};

type InputCommandState = {
  active: boolean;
  currentCommand: string | null;
  suggestions: CommandSpec[];
  historyPosition: number | null;
  historySize: number;
};

type RuntimeUsageSummary = {
  startedAt: string;
  activeSessionId: string | null;
  currentModel: string;
  requestCount: number;
  summaryRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

const defaultSystemText =
  "Type /help to view commands. Use /resume to open session picker.";
const RESUME_PAGE_SIZE = 8;
const MODEL_PAGE_SIZE = 8;
const PROVIDER_PAGE_SIZE = 8;
const INPUT_HISTORY_LIMIT = 100;
const MULTILINE_DISPLAY_TOKEN = " ↩ ";
const SUMMARY_RECENT_KEEP = 8;
const SUMMARY_TRIGGER_MESSAGE_COUNT = SUMMARY_RECENT_KEEP + 1;
const SUMMARY_TRIGGER_CHAR_THRESHOLD = 1200;
const SUMMARY_RECENT_MESSAGE_LIMIT = 16;
const SUMMARY_RECENT_CHAR_BUDGET = 12000;
const COMMAND_SPECS: CommandSpec[] = [
  { command: "/help", description: "show command list" },
  { command: "/provider", description: "open provider picker" },
  { command: "/provider refresh", description: "refresh current provider models" },
  { command: "/provider <url>", description: "switch provider directly" },
  { command: "/model", description: "open model picker" },
  { command: "/model refresh", description: "refresh available models" },
  { command: "/model <name>", description: "switch model directly" },
  { command: "/system", description: "show current system prompt" },
  { command: "/system <text>", description: "set system prompt for this runtime" },
  { command: "/system reset", description: "restore default system prompt" },
  { command: "/sessions", description: "open sessions panel" },
  { command: "/resume", description: "open session resume picker" },
  { command: "/resume <id>", description: "resume a session by id" },
  { command: "/new", description: "start a fresh session" },
  { command: "/pin <note>", description: "pin important context" },
  { command: "/pins", description: "list pinned context" },
  { command: "/unpin <index>", description: "remove a pin" },
  { command: "/review", description: "open approval queue" },
  { command: "/review <id>", description: "inspect one pending operation" },
  { command: "/approve [id]", description: "approve pending operation(s)" },
  { command: "/reject [id]", description: "reject pending operation(s)" },
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

const shouldRefreshSessionSummary = (session: SessionRecord) => {
  if (session.summary.trim()) {
    return false;
  }

  const nonSystemMessages = session.messages.filter(message => message.role !== "system");
  if (nonSystemMessages.length >= SUMMARY_TRIGGER_MESSAGE_COUNT) {
    return true;
  }

  const totalChars = nonSystemMessages.reduce(
    (count, message) => count + message.text.length,
    0
  );
  return totalChars >= SUMMARY_TRIGGER_CHAR_THRESHOLD;
};

const buildSummaryPrompt = (session: SessionRecord) => {
  const compressed = compressContext(session.messages, SUMMARY_RECENT_KEEP, 6);
  const recentMessages = session.messages
    .filter(message => message.role !== "system")
    .slice(-SUMMARY_RECENT_MESSAGE_LIMIT);
  const recentLines: string[] = [];
  let charBudget = 0;

  for (const message of recentMessages) {
    const normalized = message.text.trim();
    if (!normalized) {
      continue;
    }
    const line = `${message.role.toUpperCase()}: ${normalized}`;
    if (
      recentLines.length > 0 &&
      charBudget + line.length > SUMMARY_RECENT_CHAR_BUDGET
    ) {
      break;
    }
    recentLines.push(line);
    charBudget += line.length;
  }

  return [
    "Summarize the prior conversation into 4-6 short Markdown bullet points.",
    "Keep only the task goal, confirmed facts, constraints, key decisions, and unfinished work.",
    "Do not add headings, prose paragraphs, code fences, speculation, or any new information.",
    "Prefer concrete nouns and file/tool names when they were explicitly mentioned.",
    "",
    "Deterministic fallback summary:",
    compressed.summary || "(none)",
    "",
    "Recent conversation:",
    recentLines.join("\n") || "(none)",
  ].join("\n");
};

const buildSummaryUsageHint = (
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null
) =>
  usage
    ? `summary updated | prompt ${usage.promptTokens} | completion ${usage.completionTokens} | total ${usage.totalTokens}`
    : "summary updated";

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
const APPROVAL_BLOCK_RETRY_MS = 1500;

const createRuntimeUsageSummary = (model: string): RuntimeUsageSummary => ({
  startedAt: new Date().toISOString(),
  activeSessionId: null,
  currentModel: model,
  requestCount: 0,
  summaryRequestCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const addUsageToRuntimeSummary = (
  summary: RuntimeUsageSummary,
  usage: TokenUsage,
  source: "query" | "summary"
): RuntimeUsageSummary => ({
  ...summary,
  requestCount: summary.requestCount + (source === "query" ? 1 : 0),
  summaryRequestCount: summary.summaryRequestCount + (source === "summary" ? 1 : 0),
  promptTokens: summary.promptTokens + usage.promptTokens,
  completionTokens: summary.completionTokens + usage.completionTokens,
  totalTokens: summary.totalTokens + usage.totalTokens,
});

const encodeInputForDisplay = (value: string) =>
  value.replace(/\r?\n/g, MULTILINE_DISPLAY_TOKEN);

const decodeInputFromDisplay = (value: string) =>
  value.split(MULTILINE_DISPLAY_TOKEN).join("\n");

const isMultilinePasteChunk = (value: string, key: Record<string, boolean>) =>
  /[\r\n]/.test(value) &&
  !Object.values(key).some(Boolean);

export const useChatApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  queryMaxToolSteps = 24,
  mcpService,
  runQuerySessionImpl = runQuerySession,
  inputAdapterHook = useInputAdapter,
}: UseChatAppParams) => {
  const [input, setInput] = useState("");
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

  const queueRef = useRef(Promise.resolve());
  const approvalActionRef = useRef(createApprovalActionLock());
  const resumePickerRef = useRef(resumePicker);
  const sessionsPanelRef = useRef(sessionsPanel);
  const modelPickerRef = useRef(modelPicker);
  const providerPickerRef = useRef(providerPicker);
  const approvalPanelRef = useRef(approvalPanel);
  const pendingReviewsRef = useRef(pendingReviews);
  const dismissedApprovalQueueSignatureRef = useRef<string | null>(null);
  const lastApprovalIntentRef = useRef<{ token: string; at: number } | null>(null);
  const lastApprovalHintRef = useRef<{ token: string; at: number } | null>(null);
  const suspendedTaskRef = useRef<SuspendedTaskState | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef(-1);
  const inputDraftRef = useRef("");
  const liveAssistantTextRef = useRef("");

  resumePickerRef.current = resumePicker;
  sessionsPanelRef.current = sessionsPanel;
  modelPickerRef.current = modelPicker;
  providerPickerRef.current = providerPicker;
  approvalPanelRef.current = approvalPanel;
  pendingReviewsRef.current = pendingReviews;
  inputHistoryRef.current = inputHistory;
  historyCursorRef.current = historyCursor;

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

  const accumulateRuntimeUsage = (usage: TokenUsage, source: "query" | "summary") => {
    setRuntimeUsageSummary(previous =>
      addUsageToRuntimeSummary(previous, usage, source)
    );
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

  const setInputValue = (next: string) => {
    const decoded = decodeInputFromDisplay(next);
    inputDraftRef.current = decoded;
    if (historyCursorRef.current !== -1) {
      historyCursorRef.current = -1;
      setHistoryCursor(-1);
    }
    setInput(decoded);
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
        setInput(history[nextIndex] ?? "");
        return;
      }
      const nextIndex = Math.max(0, historyCursorRef.current - 1);
      historyCursorRef.current = nextIndex;
      setHistoryCursor(nextIndex);
      setInput(history[nextIndex] ?? "");
      return;
    }

    if (historyCursorRef.current === -1) {
      return;
    }
    if (historyCursorRef.current >= history.length - 1) {
      historyCursorRef.current = -1;
      setHistoryCursor(-1);
      setInput(inputDraftRef.current);
      return;
    }
    const nextIndex = historyCursorRef.current + 1;
    historyCursorRef.current = nextIndex;
    setHistoryCursor(nextIndex);
    setInput(history[nextIndex] ?? "");
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

  const setLiveAssistantSegment = (next: string) => {
    liveAssistantTextRef.current = next;
    startTransition(() => {
      setLiveAssistantText(next);
    });
  };

  const clearLiveAssistantSegment = () => {
    liveAssistantTextRef.current = "";
    setLiveAssistantText("");
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

  const isRepeatedApprovalInteraction = (
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

  const finalizeAssistantBuffer = async (
    sessionId: string,
    assistantBuffer: string
  ) => {
    if (!assistantBuffer.trim()) {
      return;
    }

    await sessionStore.appendMessage(sessionId, {
      role: "assistant",
      text: assistantBuffer,
      createdAt: new Date().toISOString(),
    });
  };

  const consumeQueryRunResult = async (
    sessionId: string,
    assistantBufferRef: { current: string },
    result: RunQuerySessionResult | void
  ) => {
    if (!result || result.status === "completed") {
      suspendedTaskRef.current = null;
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
      return;
    }

    suspendedTaskRef.current = {
      sessionId,
      assistantBufferRef,
      resume: result.resume,
    };
  };

  const resumeSuspendedTask = (toolResultMessage: string) => {
    const suspended = suspendedTaskRef.current;
    if (!suspended) {
      return;
    }

    enqueueTask(async () => {
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
    });
  };

  const ensureActiveSession = async (titleHint?: string) => {
    if (activeSessionId) {
      const loaded = await sessionStore.loadSession(activeSessionId);
      if (loaded) {
        return loaded;
      }
    }

    const created = await sessionStore.createSession(titleHint);
    updateActiveSessionIdState(created.id);
    return created;
  };

  const maybeRefreshSessionSummary = async (session: SessionRecord) => {
    if (!transport.summarizeText || !shouldRefreshSessionSummary(session)) {
      return session;
    }

    const summaryResult = await transport.summarizeText(buildSummaryPrompt(session));
    if (summaryResult.usage) {
      accumulateRuntimeUsage(summaryResult.usage, "summary");
    }
    if (!summaryResult.ok || !summaryResult.text?.trim()) {
      return session;
    }

    const updated = await sessionStore.updateSummary(
      session.id,
      summaryResult.text.trim()
    );
    pushSystemMessage(buildSummaryUsageHint(summaryResult.usage), {
      kind: "system_hint",
      tone: "neutral",
      color: "gray",
    });
    return updated;
  };

  const appendToLiveAssistant = (text: string) => {
    setLiveAssistantSegment(liveAssistantTextRef.current + text);
  };

  const applyLoadedSession = (loaded: SessionRecord) => {
    const shouldShowLegacyHint = hasLegacyCompressedMarkdown(loaded);
    clearLiveAssistantSegment();
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

  const closeAllOverlayPanels = (options?: {
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
    enqueueTask(async () => {
      const selected = modelPicker.models[modelPicker.selectedIndex];
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
    enqueueTask(async () => {
      const selected = providerPicker.providers[providerPicker.selectedIndex];
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
    enqueueTask(async () => {
      const selected = resumePicker.sessions[resumePicker.selectedIndex];
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
    enqueueTask(async () => {
      const selected = sessionsPanel.sessions[sessionsPanel.selectedIndex];
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
        resumeSuspendedTask(result.message);
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

        pushSystemMessage(buildApprovalMessage("Rejected", target), {
          kind: "review_status",
          tone: "warning",
          color: "yellow",
        });
        await recordSessionMemory(getMemorySessionId(), {
          kind: "approval",
          text: buildApprovalMessage("Rejected", target),
          priority: 78,
          entities: {
            path: [target.request.path],
            action: [target.request.action],
            status: ["rejected"],
          },
        });
        resumeSuspendedTask(result.message);
      } finally {
        syncApprovalPanelState(previous => clearApprovalInFlight(previous));
        approvalActionRef.current.release();
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
      isRepeatedApprovalInteraction(
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
      isRepeatedApprovalInteraction(
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

    if (
      !approvalPanelRef.current.active &&
      !modelPickerRef.current.active &&
      !providerPickerRef.current.active &&
      !resumePickerRef.current.active &&
      !sessionsPanelRef.current.active &&
      isMultilinePasteChunk(inputValue, key)
    ) {
      setInputValue(input + inputValue);
      return;
    }

    if (!approvalPanelRef.current.active) {
      if (key.upArrow) {
        recallInputHistory("up");
        return;
      }

      if (key.downArrow) {
        recallInputHistory("down");
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

    if (inputValue.toLowerCase() === "a") {
      approveCurrentPendingReview();
      return;
    }

    if (key.return) {
      const selected = pendingReviewsRef.current[approvalPanelRef.current.selectedIndex];
      const token = `enter-hint:${selected?.id ?? "none"}:${approvalPanelRef.current.selectedIndex}`;
      if (isRepeatedApprovalInteraction(lastApprovalHintRef, token, 1500)) {
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

    if (inputValue.toLowerCase() === "r" || inputValue.toLowerCase() === "d") {
      rejectCurrentPendingReview();
    }
  });

  const submit = () => {
    const query = input.trim();
    if (status === "streaming") {
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

    pushInputHistory(query);

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
      setInput("");
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
      setInput("");
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
      setInput("");
      return;
    }

    if (query.startsWith("/provider ")) {
      const nextProvider = query.slice("/provider ".length).trim();
      enqueueTask(async () => {
        if (!nextProvider) {
          pushSystemMessage("Usage: /provider <base_url> | /provider refresh");
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
      setInput("");
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
      setInput("");
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
      setInput("");
      return;
    }

    if (query.startsWith("/model ")) {
      const nextModel = query.slice("/model ".length).trim();
      enqueueTask(async () => {
        if (!nextModel) {
          pushSystemMessage("Usage: /model <model_name>");
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
      setInput("");
      return;
    }

    enqueueTask(async () => {
      if (query === "/new") {
        const created = await sessionStore.createSession();
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
        setInput("");
        return;
      }

      if (query === "/system") {
        pushSystemMessage(`Current system prompt:\n${systemPrompt}`);
        setInput("");
        return;
      }

      if (query === "/system reset") {
        setSystemPrompt(defaultSystemPrompt);
        pushSystemMessage("System prompt reset to default.");
        setInput("");
        return;
      }

      if (query.startsWith("/system ")) {
        const nextPrompt = query.slice("/system ".length).trim();
        if (!nextPrompt) {
          pushSystemMessage("Usage: /system <prompt_text> | /system reset");
          setInput("");
          return;
        }
        setSystemPrompt(nextPrompt);
        pushSystemMessage("System prompt updated for current runtime.");
        setInput("");
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
        setInput("");
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
            pushSystemMessage(
              buildApprovalMessage("Approval required", undefined, [
                `pending: ${pending.length}`,
                "panel: opened",
                "keys: ↑/↓ select  Tab preview  a approve  r reject  Esc close",
              ]),
              { kind: "review_status", tone: "warning", color: "yellow" }
            );
            openApprovalPanel(pending, {
              focusLatest: true,
              previewMode: "summary",
            });
          }
          setInput("");
          return;
        }

      if (query.startsWith("/review ")) {
        const id = query.slice("/review ".length).trim();
        if (!id) {
          pushSystemMessage("Usage: /review <id>");
          setInput("");
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
          setInput("");
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
        setInput("");
        return;
      }

      if (query === "/approve") {
        const pending = mcpService.listPending();
        if (pending.length === 0) {
          pushSystemMessage(
            "No pending operations to approve.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          setInput("");
          return;
        }
        if (pending.length > 1) {
          pushSystemMessage(
            buildApprovalMessage("Approval required", undefined, [
              `pending: ${pending.length}`,
              "use: /approve <id> or the approval panel",
            ]),
            { kind: "review_status", tone: "warning", color: "yellow" }
          );
          setInput("");
          return;
        }
        const only = pending[0];
        if (!only) {
          pushSystemMessage(
            "No pending operations to approve.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          setInput("");
          return;
        }
        approvePendingReview(only.id);
        setInput("");
        return;
      }

      if (query.startsWith("/approve ")) {
        const id = query.slice("/approve ".length).trim();
        if (!id) {
          pushSystemMessage("Usage: /approve <id>");
          setInput("");
          return;
        }
        approvePendingReview(id);
        setInput("");
        return;
      }

      if (query === "/reject") {
        const pending = mcpService.listPending();
        if (pending.length === 0) {
          pushSystemMessage(
            "No pending operations to reject.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          setInput("");
          return;
        }
        if (pending.length > 1) {
          pushSystemMessage(
            buildApprovalMessage("Approval required", undefined, [
              `pending: ${pending.length}`,
              "use: /reject <id> or the approval panel",
            ]),
            { kind: "review_status", tone: "warning", color: "yellow" }
          );
          setInput("");
          return;
        }
        const only = pending[0];
        if (!only) {
          pushSystemMessage(
            "No pending operations to reject.",
            { kind: "system_hint", tone: "neutral", color: "white" }
          );
          setInput("");
          return;
        }
        rejectPendingReview(only.id);
        setInput("");
        return;
      }

      if (query.startsWith("/reject ")) {
        const id = query.slice("/reject ".length).trim();
        if (!id) {
          pushSystemMessage("Usage: /reject <id>");
          setInput("");
          return;
        }
        rejectPendingReview(id);
        setInput("");
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
        setInput("");
        return;
      }

      if (query === "/pin") {
        pushSystemMessage("Usage: /pin <important_note>");
        setInput("");
        return;
      }

      if (query.startsWith("/pin ")) {
        const note = query.slice("/pin ".length).trim();
        if (!note) {
          pushSystemMessage("Usage: /pin <important_note>");
          setInput("");
          return;
        }
        const session = await ensureActiveSession();
        if (session.focus.length >= pinMaxCount) {
          pushSystemMessage(
            `Pin limit reached (${pinMaxCount}). Remove low-value pins with /unpin <index> before adding more.`
          );
          setInput("");
          return;
        }
        const next = await sessionStore.addFocus(session.id, note);
        pushSystemMessage(
          `Pinned to session focus (${next.focus.length}): ${note}`
        );
        setInput("");
        return;
      }

      if (query === "/unpin") {
        pushSystemMessage("Usage: /unpin <index>");
        setInput("");
        return;
      }

      if (query.startsWith("/unpin ")) {
        const raw = query.slice("/unpin ".length).trim();
        const index = Number(raw);
        if (!Number.isInteger(index) || index <= 0) {
          pushSystemMessage("Usage: /unpin <index> (1-based)");
          setInput("");
          return;
        }
        const session = await ensureActiveSession();
        if (session.focus.length === 0) {
          pushSystemMessage("No pinned focus to remove.");
          setInput("");
          return;
        }
        if (index > session.focus.length) {
          pushSystemMessage(
            `Index out of range. Current pin count: ${session.focus.length}`
          );
          setInput("");
          return;
        }
        const removed = session.focus[index - 1];
        const next = await sessionStore.removeFocus(session.id, index - 1);
        pushSystemMessage(
          `Unpinned #${index}: ${removed}\nRemaining pins: ${next.focus.length}`
        );
        setInput("");
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
        setInput("");
        return;
      }

      if (query.startsWith("/resume ")) {
        const targetId = query.slice("/resume ".length).trim();
        if (!targetId) {
          pushSystemMessage("Usage: /resume <session_id>");
          setInput("");
          return;
        }

        await loadSessionIntoChat(targetId);
        setInput("");
        return;
      }

      setItems(previous => [
        ...previous,
        { role: "user", text: query, kind: "transcript", tone: "neutral" },
      ]);
      clearLiveAssistantSegment();
      setInput("");

      const session = await ensureActiveSession(query);
      await maybeRefreshSessionSummary(session);
      const promptContext = await sessionStore.getPromptContext(session.id, query);
      const now = new Date().toISOString();
      await sessionStore.appendMessage(session.id, {
        role: "user",
        text: query,
        createdAt: now,
      });

      const prompt = buildPromptWithContext(
        query,
        systemPrompt,
        projectPrompt,
        promptContext
      );
      const assistantBufferRef = { current: "" };

      const runResult = await runQuerySessionImpl({
        query: prompt,
        originalTask: query,
        queryMaxToolSteps,
        transport,
        onState: next => {
          setSessionState(next);
          setStatus(next.status as ChatStatus);
        },
        onTextDelta: text => {
          assistantBufferRef.current += text;
          appendToLiveAssistant(text);
        },
        onUsage: usage => {
          accumulateRuntimeUsage(usage, "query");
        },
        onToolStatus: message => {
          pushStreamingSystemMessage(message, {
            kind: "tool_status",
            tone: "info",
            color: "cyan",
          });
        },
        onToolCall: async (toolName, toolInput) => {
          const result = await mcpService.handleToolCall(toolName, toolInput);
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
              queryTerms: [query],
            },
          });
        },
      });
      await consumeQueryRunResult(session.id, assistantBufferRef, runResult);
    });
  };

  const inputCommandState: InputCommandState = useMemo(() => {
    const suggestions = getSlashSuggestions(input);
    return {
      active: suggestions.length > 0,
      currentCommand: suggestions[0]?.command ?? null,
      suggestions,
      historyPosition:
        historyCursor >= 0 && inputHistory.length > 0
          ? historyCursor + 1
          : null,
      historySize: inputHistory.length,
    };
  }, [historyCursor, input, inputHistory.length]);

  return {
    input: encodeInputForDisplay(input),
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
