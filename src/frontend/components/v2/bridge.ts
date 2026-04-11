import { resolve } from "node:path";
import * as readline from "node:readline";
import { setConfiguredAppRoot } from "../../../infra/config/appRoot";
import { loadCyreneConfig, type CyreneConfig } from "../../../infra/config/loadCyreneConfig";
import { loadPromptPolicy, type PromptPolicy } from "../../../infra/config/loadPromptPolicy";
import { createAuthRuntime, type AuthRuntime } from "../../../infra/auth/authRuntime";
import type { AuthStatus } from "../../../infra/auth/types";
import { createFileSessionStore } from "../../../infra/session/createFileSessionStore";
import { createMcpRuntime, type McpRuntime, type PendingReviewItem } from "../../../core/mcp";
import { createSkillsRuntime, type SkillDefinition, type SkillsRuntime } from "../../../core/skills";
import { buildPromptWithContext } from "../../../core/session/buildPromptWithContext";
import { runQuerySession, type RunQuerySessionResult } from "../../../core/query/runQuerySession";
import type {
  QueryTransport,
  ProviderProfile,
  ProviderProfileOverrideMap,
} from "../../../core/query/transport";
import { normalizeProviderBaseUrl } from "../../../infra/http/createHttpQueryTransport";
import {
  applyLocalFallbackStateUpdate,
  applyParsedStateUpdate,
  buildFallbackPendingDigest,
  parseAssistantStateUpdate,
} from "../../../core/session/stateReducer";
import { extractPendingChoiceFromAssistantText } from "../../../core/session/pendingChoice";
import type { SessionStore } from "../../../core/session/store";
import type {
  SessionListItem,
  SessionRecord,
  SessionStateUpdateDiagnostic,
} from "../../../core/session/types";
import { HELP_TEXT } from "../../../application/chat/chatCommandHelpers";
import { handleSessionCommand } from "../../../application/chat/chatSessionCommandHandler";
import { handleSkillsCommand } from "../../../application/chat/chatSkillsCommandHandler";
import { handleMcpCommand } from "../../../application/chat/chatMcpCommandHandler";
import {
  normalizeMcpMessage,
  summarizeToolMessage as summarizeChatToolMessage,
} from "../../../application/chat/toolMessageSummary";
import {
  formatActiveSkillsPrompt,
} from "../../../application/chat/chatMcpSkillsFormatting";

type BridgeCommand =
  | { type: "init"; root?: string }
  | { type: "command"; text: string }
  | { type: "submit"; text: string }
  | { type: "new_session" }
  | { type: "list_sessions" }
  | { type: "load_session"; id: string }
  | { type: "approve"; id: string }
  | { type: "reject"; id: string }
  | { type: "approve_all" }
  | { type: "approve_low" }
  | { type: "reject_all" }
  | { type: "list_models" }
  | { type: "list_providers" }
  | { type: "set_model"; value: string }
  | { type: "set_provider"; value: string }
  | { type: "refresh_models" }
  | { type: "get_login_defaults" }
  | { type: "list_provider_profiles" }
  | { type: "set_provider_profile"; profile: string; value?: string }
  | { type: "clear_provider_profile"; value?: string }
  | {
      type: "login";
      providerBaseUrl: string;
      apiKey: string;
      model?: string;
    }
  | { type: "logout" }
  | { type: "shutdown" };

type BridgeStatus =
  | "idle"
  | "preparing"
  | "requesting"
  | "streaming"
  | "awaiting_review"
  | "error";

type BridgeItem = {
  role: "user" | "assistant" | "system";
  kind: "transcript" | "tool_status" | "review_status" | "system_hint" | "error";
  text: string;
};

type BridgeReview = {
  id: string;
  action: string;
  path: string;
  previewSummary: string;
  previewFull: string;
  createdAt: string;
};

type BridgeSession = {
  id: string;
  title: string;
  updatedAt: string;
  tags: string[];
};

type BridgeAuthStatus = {
  mode: string;
  credentialSource: string;
  provider: string;
  model: string;
  persistenceLabel: string;
  persistencePath: string;
  httpReady: boolean;
  onboardingAvailable: boolean;
};

type BridgeProviderProfile =
  | "openai"
  | "gemini"
  | "anthropic"
  | "custom"
  | "local"
  | "none";

type BridgeProviderProfileSource = "manual" | "inferred" | "local" | "none";

type BridgeSnapshot = {
  appRoot: string;
  status: BridgeStatus;
  activeSessionId: string | null;
  items: BridgeItem[];
  liveText: string;
  pendingReviews: BridgeReview[];
  sessions: BridgeSession[];
  currentModel: string;
  currentProvider: string;
  currentProviderKeySource: string;
  availableModels: string[];
  availableProviders: string[];
  providerProfiles: Record<string, BridgeProviderProfile>;
  providerProfileSources: Record<string, BridgeProviderProfileSource>;
  auth: BridgeAuthStatus;
};

type BridgeEvent =
  | { type: "init"; snapshot: BridgeSnapshot }
  | { type: "set_status"; status: BridgeStatus }
  | { type: "set_live_text"; liveText: string }
  | { type: "append_items"; items: BridgeItem[] }
  | { type: "replace_items"; items: BridgeItem[] }
  | { type: "set_sessions"; sessions: BridgeSession[]; activeSessionId?: string | null }
  | { type: "set_pending_reviews"; pendingReviews: BridgeReview[] }
  | {
      type: "set_runtime_metadata";
      auth: BridgeAuthStatus;
      currentModel: string;
      currentProvider: string;
      currentProviderKeySource: string;
      availableModels: string[];
      availableProviders: string[];
      providerProfiles: Record<string, BridgeProviderProfile>;
      providerProfileSources: Record<string, BridgeProviderProfileSource>;
      appRoot: string;
    }
  | {
      type: "set_auth_defaults";
      providerBaseUrl: string;
      model: string;
      apiKey: string;
    }
  | { type: "error"; message: string };

