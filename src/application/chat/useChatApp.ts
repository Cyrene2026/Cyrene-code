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
import type {
  ProviderProfileOverrideMap,
  ProviderRuntimeInfo,
  QueryTransport,
} from "../../core/query/transport";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";
import { DEFAULT_QUERY_MAX_TOOL_STEPS } from "../../shared/runtimeDefaults";
import type { AuthLoginInput, AuthStatus } from "../../infra/auth/types";
import { normalizeProviderBaseUrl } from "../../infra/http/createHttpQueryTransport";
import type {
  SessionListItem,
  SessionPendingChoice,
  SessionRecord,
  SessionStateUpdateDiagnostic,
} from "../../core/session/types";
import type {
  McpRuntime,
  MpcAction,
  PendingReviewItem,
  ToolRequest,
} from "../../core/mcp";
import type { SkillDefinition, SkillsRuntime } from "../../core/skills";
import { createApprovalActionLock } from "./approvalActionLock";
import {
  executeCurrentPendingReviewAction,
} from "./chatApprovalController";
import {
  getApprovalPreviewText,
  getPendingQueueSignature,
  parseToolDetail,
  type ApprovalPreviewMode,
} from "./chatApprovalHelpers";
import {
  clearApprovalBlock,
  clearApprovalInFlight,
  closeApprovalPanelState,
  createInitialApprovalPanelState,
  createNextApprovalPanelState,
  syncApprovalBlockToQueue,
  type ApprovalActionKind,
  type ApprovalPanelState,
  type ApprovalStateUpdateOptions,
} from "./chatApprovalPanelState";
import { handleApprovalCommand } from "./chatApprovalCommandHandler";
import {
  executeApprovePendingReview,
  executePendingBatch,
  executeRejectPendingReview,
} from "./chatApprovalExecution";
import {
  AUTH_PANEL_STEPS,
  applyAuthProviderPresetState,
  applyRememberedKeyToAuthPanel,
  getAuthPanelFieldValue,
  startRememberedKeyReplacementState,
  transitionAuthPanelStep,
  updateAuthPanelFieldValue,
  type AuthPanelMode,
  type AuthPanelState,
  type AuthPanelStep,
} from "./chatAuthPanelHelpers";
import { handleAuthCommand } from "./chatAuthCommandHandler";
import {
  AUTH_PROVIDER_PRESETS,
  HELP_TEXT,
  getSlashSuggestions,
  type CommandSuggestion,
} from "./chatCommandHelpers";
import { resolveComposerInputIntent } from "./composerInput";
import {
  buildFileSearchPattern,
  getActiveFileMention,
  getFileMentionReferences,
  getFilePreviewCacheKey,
  isCodeLikePath,
  parseFindFilesSuggestions,
  type FileMentionSuggestion,
} from "./chatFileMentionHelpers";
import {
  EMPTY_SHELL_SESSION_STATE,
  SHELL_SESSION_ACTIONS,
  areShellSessionsEqual,
  formatSymbolPreviewMeta,
  parseOutlineEntries,
  parseReadRangePreview,
  parseSearchTextContextPreview,
  parseShellSessionMessage,
  pickOutlineEntry,
  type FilePreviewResult,
  type OutlineEntry,
  type ShellSessionState,
} from "./chatFilePreviewHelpers";
import { hasLegacyCompressedMarkdown } from "./chatLegacySessionHelpers";
import { handleMcpCommand } from "./chatMcpCommandHandler";
import { formatActiveSkillsPrompt } from "./chatMcpSkillsFormatting";
import { handleProviderModelCommand } from "./chatProviderModelCommandHandler";
import { handleSessionCommand } from "./chatSessionCommandHandler";
import {
  parseShellShortcut,
  type ShellShortcutAction,
} from "./chatShellHelpers";
import { handleSkillsCommand } from "./chatSkillsCommandHandler";
import { summarizeToolMessage } from "./toolMessageSummary";
import type { ComposerKeymap } from "./composerKeymap";
import { useInputAdapter } from "./inputAdapter";
import type { InputAdapterHook } from "./inputTypes";
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
  clampPreviewOffset,
  clearApprovalBlockOnSelectionChange,
  cycleSelection,
  movePagedSelection,
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
  composerKeymap?: ComposerKeymap;
  mcpService: McpRuntime;
  skillsService?: SkillsRuntime;
  onSessionProjectRootChange?: (projectRoot: string | null) => Promise<void> | void;
  auth?: {
    status: AuthStatus;
    getStatus: () => Promise<AuthStatus>;
    getSavedApiKey?: (providerBaseUrl: string) => Promise<string | undefined>;
    syncSelection?: (input: {
      providerBaseUrl?: string;
      model?: string;
    }) => Promise<AuthStatus>;
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
  inputAdapterHook?: InputAdapterHook;
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
  currentKeySource: string | null;
  providerProfiles: Record<string, ProviderRuntimeInfo["vendor"]>;
  providerProfileSources: Record<
    string,
    "manual" | "inferred" | "local" | "none"
  >;
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

type InputMode = "idle" | "command" | "file" | "shell";

type FileMentionPreviewState = {
  path: string | null;
  text: string;
  meta: string | null;
  loading: boolean;
};

type FileMentionState = {
  references: string[];
  activeQuery: string | null;
  suggestions: FileMentionSuggestion[];
  loading: boolean;
  preview: FileMentionPreviewState;
};

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
  queryText: string | null;
  currentCommand: string | null;
  suggestions: CommandSuggestion[];
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
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
};

const defaultSystemText =
  "Type /help to view commands. Use /login for HTTP auth or /resume to open session picker.";