type SuspendedRun = {
  sessionId: string;
  userText: string;
  startedAt: string;
  assistantBufferRef: { current: string };
  resume: (toolResultMessage: string) => Promise<RunQuerySessionResult>;
};

const DEFAULT_EMPTY_STATE: BridgeItem = {
  role: "system",
  kind: "system_hint",
  text: "No messages in the current session. Start typing.",
};

const isHighRiskReviewAction = (action: string) =>
  action === "apply_patch" ||
  action === "edit_file" ||
  action === "delete_file" ||
  action === "run_command" ||
  action === "run_shell" ||
  action === "open_shell" ||
  action === "write_shell";

const FILE_MUTATION_ACTIONS = new Set([
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
]);

const parseRootArg = () => {
  for (let index = 0; index < process.argv.length; index += 1) {
    const token = process.argv[index]?.trim();
    if (!token) {
      continue;
    }
    if ((token === "--root" || token === "-r") && process.argv[index + 1]) {
      return process.argv[index + 1]!.trim();
    }
    if (token.startsWith("--root=")) {
      return token.slice("--root=".length).trim();
    }
  }
  return undefined;
};

const firstLine = (value: string, fallback = "") =>
  value
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? fallback;

const formatBridgeToolMessage = (raw: string): Pick<BridgeItem, "kind" | "text"> => {
  const normalized = normalizeMcpMessage(raw);
  const summary = summarizeChatToolMessage(raw);
  const [firstLine = "", ...rest] = normalized.text.split("\n");
  const body = rest.join("\n").trim();

  if (firstLine.startsWith("Tool result:")) {
    const detail = firstLine.replace("Tool result:", "").trim();
    const action = detail.split(/\s+/, 1)[0] ?? "";
    if (
      detail.startsWith("read_file ") ||
      detail.startsWith("read_files ") ||
      detail.startsWith("read_range ") ||
      detail.startsWith("read_json ") ||
      detail.startsWith("read_yaml ") ||
      detail.startsWith("search_text_context ")
    ) {
      return {
        kind: "tool_status",
        text: `Tool: ${detail}\n\`\`\`\n${(body || "(empty)").trim()}\n\`\`\``,
      };
    }
    if (FILE_MUTATION_ACTIONS.has(action)) {
      return {
        kind: "tool_status",
        text: `Tool: ${detail}\n${(body || "(empty)").trim()}`,
      };
    }
  }

  return {
    kind: summary.kind === "error" ? "error" : "tool_status",
    text: summary.text,
  };
};

const reviewMessage = (verb: string, item: PendingReviewItem | undefined, detail: string) => {
  const parts = [verb];
  if (item) {
    parts.push(`${item.request.action} ${item.request.path}`);
    parts.push(item.id);
  }
  if (detail.trim()) {
    parts.push(detail.trim());
  }
  return parts.join(" | ");
};

const toBridgeAuthStatus = (status: AuthStatus | null): BridgeAuthStatus => ({
  mode: status?.mode ?? "local",
  credentialSource: status?.credentialSource ?? "none",
  provider: status?.provider ?? "none",
  model: status?.model ?? "",
  persistenceLabel: status?.persistenceTarget?.label ?? "",
  persistencePath: status?.persistenceTarget?.path ?? "",
  httpReady: Boolean(status?.httpReady),
  onboardingAvailable: Boolean(status?.onboardingAvailable),
});

class BubbleTeaBridge {
  private appRoot = resolve(parseRootArg() ?? process.cwd());
  private config: CyreneConfig | null = null;
  private promptPolicy: PromptPolicy | null = null;
  private defaultSystemPrompt = "";
  private runtimeSystemPrompt = "";
  private authRuntime: AuthRuntime | null = null;
  private transport: QueryTransport | null = null;
  private sessionStore: SessionStore | null = null;
  private mcpService: McpRuntime | null = null;
  private skillsRuntime: SkillsRuntime | null = null;

  private activeSessionId: string | null = null;
  private items: BridgeItem[] = [];
  private liveText = "";
  private status: BridgeStatus = "preparing";
  private pendingReviews: BridgeReview[] = [];
  private sessions: BridgeSession[] = [];
  private authStatus: AuthStatus | null = null;
  private currentProviderKeySource = "";
  private availableModels: string[] = [];
  private availableProviders: string[] = [];
  private providerProfiles: Record<string, BridgeProviderProfile> = {};
  private providerProfileSources: Record<string, BridgeProviderProfileSource> = {};
  private stateUpdateCount = 0;
  private sessionSkillUseIds = new Map<string, string[]>();
  private suspended: SuspendedRun | null = null;
  private commandChain: Promise<void> = Promise.resolve();
  private runtimeMetadataDirty = true;
  private pendingAppendItems: BridgeItem[] = [];
  private appendFlushScheduled = false;

  enqueue(command: BridgeCommand) {
    this.commandChain = this.commandChain
      .then(() => this.handleCommand(command))
      .catch(error => {
        this.emitError(error instanceof Error ? error.message : String(error));
      });
  }

  private async handleCommand(command: BridgeCommand) {
    switch (command.type) {
      case "init":
        await this.initialize(command.root);
        return;
      case "command":
        await this.executeSlashCommand(command.text);
        return;
      case "submit":
        await this.submit(command.text);
        return;
      case "new_session":
        await this.newSession();
        return;
      case "list_sessions":
        await this.refreshSessions();
        return;
      case "load_session":
        await this.loadSession(command.id);
        return;
      case "approve":
        await this.approve(command.id);
        return;
      case "reject":
        await this.reject(command.id);
        return;
      case "approve_all":
        await this.approveAll();
        return;
      case "approve_low":
        await this.approveLow();
        return;
      case "reject_all":
        await this.rejectAll();
        return;
      case "list_models":
      case "list_providers":
        this.markRuntimeMetadataDirty();
        await this.refreshRuntimeMetadata();
        return;
      case "set_model":
        await this.setModel(command.value);
        return;
      case "set_provider":
        await this.setProvider(command.value);
        return;
      case "refresh_models":
        await this.refreshModels();
        return;
      case "get_login_defaults":
        await this.emitAuthDefaults();
        return;
      case "list_provider_profiles":
        await this.listProviderProfiles();
        return;
      case "set_provider_profile":
        await this.setProviderProfile(command.profile, command.value);
        return;
      case "clear_provider_profile":
        await this.clearProviderProfile(command.value);
        return;
      case "login":
        await this.login(command.providerBaseUrl, command.apiKey, command.model);
        return;
      case "logout":
        await this.logout();
        return;
      case "shutdown":
        this.dispose();
        process.exit(0);
    }
  }

  private async initialize(root?: string) {
    if (root?.trim()) {
      this.appRoot = resolve(root.trim());
    }
    await this.loadRuntime(this.appRoot);
    await this.refreshSessions();
    this.activeSessionId = null;
    this.suspended = null;
    this.items = [DEFAULT_EMPTY_STATE];
    this.liveText = "";
    this.pendingReviews = this.listPendingReviews();
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    await this.refreshRuntimeMetadata();
    this.emitInit();
  }

  private async loadRuntime(root: string) {
    this.dispose();
    this.appRoot = resolve(root);
    this.sessionSkillUseIds.clear();
    process.chdir(this.appRoot);
    setConfiguredAppRoot(this.appRoot);

    this.config = await loadCyreneConfig(this.appRoot);
    this.promptPolicy = await loadPromptPolicy(this.config, this.appRoot);
    this.defaultSystemPrompt = this.promptPolicy.systemPrompt;
    this.runtimeSystemPrompt = this.promptPolicy.systemPrompt;
    this.authRuntime = createAuthRuntime({
      appRoot: this.appRoot,
      requestTemperature: this.config.requestTemperature,
    });
    this.transport = await this.authRuntime.buildTransport();
    this.sessionStore = createFileSessionStore(undefined, {
      cwd: this.appRoot,
      env: process.env,
    });
    this.mcpService = await createMcpRuntime(this.appRoot);
    this.skillsRuntime = await createSkillsRuntime(this.appRoot);
    this.pendingReviews = this.listPendingReviews();
    this.markRuntimeMetadataDirty();
    await this.refreshRuntimeMetadata();
  }

  private async ensureRuntime() {
    if (
      !this.config ||
      !this.promptPolicy ||
      !this.authRuntime ||
      !this.transport ||
      !this.sessionStore ||
      !this.mcpService
    ) {
      await this.initialize(this.appRoot);
    }
  }

  private normalizeProviderForProfileLookup(provider: string) {
    const trimmed = provider.trim();
    if (!trimmed || trimmed === "none" || trimmed === "local-core") {
      return trimmed;
    }
    try {
      return normalizeProviderBaseUrl(trimmed);
    } catch {
      return trimmed;
    }
  }

  private resolveProviderProfile(provider: string): BridgeProviderProfile {
    const describedVendor = this.transport?.describeProvider?.(provider)?.vendor;
    if (describedVendor) {
      return describedVendor;
    }
    const trimmed = provider.trim();
    if (!trimmed || trimmed === "none") {
      return "none";
    }
    if (trimmed === "local-core") {
      return "local";
    }
    return "custom";
  }

  private resolveProviderProfileSource(
    provider: string,
    manualOverrides: ProviderProfileOverrideMap,
    profile: BridgeProviderProfile
  ): BridgeProviderProfileSource {
    if (profile === "none") {
      return "none";
    }
    if (profile === "local") {
      return "local";
    }
    const normalized = this.normalizeProviderForProfileLookup(provider);
    return normalized && manualOverrides[normalized] ? "manual" : "inferred";
  }

  private markRuntimeMetadataDirty() {
    this.runtimeMetadataDirty = true;
  }

  private async refreshRuntimeMetadata(force = false) {
    await this.ensureRuntime();
    if (!force && !this.runtimeMetadataDirty) {
      return;
    }
    this.authStatus = this.authRuntime ? await this.authRuntime.getStatus() : null;
    this.availableModels = [];
    this.availableProviders = [];
    this.providerProfiles = {};
    this.providerProfileSources = {};

    try {
      this.availableModels = (await this.transport?.listModels()) ?? [];
    } catch {
      this.availableModels = [];
    }
    try {
      this.availableProviders = (await this.transport?.listProviders()) ?? [];
    } catch {
      this.availableProviders = [];
    }

    const currentProvider = this.transport?.getProvider() ?? this.authStatus?.provider ?? "";
    this.currentProviderKeySource =
      this.transport?.describeProvider?.(currentProvider).keySource ?? "";

    const providerUniverse = Array.from(
      new Set(
        [...this.availableProviders, currentProvider]
          .map(provider => provider.trim())
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right));
    const manualOverrides = this.transport?.listProviderProfiles?.() ?? {};
    const nextProfiles: Record<string, BridgeProviderProfile> = {};
    const nextProfileSources: Record<string, BridgeProviderProfileSource> = {};
    for (const provider of providerUniverse) {
      const profile = this.resolveProviderProfile(provider);
      nextProfiles[provider] = profile;
      nextProfileSources[provider] = this.resolveProviderProfileSource(
        provider,
        manualOverrides,
        profile
      );
    }
    this.providerProfiles = nextProfiles;
    this.providerProfileSources = nextProfileSources;
    this.runtimeMetadataDirty = false;
    this.emitRuntimeMetadata();
  }

  private snapshot(): BridgeSnapshot {
    return {
      appRoot: this.appRoot,
      status: this.status,
      activeSessionId: this.activeSessionId,
      items: this.items,
      liveText: this.liveText,
      pendingReviews: this.pendingReviews,
      sessions: this.sessions,
      currentModel: this.transport?.getModel() ?? this.authStatus?.model ?? "",
      currentProvider: this.transport?.getProvider() ?? this.authStatus?.provider ?? "",
      currentProviderKeySource: this.currentProviderKeySource,
      availableModels: this.availableModels,
      availableProviders: this.availableProviders,
      providerProfiles: this.providerProfiles,
      providerProfileSources: this.providerProfileSources,
      auth: toBridgeAuthStatus(this.authStatus),
    };
  }