const RESUME_PAGE_SIZE = 8;
const MODEL_PAGE_SIZE = 8;
const PROVIDER_PAGE_SIZE = 8;
const INPUT_HISTORY_LIMIT = 100;
const STREAMING_RENDER_BATCH_MS = 60;
const STREAMING_RENDER_BATCH_MS_MEDIUM = 130;
const STREAMING_RENDER_BATCH_MS_LARGE = 220;
const STREAMING_RENDER_MIN_DELTA_MEDIUM = 120;
const STREAMING_RENDER_MIN_DELTA_LARGE = 240;
const TURN_CANCELLED_ERROR = "__CYRENE_TURN_CANCELLED__";
const EMPTY_FILE_MENTION_PREVIEW: FileMentionPreviewState = {
  path: null,
  text: "",
  meta: null,
  loading: false,
};

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
    action === "move_path" ||
    action === "lsp_rename" ||
    action === "lsp_code_actions" ||
    action === "lsp_format_document"
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
    action === "copy_path" ||
    action === "lsp_rename" ||
    action === "lsp_code_actions" ||
    action === "lsp_format_document"
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

const HOTKEY_REPEAT_COOLDOWN_MS = 900;
const ACTION_REPEAT_COOLDOWN_MS = 400;
const APPROVAL_BLOCK_RETRY_MS = 1500;