  private writeEvent(event: BridgeEvent) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  private discardPendingAppendItems() {
    this.pendingAppendItems = [];
    this.appendFlushScheduled = false;
  }

  private flushPendingAppendItems() {
    if (this.pendingAppendItems.length === 0) {
      this.appendFlushScheduled = false;
      return;
    }
    const items = this.pendingAppendItems;
    this.pendingAppendItems = [];
    this.appendFlushScheduled = false;
    this.writeEvent({
      type: "append_items",
      items,
    });
  }

  private scheduleAppendFlush() {
    if (this.appendFlushScheduled) {
      return;
    }
    this.appendFlushScheduled = true;
    queueMicrotask(() => {
      this.flushPendingAppendItems();
    });
  }

  private emit(event: BridgeEvent) {
    if (event.type === "init" || event.type === "replace_items") {
      this.discardPendingAppendItems();
    } else if (event.type !== "append_items") {
      this.flushPendingAppendItems();
    }
    this.writeEvent(event);
  }

  private emitInit() {
    this.emit({
      type: "init",
      snapshot: this.snapshot(),
    });
  }

  private emitStatus() {
    this.emit({
      type: "set_status",
      status: this.status,
    });
  }

  private emitLiveText() {
    this.emit({
      type: "set_live_text",
      liveText: this.liveText,
    });
  }

  private emitReplaceItems() {
    this.emit({
      type: "replace_items",
      items: this.items,
    });
  }

  private emitSessions() {
    this.emit({
      type: "set_sessions",
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    });
  }

  private emitPendingReviews() {
    this.emit({
      type: "set_pending_reviews",
      pendingReviews: this.pendingReviews,
    });
  }

  private emitRuntimeMetadata() {
    this.emit({
      type: "set_runtime_metadata",
      auth: toBridgeAuthStatus(this.authStatus),
      currentModel: this.transport?.getModel() ?? this.authStatus?.model ?? "",
      currentProvider: this.transport?.getProvider() ?? this.authStatus?.provider ?? "",
      currentProviderKeySource: this.currentProviderKeySource,
      availableModels: this.availableModels,
      availableProviders: this.availableProviders,
      providerProfiles: this.providerProfiles,
      providerProfileSources: this.providerProfileSources,
      appRoot: this.appRoot,
    });
  }

  private async emitAuthDefaults() {
    await this.ensureRuntime();
    const providerBaseUrl =
      this.transport?.getProvider() ?? this.authStatus?.provider ?? "";
    const normalizedProvider =
      providerBaseUrl && providerBaseUrl !== "local-core" && providerBaseUrl !== "none"
        ? providerBaseUrl
        : "";
    const apiKey = normalizedProvider
      ? (await this.authRuntime?.getSavedApiKey(normalizedProvider)) ?? ""
      : "";
    this.emit({
      type: "set_auth_defaults",
      providerBaseUrl: normalizedProvider,
      model: this.transport?.getModel() ?? this.authStatus?.model ?? "",
      apiKey,
    });
  }

  private emitError(message: string) {
    this.emit({
      type: "error",
      message,
    });
  }

  private listPendingReviews(): BridgeReview[] {
    return (this.mcpService?.listPending() ?? []).map(item => ({
      id: item.id,
      action: item.request.action,
      path: item.request.path,
      previewSummary: item.previewSummary,
      previewFull: item.previewFull,
      createdAt: item.createdAt,
    }));
  }

  private pushItem(item: BridgeItem) {
    if (this.items.length === 1 && this.items[0]?.text === DEFAULT_EMPTY_STATE.text) {
      this.items = [item];
      this.emitReplaceItems();
      return;
    }
    this.items.push(item);
    this.pendingAppendItems.push(item);
    this.scheduleAppendFlush();
  }

  private async pushRuntimeResult(message: string, ok = true) {
    this.pushItem({
      role: "system",
      kind: ok ? "system_hint" : "error",
      text: message,
    });
    this.emitStatus();
  }

  private async pushSystemMessage(
    text: string,
    options?: { kind?: BridgeItem["kind"] }
  ) {
    this.pushItem({
      role: "system",
      kind: options?.kind ?? "system_hint",
      text,
    });
  }