const createRuntimeUsageSummary = (model: string): RuntimeUsageSummary => ({
  startedAt: new Date().toISOString(),
  activeSessionId: null,
  currentModel: model,
  requestCount: 0,
  stateUpdateCount: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const getQueuedTaskErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isBenignQueuedTaskTermination = (error: unknown) => {
  const message = getQueuedTaskErrorMessage(error).trim().toLowerCase();
  return (
    message === TURN_CANCELLED_ERROR.toLowerCase() ||
    message === "terminated" ||
    message === "aborterror" ||
    message === "aborted" ||
    message === "cancelled" ||
    message === "canceled" ||
    message === "the operation was aborted" ||
    message === "the operation was canceled"
  );
};

const addUsageToRuntimeSummary = (
  summary: RuntimeUsageSummary,
  usage: TokenUsage
): RuntimeUsageSummary => ({
  ...summary,
  requestCount: summary.requestCount + 1,
  promptTokens: summary.promptTokens + usage.promptTokens,
  cachedTokens: summary.cachedTokens + (usage.cachedTokens ?? 0),
  completionTokens: summary.completionTokens + usage.completionTokens,
  totalTokens: summary.totalTokens + usage.totalTokens,
});

const getStreamingRenderBatchMs = (textLength: number) => {
  if (textLength >= 4_000) {
    return STREAMING_RENDER_BATCH_MS_LARGE;
  }
  if (textLength >= 1_500) {
    return STREAMING_RENDER_BATCH_MS_MEDIUM;
  }
  return STREAMING_RENDER_BATCH_MS;
};

const getStreamingRenderMinDelta = (textLength: number) => {
  if (textLength >= 4_000) {
    return STREAMING_RENDER_MIN_DELTA_LARGE;
  }
  if (textLength >= 1_500) {
    return STREAMING_RENDER_MIN_DELTA_MEDIUM;
  }
  return 0;
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

const formatAuthStatusMessage = (
  status: AuthStatus,
  options?: {
    hasRememberedKey?: boolean;
  }
) => {
  const rememberedKeyLabel = options?.hasRememberedKey
    ? status.credentialSource === "user_env"
      ? "yes (active)"
      : status.credentialSource === "process_env"
        ? "yes (available but inactive)"
        : "yes"
    : "no";
  const lines = [
    "Auth status:",
    `mode: ${status.mode}`,
    `provider: ${status.provider}`,
    `model: ${status.model}`,
    `active key source: ${status.credentialSource}`,
    `remembered key for provider: ${rememberedKeyLabel}`,
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
  composerKeymap = "standard",
  mcpService,
  skillsService,
  onSessionProjectRootChange,
  auth,
  runQuerySessionImpl = runQuerySession,
  inputAdapterHook = useInputAdapter,
}: UseChatAppParams) => {
  const [input, setInput] = useState("");
  const [inputCursorOffset, setInputCursorOffset] = useState(0);
  const [recentLocalCommand, setRecentLocalCommand] = useState<string | null>(null);
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
  const [currentProviderKeySource, setCurrentProviderKeySource] = useState<string>(
    () => transport.describeProvider?.(transport.getProvider()).keySource ?? "unknown"
  );
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
    currentKeySource: null,
    providerProfiles: {},
    providerProfileSources: {},
  });
  const [pendingReviews, setPendingReviews] = useState<PendingReviewItem[]>([]);
  const [approvalPanel, setApprovalPanel] = useState<ApprovalPanelState>(() =>
    createInitialApprovalPanelState()
  );
  const [authPanel, setAuthPanel] = useState<AuthPanelState>({
    active: false,
    mode: "manual_login",
    step: "provider",
    providerBaseUrl: "",
    apiKey: "",
    model: "gpt-4o-mini",
    rememberedKeyAvailable: false,
    usingRememberedKey: false,
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
  const [fileMentionPreview, setFileMentionPreview] =
    useState<FileMentionPreviewState>(EMPTY_FILE_MENTION_PREVIEW);
  const [shellSession, setShellSession] = useState<ShellSessionState>(
    EMPTY_SHELL_SESSION_STATE
  );

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
  const liveAssistantCommittedPrefixRef = useRef("");
  const liveAssistantRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveAssistantRenderedTextRef = useRef("");
  const liveAssistantLastFlushAtRef = useRef(0);
  const authOnboardingHandledRef = useRef(false);
  const authOnboardingSuppressedRef = useRef(false);
  const filePreviewCacheRef = useRef<
    Map<string, FilePreviewResult>
  >(new Map());
  const filePreviewPendingRef = useRef<
    Map<string, Promise<FilePreviewResult>>
  >(new Map());
  const fileOutlineCacheRef = useRef<Map<string, OutlineEntry[]>>(new Map());
  const fileOutlinePendingRef = useRef<Map<string, Promise<OutlineEntry[]>>>(
    new Map()
  );
  const shellStatusPollInFlightRef = useRef(false);
  const sessionSkillUsesBySessionIdRef = useRef<Record<string, string[]>>({});
  const draftSessionSkillUsesRef = useRef<string[]>([]);

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
        void syncAuthSelection({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
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
    setSystemPrompt(defaultSystemPrompt);
  }, [defaultSystemPrompt]);

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
  const activeFileMentionQuery = activeFileMention?.query ?? null;
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
  }, [activeFileMentionQuery]);

  const loadOutlineEntries = (path: string) => {
    const cached = fileOutlineCacheRef.current.get(path);
    if (cached) {
      return Promise.resolve(cached);
    }

    const pending = fileOutlinePendingRef.current.get(path);
    if (pending) {
      return pending;
    }

    const request = mcpServiceRef.current
      .handleToolCall("file", {
        action: "outline_file",
        path,
      })
      .then(result => {
        const outline = result.ok ? parseOutlineEntries(result.message) : [];

        if (outline.length > 0) {
          fileOutlineCacheRef.current.set(path, outline);
        }

        return outline;
      })
      .catch(() => [])
      .finally(() => {
        fileOutlinePendingRef.current.delete(path);
      });

    fileOutlinePendingRef.current.set(path, request);
    return request;
  };

  const loadReadRangePreview = async (
    path: string,
    startLine = 1,
    endLine = 8
  ): Promise<FilePreviewResult> => {
    const result = await mcpServiceRef.current.handleToolCall("file", {
      action: "read_range",
      path,
      startLine,
      endLine,
    });

    return result.ok
      ? parseReadRangePreview(result.message)
      : {
          text: "",
          meta: null,
        };
  };

  const loadFileMentionPreview = (path: string, query: string) => {
    const cacheKey = getFilePreviewCacheKey(path, query);
    const cached = filePreviewCacheRef.current.get(cacheKey);
    if (cached) {
      return Promise.resolve(cached);
    }

    const pending = filePreviewPendingRef.current.get(cacheKey);
    if (pending) {
      return pending;
    }

    const trimmedQuery = query.trim();
    const request = (async (): Promise<FilePreviewResult> => {
      if (trimmedQuery.length >= 2) {
        try {
          const result = await mcpServiceRef.current.handleToolCall("file", {
            action: "search_text_context",
            path,
            query: trimmedQuery,
            before: 2,
            after: 3,
            maxResults: 1,
          });

          if (result.ok) {
            const preview = parseSearchTextContextPreview(result.message);
            if (preview.text) {
              filePreviewCacheRef.current.set(cacheKey, preview);
              return preview;
            }
          }
        } catch {
          // Fall through to syntax-aware outline or line-range previews.
        }
      }

      if (isCodeLikePath(path)) {
        try {
          const outlineEntries = await loadOutlineEntries(path);
          const entry = pickOutlineEntry(outlineEntries, trimmedQuery);
          if (entry) {
            const preview = await loadReadRangePreview(
              path,
              Math.max(1, entry.line - 1),
              entry.line + 4
            );
            if (preview.text) {
              const syntaxAwarePreview = {
                text: preview.text,
                meta: formatSymbolPreviewMeta(entry, preview.meta),
              };
              filePreviewCacheRef.current.set(cacheKey, syntaxAwarePreview);
              return syntaxAwarePreview;
            }
          }
        } catch {
          // Fall back to a compact top-of-file preview below.
        }
      }

      const preview = await loadReadRangePreview(path, 1, 8);
      if (preview.text) {
        filePreviewCacheRef.current.set(cacheKey, preview);
      }
      return preview;
    })()
      .catch(() => ({
        text: "",
        meta: null,
      }))
      .finally(() => {
        filePreviewPendingRef.current.delete(cacheKey);
      });

    filePreviewPendingRef.current.set(cacheKey, request);
    return request;
  };

  const syncShellSessionFromMessage = (
    raw: string,
    actionHint?: string | null
  ) => {
    const action = actionHint ?? parseToolDetail(raw).action ?? null;
    if (!action || !SHELL_SESSION_ACTIONS.has(action)) {
      return;
    }

    const nextSnapshot = parseShellSessionMessage(raw);
    if (!nextSnapshot) {
      return;
    }

    const now = Date.now();
    setShellSession(previous => {
      const nextState: ShellSessionState = !nextSnapshot.visible ||
        nextSnapshot.status === "closed"
        ? {
            ...nextSnapshot,
            openedAt: null,
            runningSince: null,
            lastOutputSummary:
              action === "open_shell"
                ? nextSnapshot.outputSummary
                : nextSnapshot.hasOutputSummary
                  ? nextSnapshot.outputSummary
                  : null,
            lastOutputAt: nextSnapshot.outputSummary ? now : null,
          }
        : {
            ...nextSnapshot,
            openedAt:
              action === "open_shell" ||
              !previous.visible ||
              previous.status === "closed"
                ? now
                : previous.openedAt ?? now,
            runningSince:
              nextSnapshot.status === "running"
                ? previous.status === "running" && previous.runningSince !== null
                  ? previous.runningSince
                  : now
                : null,
            lastOutputSummary:
              action === "open_shell"
                ? nextSnapshot.outputSummary
                : nextSnapshot.hasOutputSummary
                  ? nextSnapshot.outputSummary
                  : previous.lastOutputSummary,
            lastOutputAt:
              action === "open_shell"
                ? nextSnapshot.outputSummary
                  ? now
                  : null
                : nextSnapshot.hasOutputSummary
                  ? nextSnapshot.outputSummary
                    ? now
                    : previous.lastOutputAt
                  : previous.lastOutputAt,
          };

      return areShellSessionsEqual(previous, nextState) ? previous : nextState;
    });
  };

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

    if (activeFileMentionQuery === null) {
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

    const query = activeFileMentionQuery.trim();
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
  }, [activeFileMentionQuery, shellShortcutPreview.active]);

  useEffect(() => {
    if (shellShortcutPreview.active || activeFileMentionQuery === null) {
      setFileMentionPreview(previous =>
        previous.path === null && !previous.loading && !previous.text
          ? previous
          : EMPTY_FILE_MENTION_PREVIEW
      );
      return;
    }

    const query = activeFileMentionQuery.trim();
    const selectedSuggestion = fileMentionLookup.suggestions[fileSelectedIndex];
    if (!selectedSuggestion) {
      setFileMentionPreview(previous =>
        previous.path === null && !previous.loading && !previous.text
          ? previous
          : EMPTY_FILE_MENTION_PREVIEW
      );
      return;
    }

    const cached = filePreviewCacheRef.current.get(
      getFilePreviewCacheKey(selectedSuggestion.path, query)
    );
    if (cached) {
      setFileMentionPreview(previous =>
        previous.path === selectedSuggestion.path &&
        previous.text === cached.text &&
        previous.meta === cached.meta &&
        !previous.loading
          ? previous
          : {
              path: selectedSuggestion.path,
              text: cached.text,
              meta: cached.meta,
              loading: false,
            }
      );
      return;
    }

    let cancelled = false;
    setFileMentionPreview(previous =>
      previous.path === selectedSuggestion.path && previous.loading
        ? previous
        : {
            path: selectedSuggestion.path,
            text: "",
            meta: null,
            loading: true,
        }
    );

    void loadFileMentionPreview(selectedSuggestion.path, query).then(preview => {
      if (cancelled) {
        return;
      }
      setFileMentionPreview({
        path: selectedSuggestion.path,
        text: preview.text,
        meta: preview.meta,
        loading: false,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeFileMentionQuery,
    fileMentionLookup.suggestions,
    fileSelectedIndex,
    shellShortcutPreview.active,
  ]);

  useEffect(() => {
    if (shellShortcutPreview.active || activeFileMentionQuery === null) {
      return;
    }

    const query = activeFileMentionQuery.trim();
    for (const suggestion of fileMentionLookup.suggestions.slice(0, 3)) {
      void loadFileMentionPreview(suggestion.path, query);
    }
  }, [activeFileMentionQuery, fileMentionLookup.suggestions, shellShortcutPreview.active]);

  useEffect(() => {
    if (!shellSession.visible || !shellSession.alive) {
      return;
    }

    let cancelled = false;
    const intervalMs =
      shellSession.status === "running" || shellSession.pendingOutput ? 1500 : 2500;
    const poll = async () => {
      if (cancelled || shellStatusPollInFlightRef.current) {
        return;
      }
      shellStatusPollInFlightRef.current = true;
      try {
        const result = await mcpServiceRef.current.handleToolCall("file", {
          action: "shell_status",
          path: ".",
        });
        if (!cancelled) {
          syncShellSessionFromMessage(result.message, "shell_status");
        }
      } catch {
        // Polling is best-effort only.
      } finally {
        shellStatusPollInFlightRef.current = false;
      }
    };

    const timer = setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    shellSession.alive,
    shellSession.pendingOutput,
    shellSession.status,
    shellSession.visible,
  ]);

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

  const resolveProviderKeySource = (provider: string) => {
    const describedSource = transport.describeProvider?.(provider)?.keySource;
    if (describedSource && describedSource.trim()) {
      return describedSource.trim();
    }
    const credentialSource = authRef.current?.status.credentialSource;
    if (credentialSource && credentialSource !== "none") {
      return credentialSource;
    }
    return credentialSource ?? "unknown";
  };

  const resolveProviderProfile = (
    provider: string
  ): ProviderRuntimeInfo["vendor"] => {
    const describedVendor = transport.describeProvider?.(provider)?.vendor;
    if (describedVendor) {
      return describedVendor;
    }
    if (!provider || provider === "none") {
      return "none";
    }
    if (provider === "local-core") {
      return "local";
    }
    return "custom";
  };

  const normalizeProviderForProfileLookup = (provider: string) => {
    if (!provider || provider === "none" || provider === "local-core") {
      return provider;
    }
    try {
      return normalizeProviderBaseUrl(provider);
    } catch {
      return provider.trim();
    }
  };

  const listManualProviderProfileOverrides = (): ProviderProfileOverrideMap =>
    transport.listProviderProfiles?.() ?? {};

  const resolveProviderProfileSource = (
    provider: string,
    manualOverrides?: ProviderProfileOverrideMap
  ): ProviderPickerState["providerProfileSources"][string] => {
    const profile = resolveProviderProfile(provider);
    if (profile === "none") {
      return "none";
    }
    if (profile === "local") {
      return "local";
    }
    const normalizedProvider = normalizeProviderForProfileLookup(provider);
    const overrides = manualOverrides ?? listManualProviderProfileOverrides();
    return normalizedProvider && overrides[normalizedProvider]
      ? "manual"
      : "inferred";
  };

  const updateCurrentProviderState = (provider: string) => {
    setCurrentProvider(provider);
    const keySource = resolveProviderKeySource(provider);
    const profile = resolveProviderProfile(provider);
    const profileSource = resolveProviderProfileSource(provider);
    setCurrentProviderKeySource(keySource);
    setProviderPicker(previous =>
      previous.currentKeySource === keySource &&
      previous.providerProfiles[provider] === profile &&
      previous.providerProfileSources[provider] === profileSource
        ? previous
        : {
            ...previous,
            currentKeySource: keySource,
            providerProfiles: {
              ...previous.providerProfiles,
              [provider]: profile,
            },
            providerProfileSources: {
              ...previous.providerProfileSources,
              [provider]: profileSource,
            },
          }
    );
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

  const dedupeSkillIds = (ids: string[]) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const rawId of ids) {
      const normalized = rawId.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  };

  const getSkillDefinitionById = (skillId: string) => {
    const normalized = skillId.trim().toLowerCase();
    if (!normalized || !skillsService) {
      return null;
    }
    return (
      skillsService
        .listSkills()
        .find(skill => skill.id.trim().toLowerCase() === normalized) ?? null
    );
  };

  const getSessionSkillUseIds = (sessionId: string | null) =>
    sessionId
      ? [...(sessionSkillUsesBySessionIdRef.current[sessionId] ?? [])]
      : [...draftSessionSkillUsesRef.current];

  const setSessionSkillUseIds = (sessionId: string | null, ids: string[]) => {
    const deduped = dedupeSkillIds(ids);
    if (sessionId) {
      if (deduped.length === 0) {
        delete sessionSkillUsesBySessionIdRef.current[sessionId];
        return;
      }
      sessionSkillUsesBySessionIdRef.current = {
        ...sessionSkillUsesBySessionIdRef.current,
        [sessionId]: deduped,
      };
      return;
    }
    draftSessionSkillUsesRef.current = deduped;
  };

  const resolveSessionSkillUseDefinitions = (sessionId: string | null) => {
    if (!skillsService) {
      return [] as SkillDefinition[];
    }
    const skillIds = getSessionSkillUseIds(sessionId);
    if (skillIds.length === 0) {
      return [] as SkillDefinition[];
    }
    const byId = new Map(
      skillsService
        .listSkills()
        .map(skill => [skill.id.trim().toLowerCase(), skill] as const)
    );
    const selected: SkillDefinition[] = [];
    const seen = new Set<string>();
    for (const skillId of skillIds) {
      const skill = byId.get(skillId.trim().toLowerCase());
      if (!skill || seen.has(skill.id)) {
        continue;
      }
      seen.add(skill.id);
      selected.push(skill);
    }
    return selected;
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
        if (isBenignQueuedTaskTermination(error)) {
          return;
        }
        pushSystemMessage(
          `Queued action failed: ${getQueuedTaskErrorMessage(error)}`,
          {
            kind: "error",
            tone: "danger",
            color: "red",
          }
        );
      })
      .then(task)
      .catch(error => {
        if (isBenignQueuedTaskTermination(error)) {
          return;
        }
        pushSystemMessage(
          `Queued action failed: ${getQueuedTaskErrorMessage(error)}`,
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

  const applySlashSuggestion = (suggestion: CommandSuggestion | undefined) => {
    if (!suggestion) {
      return;
    }
    const nextValue = suggestion.insertValue;
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
      const result = await mcpServiceRef.current.handleToolCall("file", request);
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

      syncShellSessionFromMessage(result.message, request.action);
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
    if (isUsableHttpProvider(currentProvider)) {
      return currentProvider;
    }
    const authProvider = authRef.current?.status.provider;
    if (authProvider && isUsableHttpProvider(authProvider)) {
      return authProvider;
    }
    return "";
  };

  const syncAuthSelection = async (selection?: {
    providerBaseUrl?: string;
    model?: string;
  }) => {
    if (!authRef.current?.syncSelection) {
      return;
    }
    try {
      await authRef.current.syncSelection(selection ?? {});
    } catch {
      // Transport/auth selection syncing is best-effort only.
    }
  };

  const hydrateAuthPanelRememberedKey = async (
    providerBaseUrl: string,
    options?: {
      infoPrefix?: string;
      preferredStep?: Exclude<AuthPanelStep, "confirm">;
      clearWhenMissing?: boolean;
    }
  ) => {
    const normalizedProviderBaseUrl = providerBaseUrl.trim();
    if (!normalizedProviderBaseUrl || !authRef.current?.getSavedApiKey) {
      return;
    }
    const savedApiKey =
      (await authRef.current.getSavedApiKey(normalizedProviderBaseUrl)) ?? "";
    setAuthPanel(previous => {
      return applyRememberedKeyToAuthPanel(previous, {
        normalizedProviderBaseUrl,
        savedApiKey,
        infoPrefix: options?.infoPrefix,
        preferredStep: options?.preferredStep,
        clearWhenMissing: options?.clearWhenMissing,
      });
    });
  };

  const setAuthPanelStep = (step: AuthPanelStep) => {
    setAuthPanel(previous => transitionAuthPanelStep(previous, step));
  };

  const startRememberedKeyReplacement = () => {
    setAuthPanel(previous => startRememberedKeyReplacementState(previous));
  };

  const applyAuthProviderPreset = (presetKey: keyof typeof AUTH_PROVIDER_PRESETS) => {
    const preset = AUTH_PROVIDER_PRESETS[presetKey];
    if (!preset) {
      return;
    }
    let providerBaseUrl: string = preset.alias;
    try {
      providerBaseUrl = normalizeProviderBaseUrl(preset.alias);
    } catch {
      // keep alias text as a safe fallback
    }
    setAuthPanel(previous => {
      return applyAuthProviderPresetState(previous, {
        providerBaseUrl,
        presetLabel: preset.label,
      });
    });
    void hydrateAuthPanelRememberedKey(providerBaseUrl, {
      infoPrefix: `Preset selected: ${preset.label} (${providerBaseUrl})`,
      preferredStep: "api_key",
      clearWhenMissing: true,
    });
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

  const getUncommittedAssistantText = (visibleText: string) => {
    const committedPrefix = liveAssistantCommittedPrefixRef.current;
    if (!committedPrefix) {
      return visibleText;
    }
    if (visibleText.startsWith(committedPrefix)) {
      return visibleText.slice(committedPrefix.length);
    }
    liveAssistantCommittedPrefixRef.current = "";
    return visibleText;
  };

  const clearLiveAssistantSegment = (options?: { preserveCommittedPrefix?: boolean }) => {
    cancelLiveAssistantRender();
    liveAssistantRawTextRef.current = "";
    liveAssistantTextRef.current = "";
    liveAssistantRenderedTextRef.current = "";
    liveAssistantLastFlushAtRef.current = 0;
    if (!options?.preserveCommittedPrefix) {
      liveAssistantCommittedPrefixRef.current = "";
    }
    setLiveAssistantText(previous => (previous ? "" : previous));
  };

  const pushStreamingSystemMessage = (
    text: string,
    options?: Pick<ChatItem, "color" | "kind" | "tone">
  ) => {
    setItems(previous => {
      const next = [...previous];
      if (liveAssistantTextRef.current) {
        liveAssistantCommittedPrefixRef.current += liveAssistantTextRef.current;
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
    clearLiveAssistantSegment({ preserveCommittedPrefix: true });
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
    try {
      const result = await current.resume(toolResultMessage);
      await consumeQueryRunResult(
        current.sessionId,
        current.assistantBufferRef,
        result
      );
    } catch (error) {
      clearActiveTurnForAssistantBuffer(current.assistantBufferRef);
      setSessionState(null);
      setStatus("idle");
      throw error;
    }
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
    if (draftSessionSkillUsesRef.current.length > 0) {
      setSessionSkillUseIds(created.id, draftSessionSkillUsesRef.current);
      draftSessionSkillUsesRef.current = [];
    }
    updateActiveSessionIdState(created.id);
    return created;
  };

  const startNewSessionCommand = async () => {
    const created = await sessionStore.createSession();
    pendingChoiceRef.current = null;
    if (draftSessionSkillUsesRef.current.length > 0) {
      setSessionSkillUseIds(created.id, draftSessionSkillUsesRef.current);
      draftSessionSkillUsesRef.current = [];
    }
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
  };

  const appendToLiveAssistant = (rawAssistantText: string) => {
    if (!rawAssistantText) {
      return;
    }
    liveAssistantRawTextRef.current = rawAssistantText;
    const nextVisible = getUncommittedAssistantText(
      parseAssistantStateUpdate(rawAssistantText).visibleText
    );
    if (nextVisible === liveAssistantTextRef.current) {
      return;
    }
    liveAssistantTextRef.current = nextVisible;

    const lastRendered = liveAssistantRenderedTextRef.current;
    if (!lastRendered) {
      flushLiveAssistantSegment(nextVisible);
      return;
    }

    const appendedSlice = nextVisible.startsWith(lastRendered)
      ? nextVisible.slice(lastRendered.length)
      : nextVisible;
    const appendedLength = Math.max(0, nextVisible.length - lastRendered.length);
    const hasAppendedLineBreak = appendedSlice.includes("\n");
    const minDelta = getStreamingRenderMinDelta(nextVisible.length);

    if (hasAppendedLineBreak) {
      flushLiveAssistantSegment(nextVisible);
      return;
    }

    const elapsed = Date.now() - liveAssistantLastFlushAtRef.current;
    if (
      elapsed >= getStreamingRenderBatchMs(nextVisible.length) &&
      (minDelta === 0 || appendedLength >= minDelta)
    ) {
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
      currentKeySource: null,
      providerProfiles: {},
      providerProfileSources: {},
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
      rememberedKeyAvailable: false,
      usingRememberedKey: false,
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

  const openModelPickerFromCommand = (options: {
    models: string[];
    selectedIndex: number;
  }) => {
    closeAllOverlayPanels({ keepModelPicker: true });
    const nextState = {
      active: true,
      models: options.models,
      selectedIndex: options.selectedIndex,
      pageSize: MODEL_PAGE_SIZE,
    };
    modelPickerRef.current = nextState;
    setModelPicker(nextState);
  };

  const openProviderPickerFromCommand = (options: {
    providers: string[];
    selectedIndex: number;
    currentKeySource: string;
    providerProfiles: ProviderPickerState["providerProfiles"];
    providerProfileSources: ProviderPickerState["providerProfileSources"];
  }) => {
    closeAllOverlayPanels({ keepProviderPicker: true });
    const nextState = {
      active: true,
      providers: options.providers,
      selectedIndex: options.selectedIndex,
      pageSize: PROVIDER_PAGE_SIZE,
      currentKeySource: options.currentKeySource,
      providerProfiles: options.providerProfiles,
      providerProfileSources: options.providerProfileSources,
    };
    providerPickerRef.current = nextState;
    setProviderPicker(nextState);
  };

  const openResumePickerFromCommand = (sessions: SessionListItem[]) => {
    closeAllOverlayPanels({ keepResumePicker: true });
    const nextState = {
      active: true,
      sessions,
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    };
    resumePickerRef.current = nextState;
    setResumePicker(nextState);
  };

  const openSessionsPanelFromCommand = (sessions: SessionListItem[]) => {
    closeAllOverlayPanels({ keepSessionsPanel: true });
    const nextState = {
      active: true,
      sessions,
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    };
    sessionsPanelRef.current = nextState;
    setSessionsPanel(nextState);
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
      rememberedKeyAvailable: false,
      usingRememberedKey: false,
      cursorOffset: providerBaseUrl.length,
      error: null,
      info:
        mode === "auto_onboarding"
          ? "HTTP credentials not found. Press Esc to stay in local-core mode, or continue below."
          : "Connect an HTTP provider (URL or preset: openai / gemini / anthropic). API key input stays local to this panel.",
      saving: false,
      persistenceTarget: authRef.current?.status.persistenceTarget ?? null,
    };
    authPanelRef.current = nextState;
    setAuthPanel(nextState);
    if (providerBaseUrl) {
      void hydrateAuthPanelRememberedKey(providerBaseUrl, {
        preferredStep: "model",
        clearWhenMissing: true,
      });
    }
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
      let normalizedProviderBaseUrl = providerBaseUrl;
      try {
        normalizedProviderBaseUrl = normalizeProviderBaseUrl(providerBaseUrl);
        const parsed = new URL(normalizedProviderBaseUrl);
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
      setAuthPanel(previous => ({
        ...previous,
        providerBaseUrl: normalizedProviderBaseUrl,
        apiKey: "",
        rememberedKeyAvailable: false,
        usingRememberedKey: false,
        step: "api_key",
        cursorOffset: 0,
        error: null,
        info: null,
      }));
      void hydrateAuthPanelRememberedKey(normalizedProviderBaseUrl, {
        preferredStep: "api_key",
        clearWhenMissing: true,
      });
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
    try {
      await onSessionProjectRootChange?.(loaded.projectRoot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown workspace switch failure.";
      pushSystemMessage(
        `Failed to switch workspace for resumed session: ${message}`,
        {
          kind: "error",
          tone: "danger",
          color: "red",
        }
      );
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
        await syncAuthSelection({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
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
        await syncAuthSelection({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
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

  const updatePendingState = (
    nextPending: PendingReviewItem[],
    options?: ApprovalStateUpdateOptions
  ) => {
    pendingReviewsRef.current = nextPending;
    if (nextPending.length === 0) {
      dismissedApprovalQueueSignatureRef.current = null;
    }
    const nextPanelState = createNextApprovalPanelState(
      approvalPanelRef.current,
      nextPending,
      options
    );
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
    approvalPanelRef.current = closeApprovalPanelState(approvalPanelRef.current);
    setApprovalPanel(previous => closeApprovalPanelState(previous));
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
      ...createNextApprovalPanelState(previous, pendingReviews, {
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
        await executeApprovePendingReview({
          id,
          mcpService,
          wasOpen: approvalPanelRef.current.active,
          pushSystemMessage,
          recordSessionMemory,
          getMemorySessionId,
          updatePendingState,
          syncShellSessionFromMessage,
          actionColor,
          resumeSuspendedTask,
          repairSettledReviewState,
          onApprovalBlocked: blockedState => {
            syncApprovalPanelState(previous => ({
              ...previous,
              blockedItemId: blockedState.itemId,
              blockedReason: blockedState.reason,
              blockedAt: blockedState.at,
              lastAction: blockedState.lastAction,
            }));
          },
        });
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
        await executeRejectPendingReview({
          id,
          mcpService,
          wasOpen: approvalPanelRef.current.active,
          hasSuspendedTask: Boolean(suspendedTaskRef.current),
          pushSystemMessage,
          recordSessionMemory,
          getMemorySessionId,
          updatePendingState,
          cancelSuspendedTask,
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
        await executePendingBatch({
          action,
          selector,
          scopeLabel,
          currentIndex: approvalPanelRef.current.selectedIndex,
          wasOpen: approvalPanelRef.current.active,
          hasSuspendedTask: Boolean(suspendedTaskRef.current),
          markInFlight: () =>
            syncApprovalPanelState(previous => ({
              ...previous,
              inFlightId: `batch:${action}`,
              actionState: action,
              resumePending: Boolean(suspendedTaskRef.current),
            })),
          mcpService,
          pushSystemMessage,
          recordSessionMemory,
          getMemorySessionId,
          updatePendingState,
          resumeSuspendedTask,
          cancelSuspendedTask,
          repairSettledReviewState,
          summarizePendingRisk,
        });
      } finally {
        syncApprovalPanelState(previous => clearApprovalInFlight(previous));
      }
    });
  };

  const approveCurrentPendingReview = () => {
    executeCurrentPendingReviewAction({
      action: "approve",
      pendingReviews: pendingReviewsRef.current,
      approvalPanel: approvalPanelRef.current,
      blockedRetryMs: APPROVAL_BLOCK_RETRY_MS,
      isActionLocked: approvalActionRef.current.isLocked(),
      hasSuspendedTask: Boolean(suspendedTaskRef.current),
      lastIntentRef: lastApprovalIntentRef,
      isRepeatedInteraction,
      pushSystemMessage,
      markApprovalInFlight,
      runReviewAction: approvePendingReview,
    });
  };

  const rejectCurrentPendingReview = () => {
    executeCurrentPendingReviewAction({
      action: "reject",
      pendingReviews: pendingReviewsRef.current,
      approvalPanel: approvalPanelRef.current,
      blockedRetryMs: APPROVAL_BLOCK_RETRY_MS,
      isActionLocked: approvalActionRef.current.isLocked(),
      hasSuspendedTask: Boolean(suspendedTaskRef.current),
      lastIntentRef: lastApprovalIntentRef,
      isRepeatedInteraction,
      pushSystemMessage,
      markApprovalInFlight,
      runReviewAction: rejectPendingReview,
    });
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

      if (
        authPanelRef.current.step === "provider" &&
        (() => {
          const currentValue = authPanelRef.current.providerBaseUrl.trim();
          const suggestedValue = getSuggestedLoginProvider().trim();
          return (
            currentValue.length === 0 ||
            (Boolean(suggestedValue) && currentValue === suggestedValue)
          );
        })() &&
        !key.ctrl &&
        !key.meta &&
        Object.prototype.hasOwnProperty.call(AUTH_PROVIDER_PRESETS, inputValue)
      ) {
        applyAuthProviderPreset(inputValue as keyof typeof AUTH_PROVIDER_PRESETS);
        return;
      }

      if (authPanelRef.current.step === "confirm") {
        if (
          !key.ctrl &&
          !key.meta &&
          inputValue === "4" &&
          authPanelRef.current.rememberedKeyAvailable &&
          authPanelRef.current.usingRememberedKey
        ) {
          startRememberedKeyReplacement();
          return;
        }
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

      const composerIntent = resolveComposerInputIntent(
        inputValue,
        key,
        composerKeymap
      );

      if (composerIntent.kind === "insert_newline") {
        applyEditorTransform(state => insertTextAtCursor(state, "\n"));
        return;
      }

      if (composerIntent.kind === "submit") {
        submit();
        return;
      }

      if (composerIntent.kind === "insert_text") {
        applyEditorTransform(state =>
          insertTextAtCursor(state, composerIntent.text)
        );
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
    setRecentLocalCommand(query.startsWith("/") ? query : null);

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

    if (
      handleAuthCommand({
        query,
        authRuntime: authRef.current,
        transport,
        pushSystemMessage,
        clearInput,
        enqueueTask,
        openManualLoginPanel: () => openAuthPanel("manual_login"),
        formatAuthStatusMessage,
        isUsableHttpProvider,
      })
    ) {
      return;
    }

    if (
      handleProviderModelCommand({
        query,
        transport,
        currentProviderKeySource,
        pushSystemMessage,
        clearInput,
        enqueueTask,
        isRepeatedActionInteraction,
        updateCurrentProviderState,
        updateCurrentModelState,
        syncAuthSelection,
        resolveProviderKeySource,
        listManualProviderProfileOverrides,
        resolveProviderProfile,
        resolveProviderProfileSource,
        openProviderPicker: openProviderPickerFromCommand,
        openModelPicker: openModelPickerFromCommand,
      })
    ) {
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
        if (
          await handleSessionCommand({
            query,
            sessionStore,
            activeSessionId,
            systemPrompt,
            defaultSystemPrompt,
            pinMaxCount,
            pushSystemMessage,
            clearInput,
            setSystemPrompt,
            formatReducerStateMessage,
            ensureActiveSession,
            startNewSession: startNewSessionCommand,
            undoLastMutation: () => mcpService.undoLastMutation(),
            openSessionsPanel: openSessionsPanelFromCommand,
            openResumePicker: openResumePickerFromCommand,
            loadSessionIntoChat,
          })
        ) {
          return;
        }

        if (
          await handleSkillsCommand({
            query,
            skillsService,
            activeSessionId,
            pushSystemMessage,
            clearInput,
            getSkillDefinitionById,
            getSessionSkillUseIds,
            setSessionSkillUseIds,
          })
        ) {
          return;
        }

        if (
          await handleMcpCommand({
            query,
            mcpService,
            pushSystemMessage,
            clearInput,
            getApprovalRisk,
          })
        ) {
          return;
        }

        if (
          handleApprovalCommand({
            query,
            listPending: () => mcpService.listPending(),
            pushSystemMessage,
            clearInput,
            summarizePendingRisk,
            openApprovalPanel,
            approvePendingReview,
            rejectPendingReview,
            approveLowBatch: () =>
              processPendingBatch(
                "approve",
                item => getApprovalRisk(item.request.action) !== "high",
                "low-and-medium"
              ),
            approveAllBatch: () =>
              processPendingBatch("approve", () => true, "all"),
            rejectAllBatch: () =>
              processPendingBatch("reject", () => true, "all"),
          })
        ) {
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
        const autoSkills = skillsService?.resolveForQuery(submittedTask) ?? [];
        const manualSkills = resolveSessionSkillUseDefinitions(session.id);
        const activeSkills = [...manualSkills, ...autoSkills].filter(
          (skill, index, all) => all.findIndex(item => item.id === skill.id) === index
        );
        const prompt = buildPromptWithContext(
          submittedTask,
          systemPrompt,
          projectPrompt,
          promptContext,
          activeSkills.length > 0 ? formatActiveSkillsPrompt(activeSkills) : ""
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
            syncShellSessionFromMessage(
              result.message,
              typeof toolInput === "object" &&
                toolInput !== null &&
                "action" in toolInput &&
                typeof (toolInput as { action?: unknown }).action === "string"
                ? ((toolInput as { action: string }).action ?? null)
                : null
            );
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
      queryText: mode === "command" ? commandQuery : null,
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
        activeQuery: activeFileMentionQuery,
        suggestions: fileMentionLookup.suggestions,
        loading: fileMentionLookup.loading,
        preview: fileMentionPreview,
      },
    };
  }, [
    activeFileMentionQuery,
    commandModeActive,
    commandQuery,
    commandSelectedIndex,
    fileMentionLookup.loading,
    fileMentionLookup.suggestions,
    fileMentionPreview,
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
    shellSession,
    items,
    liveAssistantText,
    recentLocalCommand,
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