  private formatReducerStateMessage(session: SessionRecord | null) {
    const lines = [
      "Reducer state:",
      "auto summary refresh: enabled",
      `runtime state updates: ${this.stateUpdateCount}`,
      `status: ${this.status}`,
      `model: ${this.transport?.getModel() ?? this.authStatus?.model ?? "-"}`,
      `session: ${session?.id ?? this.activeSessionId ?? "-"}`,
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
  }

  private getSkillDefinitionById(skillId: string): SkillDefinition | null {
    const normalized = skillId.trim().toLowerCase();
    if (!normalized || !this.skillsRuntime) {
      return null;
    }
    return (
      this.skillsRuntime
        .listSkills()
        .find(skill => skill.id.trim().toLowerCase() === normalized) ?? null
    );
  }

  private getSessionSkillUseIds(sessionId: string | null) {
    return sessionId ? [...(this.sessionSkillUseIds.get(sessionId) ?? [])] : [];
  }

  private setSessionSkillUseIds(sessionId: string | null, ids: string[]) {
    if (!sessionId) {
      return;
    }
    const deduped = [...new Set(ids.map(item => item.trim()).filter(Boolean))];
    if (deduped.length === 0) {
      this.sessionSkillUseIds.delete(sessionId);
      return;
    }
    this.sessionSkillUseIds.set(sessionId, deduped);
  }

  private resolveSessionSkillUseDefinitions(sessionId: string | null) {
    if (!this.skillsRuntime || !sessionId) {
      return [] as SkillDefinition[];
    }
    const ids = this.getSessionSkillUseIds(sessionId);
    if (ids.length === 0) {
      return [] as SkillDefinition[];
    }
    const byId = new Map(
      this.skillsRuntime
        .listSkills()
        .map(skill => [skill.id.trim().toLowerCase(), skill] as const)
    );
    const selected: SkillDefinition[] = [];
    const seen = new Set<string>();
    for (const skillId of ids) {
      const skill = byId.get(skillId.trim().toLowerCase());
      if (!skill || seen.has(skill.id)) {
        continue;
      }
      seen.add(skill.id);
      selected.push(skill);
    }
    return selected;
  }

  private getApprovalRisk(action: PendingReviewItem["request"]["action"]) {
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
  }

  private async refreshSessions() {
    await this.ensureRuntime();
    this.sessions = ((await this.sessionStore?.listSessions()) ?? []).map(item => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      tags: [...item.tags],
    }));
    this.emitSessions();
  }

  private async executeSlashCommand(rawText: string) {
    await this.ensureRuntime();
    const query = rawText.trim();
    if (!query.startsWith("/")) {
      this.emitError(`Unsupported command: ${query}`);
      return;
    }

    if (query === "/help") {
      await this.pushSystemMessage(HELP_TEXT);
      return;
    }

    if (query === "/cancel") {
      await this.pushSystemMessage(
        "Cancel is not wired in v2 bridge mode yet.",
        { kind: "error" }
      );
      return;
    }

    const sessionHandled = await handleSessionCommand({
      query,
      sessionStore: this.sessionStore!,
      activeSessionId: this.activeSessionId,
      systemPrompt: this.runtimeSystemPrompt,
      defaultSystemPrompt: this.defaultSystemPrompt,
      pinMaxCount: this.config?.pinMaxCount ?? 8,
      pushSystemMessage: (text, options) =>
        void this.pushSystemMessage(text, { kind: options?.kind as BridgeItem["kind"] | undefined }),
      clearInput: () => {},
      setSystemPrompt: prompt => {
        this.runtimeSystemPrompt = prompt;
      },
      formatReducerStateMessage: session => this.formatReducerStateMessage(session),
      ensureActiveSession: titleHint => this.ensureActiveSession(titleHint),
      startNewSession: () => this.newSession(),
      undoLastMutation: () => this.mcpService!.undoLastMutation(),
      openSessionsPanel: (sessions: SessionListItem[]) =>
        void this.pushSystemMessage(
          sessions.length > 0
            ? ["Sessions", ...sessions.map(item => `${item.id} | ${item.title} | ${item.updatedAt}`)].join("\n")
            : "No sessions yet."
        ),
      openResumePicker: (sessions: SessionListItem[]) =>
        void this.pushSystemMessage(
          sessions.length > 0
            ? ["Resume sessions", ...sessions.map(item => `${item.id} | ${item.title} | ${item.updatedAt}`)].join("\n")
            : "No sessions to resume."
        ),
      loadSessionIntoChat: sessionId => this.loadSession(sessionId),
    });
    if (sessionHandled) {
      return;
    }

    const skillsHandled = await handleSkillsCommand({
      query,
      skillsService: this.skillsRuntime ?? undefined,
      activeSessionId: this.activeSessionId,
      pushSystemMessage: (text, options) =>
        void this.pushSystemMessage(text, { kind: options?.kind as BridgeItem["kind"] | undefined }),
      clearInput: () => {},
      getSkillDefinitionById: skillId => this.getSkillDefinitionById(skillId),
      getSessionSkillUseIds: sessionId => this.getSessionSkillUseIds(sessionId),
      setSessionSkillUseIds: (sessionId, ids) => this.setSessionSkillUseIds(sessionId, ids),
    });
    if (skillsHandled) {
      return;
    }

    const mcpHandled = await handleMcpCommand({
      query,
      mcpService: this.mcpService!,
      pushSystemMessage: (text, options) =>
        void this.pushSystemMessage(text, { kind: options?.kind as BridgeItem["kind"] | undefined }),
      clearInput: () => {},
      getApprovalRisk: action => this.getApprovalRisk(action),
    });
    if (mcpHandled) {
      this.pendingReviews = this.listPendingReviews();
      this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
      await this.refreshRuntimeMetadata();
      this.emitPendingReviews();
      this.emitStatus();
      return;
    }

    this.emitError(`Unknown command: ${query}`);
  }

  private hydrateTranscript(record: SessionRecord) {
    this.items =
      record.messages.length > 0
        ? record.messages.map(message => ({
            role: message.role,
            kind: message.role === "system" ? "system_hint" : "transcript",
            text:
              message.role === "assistant"
                ? parseAssistantStateUpdate(message.text).visibleText
                : message.text,
          }))
        : [DEFAULT_EMPTY_STATE];
    this.liveText = record.inFlightTurn
      ? parseAssistantStateUpdate(record.inFlightTurn.assistantText).visibleText
      : "";
  }

  private async loadSession(sessionId: string, options?: { emit?: boolean }) {
    await this.ensureRuntime();
    let record = await this.sessionStore?.loadSession(sessionId);
    if (!record) {
      this.emitError(`Session not found: ${sessionId}`);
      return;
    }

    if (record.projectRoot?.trim()) {
      const normalizedProjectRoot = resolve(record.projectRoot);
      if (normalizedProjectRoot !== this.appRoot) {
        await this.loadRuntime(normalizedProjectRoot);
        await this.refreshSessions();
        record = await this.sessionStore?.loadSession(sessionId);
        if (!record) {
          this.emitError(`Session not found after runtime switch: ${sessionId}`);
          return;
        }
      }
    }

    this.activeSessionId = record.id;
    this.suspended = null;
    this.pendingReviews = this.listPendingReviews();
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    this.hydrateTranscript(record);
    await this.refreshRuntimeMetadata();
    if (options?.emit !== false) {
      this.emitInit();
    }
  }

  private async ensureActiveSession(titleHint?: string) {
    await this.ensureRuntime();
    if (this.activeSessionId) {
      const loaded = await this.sessionStore?.loadSession(this.activeSessionId);
      if (loaded) {
        return loaded;
      }
    }

    const created = await this.sessionStore?.createSession(titleHint);
    if (!created) {
      throw new Error("Failed to create session.");
    }
    this.activeSessionId = created.id;
    this.items = [DEFAULT_EMPTY_STATE];
    this.liveText = "";
    await this.refreshSessions();
    return created;
  }

  private async newSession() {
    if (this.status === "requesting" || this.status === "streaming") {
      this.emitError("Query already in progress.");
      return;
    }

    await this.ensureRuntime();
    const created = await this.sessionStore?.createSession();
    if (!created) {
      throw new Error("Failed to create session.");
    }

    this.activeSessionId = created.id;
    this.suspended = null;
    this.items = [DEFAULT_EMPTY_STATE];
    this.liveText = "";
    this.pendingReviews = this.listPendingReviews();
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    await this.refreshSessions();
    await this.refreshRuntimeMetadata();
    this.emitInit();
  }

  private async submit(rawText: string) {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (this.status === "requesting" || this.status === "streaming") {
      this.emitError("Query already in progress.");
      return;
    }
    if (this.status === "awaiting_review") {
      this.emitError("Resolve the pending approval before sending another query.");
      return;
    }

    await this.ensureRuntime();
    const session = await this.ensureActiveSession(text);
    const promptContext = await this.sessionStore!.getPromptContext(session.id, text);
    const autoSkills = this.skillsRuntime?.resolveForQuery(text) ?? [];
    const manualSkills = this.resolveSessionSkillUseDefinitions(session.id);
    const activeSkills = [...manualSkills, ...autoSkills].filter(
      (skill, index, all) => all.findIndex(item => item.id === skill.id) === index
    );
    const prompt = buildPromptWithContext(
      text,
      this.runtimeSystemPrompt,
      this.promptPolicy!.projectPrompt,
      promptContext,
      activeSkills.length > 0 ? formatActiveSkillsPrompt(activeSkills) : ""
    );

    const startedAt = new Date().toISOString();
    await this.sessionStore!.appendMessage(session.id, {
      role: "user",
      text,
      createdAt: startedAt,
    });
    await this.sessionStore!.updateInFlightTurn(session.id, {
      userText: text,
      assistantText: "",
      startedAt,
      updatedAt: startedAt,
    });

    this.activeSessionId = session.id;
    this.liveText = "";
    this.suspended = null;
    this.status = "preparing";
    this.emitStatus();
    this.pushItem({ role: "user", kind: "transcript", text });
    await this.refreshSessions();
    await this.refreshRuntimeMetadata();

    const assistantBufferRef = { current: "" };
    try {
      const result = await runQuerySession({
        query: prompt,
        originalTask: text,
        queryMaxToolSteps: this.config!.queryMaxToolSteps,
        transport: this.transport!,
        onState: next => {
          if (this.status === next.status) {
            return;
          }
          this.status = next.status;
          this.emitStatus();
        },
        onTextDelta: delta => {
          assistantBufferRef.current += delta;
          this.liveText = parseAssistantStateUpdate(assistantBufferRef.current).visibleText;
          this.status = "streaming";
          this.emitStatus();
          this.emitLiveText();
        },
        onToolStatus: message => {
          this.pushItem({
            role: "system",
            kind: "tool_status",
            text: message,
          });
        },
        onToolCall: async (toolName, input) => {
          const result = await this.mcpService!.handleToolCall(toolName, input);
          if (result.pending) {
            const pending = result.pending;
            const detail = `${pending.request.action} ${pending.request.path}`;
            this.pushItem({
              role: "system",
              kind: "review_status",
              text: `Approval required | ${detail} | ${pending.id}`,
            });
            this.pendingReviews = this.listPendingReviews();
            this.status = "awaiting_review";
            this.emitPendingReviews();
            this.emitStatus();
            return {
              message: `Approval required ${pending.id} | ${detail}`,
              reviewMode: "block" as const,
            };
          }

          const formatted = formatBridgeToolMessage(result.message);
          this.pushItem({
            role: "system",
            kind: result.ok ? formatted.kind : "error",
            text: formatted.text,
          });
          return { message: result.message };
        },
        onError: message => {
          this.status = "error";
          this.pushItem({
            role: "system",
            kind: "error",
            text: `Stream error: ${message}`,
          });
          this.emitStatus();
        },
      });

      await this.consumeRunResult({
        sessionId: session.id,
        userText: text,
        startedAt,
        assistantBufferRef,
        result,
      });
    } catch (error) {
      await this.sessionStore!.updateInFlightTurn(session.id, null);
      this.status = "error";
      this.emitError(error instanceof Error ? error.message : String(error));
      this.emitStatus();
    }
  }

  private async consumeRunResult(input: {
    sessionId: string;
    userText: string;
    startedAt: string;
    assistantBufferRef: { current: string };
    result: RunQuerySessionResult | void;
  }) {
    if (!input.result || input.result.status === "completed") {
      await this.finalizeAssistant(input.sessionId, input.assistantBufferRef.current);
      return;
    }

    this.suspended = {
      sessionId: input.sessionId,
      userText: input.userText,
      startedAt: input.startedAt,
      assistantBufferRef: input.assistantBufferRef,
      resume: input.result.resume,
    };
    await this.sessionStore!.updateInFlightTurn(input.sessionId, {
      userText: input.userText,
      assistantText: input.assistantBufferRef.current,
      startedAt: input.startedAt,
      updatedAt: new Date().toISOString(),
    });

    this.pendingReviews = this.listPendingReviews();
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    await this.refreshRuntimeMetadata();
    this.emitPendingReviews();
    this.emitStatus();
    this.emitLiveText();
  }

  private createStateDiagnostic(
    nextSummary: string,
    nextPendingDigest: string,
    updatedAt: string,
    code: SessionStateUpdateDiagnostic["code"],
    message: string,
    reducerMode?: SessionStateUpdateDiagnostic["reducerMode"]
  ): SessionStateUpdateDiagnostic {
    return {
      code,
      message,
      updatedAt,
      reducerMode,
      summaryLength: nextSummary.trim().length,
      pendingDigestLength: nextPendingDigest.trim().length,
    };
  }

  private async applyAssistantStateUpdate(sessionId: string, rawAssistantText: string) {
    const parsed = parseAssistantStateUpdate(rawAssistantText);
    const visibleAssistantText = parsed.visibleText.trim();
    const updatedAt = new Date().toISOString();
    const nextPendingChoice = extractPendingChoiceFromAssistantText(
      visibleAssistantText,
      updatedAt
    );

    if (visibleAssistantText) {
      this.pushItem({ role: "assistant", kind: "transcript", text: visibleAssistantText });
      await this.sessionStore!.appendMessage(sessionId, {
        role: "assistant",
        text: visibleAssistantText,
        createdAt: updatedAt,
      });
    }

    const latest = await this.sessionStore!.loadSession(sessionId);
    if (latest) {
      let nextSummary = latest.summary;
      let nextPendingDigest = latest.pendingDigest;
      let diagnostic: SessionStateUpdateDiagnostic;
      const latestUserText =
        [...latest.messages]
          .reverse()
          .find(message => message.role === "user")
          ?.text ?? "";

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

      if (parsed.parseStatus === "missing_tag") {
        diagnostic = this.createStateDiagnostic(
          nextSummary,
          nextPendingDigest,
          updatedAt,
          "missing_tag",
          withLocalFallbackState(
            "Assistant reply finished without a <cyrene_state_update> block."
          )
        );
      } else if (parsed.parseStatus === "incomplete_tag") {
        diagnostic = this.createStateDiagnostic(
          nextSummary,
          nextPendingDigest,
          updatedAt,
          "incomplete_tag",
          withLocalFallbackDigest(
            "Assistant reply started a <cyrene_state_update> block, but it did not complete before the turn ended."
          )
        );
      } else if (parsed.parseStatus === "empty_payload") {
        diagnostic = this.createStateDiagnostic(
          nextSummary,
          nextPendingDigest,
          updatedAt,
          "empty_payload",
          withLocalFallbackDigest(
            "Assistant reply included an empty <cyrene_state_update> payload."
          )
        );
      } else if (parsed.parseStatus === "invalid_payload") {
        diagnostic = this.createStateDiagnostic(
          nextSummary,
          nextPendingDigest,
          updatedAt,
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
        diagnostic = this.createStateDiagnostic(
          nextSummary,
          nextPendingDigest,
          updatedAt,
          nextSummary.trim() || nextPendingDigest.trim() ? "applied" : "applied_empty_state",
          nextSummary.trim() || nextPendingDigest.trim()
            ? `State update applied in ${parsed.update?.mode}.`
            : `State update applied in ${parsed.update?.mode}, but it produced empty durable state.`,
          parsed.update?.mode
        );
        if (applied.updated) {
          this.stateUpdateCount += 1;
        }
      }

      await this.sessionStore!.updateWorkingState(sessionId, {
        summary: nextSummary,
        pendingDigest: nextPendingDigest,
        lastStateUpdate: diagnostic,
      });
    }

    await this.sessionStore!.updatePendingChoice(sessionId, nextPendingChoice);
  }

  private async finalizeAssistant(sessionId: string, assistantText: string) {
    this.liveText = "";
    this.suspended = null;
    await this.applyAssistantStateUpdate(sessionId, assistantText);
    await this.sessionStore!.updateInFlightTurn(sessionId, null);
    this.pendingReviews = this.listPendingReviews();
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    await this.refreshSessions();
    await this.refreshRuntimeMetadata();
    this.emitPendingReviews();
    this.emitStatus();
    this.emitLiveText();
  }

  private async cancelSuspended(message: string) {
    const suspended = this.suspended;
    if (!suspended) {
      return;
    }

    await this.applyAssistantStateUpdate(
      suspended.sessionId,
      suspended.assistantBufferRef.current
    );
    if (message.trim()) {
      this.pushItem({ role: "system", kind: "review_status", text: message.trim() });
    }

    this.liveText = "";
    this.suspended = null;
    await this.sessionStore!.updateInFlightTurn(suspended.sessionId, null);
    this.pendingReviews = this.listPendingReviews();
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    await this.refreshSessions();
    await this.refreshRuntimeMetadata();
    this.emitPendingReviews();
    this.emitStatus();
    this.emitLiveText();
  }

  private async approve(id: string) {
    await this.ensureRuntime();
    const target = this.mcpService!.listPending().find(item => item.id === id);
    const result = await this.mcpService!.approve(id);
    this.pendingReviews = this.listPendingReviews();

    if (!result.ok) {
      this.emitError(result.message);
      this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "error";
      this.emitPendingReviews();
      this.emitStatus();
      return false;
    }

    this.pushItem({
      role: "system",
      kind: "review_status",
      text: reviewMessage("Approved", target, firstLine(result.message)),
    });
    this.emitPendingReviews();

    const suspended = this.suspended;
    if (!suspended) {
      this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
      this.emitStatus();
      return true;
    }

    this.suspended = null;
    const nextResult = await suspended.resume(result.message);
    await this.consumeRunResult({
      sessionId: suspended.sessionId,
      userText: suspended.userText,
      startedAt: suspended.startedAt,
      assistantBufferRef: suspended.assistantBufferRef,
      result: nextResult,
    });
    return true;
  }

  private async reject(id: string) {
    await this.ensureRuntime();
    const target = this.mcpService!.listPending().find(item => item.id === id);
    const result = this.mcpService!.reject(id);
    this.pendingReviews = this.listPendingReviews();

    if (!result.ok) {
      this.emitError(result.message);
      this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "error";
      this.emitPendingReviews();
      this.emitStatus();
      return false;
    }

    const message = reviewMessage("Rejected", target, firstLine(result.message));
    if (this.suspended) {
      await this.cancelSuspended(message);
      return true;
    }

    this.pushItem({ role: "system", kind: "review_status", text: message });
    this.status = this.pendingReviews.length > 0 ? "awaiting_review" : "idle";
    this.emitPendingReviews();
    this.emitStatus();
    return true;
  }

  private async approveAll() {
    await this.ensureRuntime();
    while (true) {
      const pending = this.mcpService!.listPending();
      if (pending.length === 0) {
        break;
      }
      const first = pending[0];
      if (!first) {
        break;
      }
      const ok = await this.approve(first.id);
      if (!ok) {
        break;
      }
    }
  }

  private async approveLow() {
    await this.ensureRuntime();
    while (true) {
      const pending = this.mcpService!.listPending();
      const next = pending.find(item => !isHighRiskReviewAction(item.request.action));
      if (!next) {
        break;
      }
      const ok = await this.approve(next.id);
      if (!ok) {
        break;
      }
    }
  }

  private async rejectAll() {
    await this.ensureRuntime();
    while (true) {
      const pending = this.mcpService!.listPending();
      if (pending.length === 0) {
        break;
      }
      const first = pending[0];
      if (!first) {
        break;
      }
      const ok = await this.reject(first.id);
      if (!ok) {
        break;
      }
    }
  }

  private async setModel(nextModel: string) {
    await this.ensureRuntime();
    const model = nextModel.trim();
    if (!model) {
      this.emitError("Model name is required.");
      return;
    }

    const result = await this.transport!.setModel(model);
    if (result.ok) {
      await this.authRuntime?.syncSelection({
        providerBaseUrl: this.transport!.getProvider(),
        model: this.transport!.getModel(),
      });
      this.markRuntimeMetadataDirty();
      await this.refreshRuntimeMetadata();
    }

    this.status = result.ok ? "idle" : "error";
    await this.pushRuntimeResult(result.message, result.ok);
  }

  private async setProvider(nextProvider: string) {
    await this.ensureRuntime();
    const provider = nextProvider.trim();
    if (!provider) {
      this.emitError("Provider is required.");
      return;
    }

    const result = await this.transport!.setProvider(provider);
    if (result.ok) {
      await this.authRuntime?.syncSelection({
        providerBaseUrl: this.transport!.getProvider(),
        model: this.transport!.getModel(),
      });
      this.markRuntimeMetadataDirty();
      await this.refreshRuntimeMetadata();
    }

    this.status = result.ok ? "idle" : "error";
    await this.pushRuntimeResult(result.message, result.ok);
  }

  private async refreshModels() {
    await this.ensureRuntime();
    const result = await this.transport!.refreshModels();
    if (result.ok) {
      await this.authRuntime?.syncSelection({
        providerBaseUrl: this.transport!.getProvider(),
        model: this.transport!.getModel(),
      });
      this.markRuntimeMetadataDirty();
      await this.refreshRuntimeMetadata();
    }

    this.status = result.ok ? "idle" : "error";
    await this.pushRuntimeResult(result.message, result.ok);
  }

  private async listProviderProfiles() {
    await this.ensureRuntime();
    const list = this.transport?.listProviderProfiles?.() ?? {};
    const lines = Object.entries(list)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, profile]) => `- ${provider} => ${profile}`);

    const text =
      lines.length > 0
        ? ["Manual provider profile overrides:", ...lines].join("\n")
        : "No manual provider profile overrides.";
    await this.pushRuntimeResult(text, true);
  }

  private async setProviderProfile(rawProfile: string, targetProviderRaw?: string) {
    await this.ensureRuntime();
    const profile = rawProfile.trim().toLowerCase() as ProviderProfile;
    if (
      profile !== "openai" &&
      profile !== "gemini" &&
      profile !== "anthropic" &&
      profile !== "custom"
    ) {
      this.emitError("Profile must be openai, gemini, anthropic, or custom.");
      return;
    }
    if (!this.transport?.setProviderProfile) {
      this.emitError("Provider profile override is unavailable in this transport.");
      return;
    }

    const targetProvider =
      targetProviderRaw?.trim() || this.transport.getProvider() || this.authStatus?.provider || "";
    if (!targetProvider || targetProvider === "none") {
      this.emitError("No active provider. Use /provider <url> first, or pass [url] explicitly.");
      return;
    }

    const result = await this.transport.setProviderProfile(targetProvider, profile);
    if (result.ok) {
      await this.authRuntime?.syncSelection({
        providerBaseUrl: this.transport.getProvider(),
        model: this.transport.getModel(),
      });
      this.markRuntimeMetadataDirty();
      await this.refreshRuntimeMetadata();
    }
    this.status = result.ok ? "idle" : "error";
    await this.pushRuntimeResult(result.message, result.ok);
  }

  private async clearProviderProfile(targetProviderRaw?: string) {
    await this.setProviderProfile("custom", targetProviderRaw);
  }

  private async login(providerBaseUrl: string, apiKey: string, model?: string) {
    await this.ensureRuntime();
    if (!this.authRuntime) {
      this.emitError("Auth runtime unavailable.");
      return;
    }

    const result = await this.authRuntime.saveLogin({
      providerBaseUrl: providerBaseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model?.trim() || undefined,
    });

    this.transport = result.transport;
    this.status = result.ok ? "idle" : "error";
    if (result.ok) {
      this.markRuntimeMetadataDirty();
      await this.refreshRuntimeMetadata();
    }
    await this.pushRuntimeResult(result.message, result.ok);
  }

  private async logout() {
    await this.ensureRuntime();
    if (!this.authRuntime) {
      this.emitError("Auth runtime unavailable.");
      return;
    }

    const result = await this.authRuntime.logout();
    this.transport = result.transport;
    this.status = result.ok ? "idle" : "error";
    if (result.ok) {
      this.markRuntimeMetadataDirty();
      await this.refreshRuntimeMetadata();
    }
    await this.pushRuntimeResult(result.message, result.ok);
  }

  private dispose() {
    this.flushPendingAppendItems();
    try {
      this.mcpService?.dispose();
    } catch {
      // Ignore shutdown failures.
    }
  }
}

const bridge = new BubbleTeaBridge();
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", line => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    bridge.enqueue(JSON.parse(trimmed) as BridgeCommand);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({ type: "error", message: `Invalid command: ${message}` })}\n`
    );
  }
});

input.on("close", () => {
  bridge.enqueue({ type: "shutdown" });
});
