import type { SessionStore } from "../../core/session/store";
import {
  getWorkingStateEntryText,
  parseWorkingStateSummary,
  type WorkingStateSectionName,
} from "../../core/session/workingState";
import type { ChatItem } from "../../shared/types/chat";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;

type HandleSessionCommandParams = {
  query: string;
  sessionStore: SessionStore;
  activeSessionId: string | null;
  systemPrompt: string;
  defaultSystemPrompt: string;
  pinMaxCount: number;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
  setSystemPrompt: (prompt: string) => void;
  formatReducerStateMessage: (
    session: Awaited<ReturnType<SessionStore["loadSession"]>>
  ) => string;
  ensureActiveSession: (titleHint?: string) => ReturnType<SessionStore["createSession"]>;
  startNewSession: () => Promise<void>;
  undoLastMutation: () => Promise<{ ok: boolean; message: string }>;
  openSessionsPanel: (
    sessions: Awaited<ReturnType<SessionStore["listSessions"]>>
  ) => void;
  openResumePicker: (
    sessions: Awaited<ReturnType<SessionStore["listSessions"]>>
  ) => void;
  loadSessionIntoChat: (sessionId: string) => Promise<void>;
};

const INFO_MESSAGE_OPTIONS = {
  kind: "system_hint",
  tone: "info",
  color: "cyan",
} satisfies SystemMessageOptions;

const ERROR_MESSAGE_OPTIONS = {
  kind: "error",
  tone: "danger",
  color: "red",
} satisfies SystemMessageOptions;

const CHECKPOINT_SECTIONS: WorkingStateSectionName[] = [
  "OBJECTIVE",
  "DECISIONS",
  "ENTITY STATE",
  "REMAINING",
  "NEXT BEST ACTIONS",
  "STALE OR CONFLICTING",
];

const sectionCheckpointLabels: Record<WorkingStateSectionName, string> = {
  OBJECTIVE: "objective",
  "CONFIRMED FACTS": "facts",
  ASSUMPTIONS: "assumptions",
  CONSTRAINTS: "constraints",
  DECISIONS: "decisions",
  "ENTITY STATE": "entity state",
  COMPLETED: "completed",
  REMAINING: "remaining",
  "KNOWN PATHS": "paths",
  "RECENT FAILURES": "failures",
  "STALE OR CONFLICTING": "stale/conflicting",
  "NEXT BEST ACTIONS": "next actions",
};

const checkpointEntryText = (line: string) => {
  const text = getWorkingStateEntryText(line) || line.trim();
  return text && text !== "(none)" ? text : "";
};

const collectCheckpointSectionLines = (
  session: Awaited<ReturnType<SessionStore["loadSession"]>>,
  section: WorkingStateSectionName,
  limit: number
) => {
  if (!session) {
    return [];
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of [session.pendingDigest, session.summary]) {
    const parsed = parseWorkingStateSummary(source);
    for (const rawLine of parsed[section] ?? []) {
      const text = checkpointEntryText(rawLine);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) {
        continue;
      }
      seen.add(key);
      lines.push(text);
      if (lines.length >= limit) {
        return lines;
      }
    }
  }
  return lines;
};

const formatCheckpointPlanLine = (
  session: Awaited<ReturnType<SessionStore["loadSession"]>>
) => {
  const plan = session?.executionPlan;
  if (!plan || plan.steps.length === 0) {
    return "";
  }
  const completed = plan.steps.filter(step => step.status === "completed").length;
  const active =
    plan.steps.find(step => step.status === "in_progress") ??
    plan.steps.find(step => step.status === "pending") ??
    plan.steps.find(step => step.status === "blocked");
  const status = active ? `${active.status}: ${active.title}` : "no active step";
  return `plan: ${completed}/${plan.steps.length} completed; ${status}`;
};

const formatSessionCheckpoint = (
  session: Awaited<ReturnType<SessionStore["loadSession"]>>,
  note: string
) => {
  const lines = ["Checkpoint"];
  const trimmedNote = note.trim();
  if (trimmedNote) {
    lines.push(`note: ${trimmedNote}`);
  }

  const planLine = formatCheckpointPlanLine(session);
  if (planLine) {
    lines.push(planLine);
  }

  for (const section of CHECKPOINT_SECTIONS) {
    for (const item of collectCheckpointSectionLines(session, section, 2)) {
      lines.push(`${sectionCheckpointLabels[section]}: ${item}`);
    }
  }

  if (lines.length === 1) {
    lines.push("state: no reducer summary, pending digest, or execution plan yet");
  }
  return lines.join(" | ");
};

export const handleSessionCommand = async ({
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
  startNewSession,
  undoLastMutation,
  openSessionsPanel,
  openResumePicker,
  loadSessionIntoChat,
}: HandleSessionCommandParams) => {
  if (query === "/new") {
    await startNewSession();
    clearInput();
    return true;
  }

  if (query === "/undo") {
    const result = await undoLastMutation();
    pushSystemMessage(result.message, {
      kind: result.ok ? "system_hint" : "error",
      tone: result.ok ? "info" : "danger",
      color: result.ok ? "cyan" : "red",
    });
    clearInput();
    return true;
  }

  if (query === "/search-session") {
    pushSystemMessage(
      "Usage: /search-session <query> | /search-session #<tag> [query]"
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/search-session ")) {
    const raw = query.slice("/search-session ".length).trim();
    if (!raw) {
      pushSystemMessage(
        "Usage: /search-session <query> | /search-session #<tag> [query]"
      );
      clearInput();
      return true;
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
      pushSystemMessage(`No sessions matched.${tag ? ` (tag: ${tag})` : ""}`);
      clearInput();
      return true;
    }
    pushSystemMessage(
      [
        `Found ${results.length} session(s):`,
        ...results.map((item, index) => {
          const tagSuffix = item.tags.length > 0 ? ` #${item.tags.join(" #")}` : "";
          return `${index + 1}. ${item.id} | ${item.title}${tagSuffix}`;
        }),
      ].join("\n")
    );
    clearInput();
    return true;
  }

  if (query === "/tag") {
    pushSystemMessage("Usage: /tag list | /tag add <tag> | /tag remove <tag>");
    clearInput();
    return true;
  }

  if (query === "/tag list") {
    const session = await ensureActiveSession();
    if (session.tags.length === 0) {
      pushSystemMessage("No tags yet. Use /tag add <tag>.");
    } else {
      pushSystemMessage(`Session tags:\n${session.tags.map(tag => `#${tag}`).join("\n")}`);
    }
    clearInput();
    return true;
  }

  if (query.startsWith("/tag add ")) {
    const tag = query.slice("/tag add ".length).trim();
    if (!tag) {
      pushSystemMessage("Usage: /tag add <tag>");
      clearInput();
      return true;
    }
    const session = await ensureActiveSession();
    const next = await sessionStore.addTag(session.id, tag);
    pushSystemMessage(
      next.tags.length > 0
        ? `Tag added. Current tags: ${next.tags.map(item => `#${item}`).join(" ")}`
        : "Tag was not added."
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/tag remove ")) {
    const tag = query.slice("/tag remove ".length).trim();
    if (!tag) {
      pushSystemMessage("Usage: /tag remove <tag>");
      clearInput();
      return true;
    }
    const session = await ensureActiveSession();
    const next = await sessionStore.removeTag(session.id, tag);
    if (next.tags.length === 0) {
      pushSystemMessage("Tag removed. No tags remain.");
    } else {
      pushSystemMessage(
        `Tag removed. Current tags: ${next.tags.map(item => `#${item}`).join(" ")}`
      );
    }
    clearInput();
    return true;
  }

  if (query === "/system") {
    pushSystemMessage(`Current system prompt:\n${systemPrompt}`);
    clearInput();
    return true;
  }

  if (query === "/state") {
    const activeSession = activeSessionId
      ? await sessionStore.loadSession(activeSessionId)
      : null;
    pushSystemMessage(formatReducerStateMessage(activeSession), INFO_MESSAGE_OPTIONS);
    clearInput();
    return true;
  }

  if (query === "/system reset") {
    setSystemPrompt(defaultSystemPrompt);
    pushSystemMessage("System prompt reset to default.");
    clearInput();
    return true;
  }

  if (query.startsWith("/system ")) {
    const nextPrompt = query.slice("/system ".length).trim();
    if (!nextPrompt) {
      pushSystemMessage("Usage: /system <prompt_text> | /system reset");
      clearInput();
      return true;
    }
    setSystemPrompt(nextPrompt);
    pushSystemMessage("System prompt updated for current runtime.");
    clearInput();
    return true;
  }

  if (query === "/sessions") {
    const sessions = await sessionStore.listSessions();
    if (sessions.length === 0) {
      pushSystemMessage("No sessions yet.");
    } else {
      openSessionsPanel(sessions);
    }
    clearInput();
    return true;
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
    return true;
  }

  if (query === "/checkpoint" || query.startsWith("/checkpoint ")) {
    const note =
      query === "/checkpoint" ? "" : query.slice("/checkpoint ".length).trim();
    const session = await ensureActiveSession("checkpoint");
    if (session.focus.length >= pinMaxCount) {
      pushSystemMessage(
        `Pin limit reached (${pinMaxCount}). Remove low-value pins with /unpin <index> before adding a checkpoint.`
      );
      clearInput();
      return true;
    }
    const checkpoint = formatSessionCheckpoint(session, note);
    const next = await sessionStore.addFocus(session.id, checkpoint);
    pushSystemMessage(`Checkpoint pinned (${next.focus.length}): ${checkpoint}`);
    clearInput();
    return true;
  }

  if (query === "/pin") {
    pushSystemMessage("Usage: /pin <important_note>");
    clearInput();
    return true;
  }

  if (query.startsWith("/pin ")) {
    const note = query.slice("/pin ".length).trim();
    if (!note) {
      pushSystemMessage("Usage: /pin <important_note>");
      clearInput();
      return true;
    }
    const session = await ensureActiveSession();
    if (session.focus.length >= pinMaxCount) {
      pushSystemMessage(
        `Pin limit reached (${pinMaxCount}). Remove low-value pins with /unpin <index> before adding more.`
      );
      clearInput();
      return true;
    }
    const next = await sessionStore.addFocus(session.id, note);
    pushSystemMessage(`Pinned to session focus (${next.focus.length}): ${note}`);
    clearInput();
    return true;
  }

  if (query === "/unpin") {
    pushSystemMessage("Usage: /unpin <index>");
    clearInput();
    return true;
  }

  if (query.startsWith("/unpin ")) {
    const raw = query.slice("/unpin ".length).trim();
    const index = Number(raw);
    if (!Number.isInteger(index) || index <= 0) {
      pushSystemMessage("Usage: /unpin <index> (1-based)");
      clearInput();
      return true;
    }
    const session = await ensureActiveSession();
    if (session.focus.length === 0) {
      pushSystemMessage("No pinned focus to remove.");
      clearInput();
      return true;
    }
    if (index > session.focus.length) {
      pushSystemMessage(`Index out of range. Current pin count: ${session.focus.length}`);
      clearInput();
      return true;
    }
    const removed = session.focus[index - 1];
    const next = await sessionStore.removeFocus(session.id, index - 1);
    pushSystemMessage(`Unpinned #${index}: ${removed}\nRemaining pins: ${next.focus.length}`);
    clearInput();
    return true;
  }

  if (query === "/resume") {
    const sessions = await sessionStore.listSessions();
    if (sessions.length === 0) {
      pushSystemMessage("No sessions to resume.");
    } else {
      openResumePicker(sessions);
    }
    clearInput();
    return true;
  }

  if (query.startsWith("/resume ")) {
    const targetId = query.slice("/resume ".length).trim();
    if (!targetId) {
      pushSystemMessage("Usage: /resume <session_id>");
      clearInput();
      return true;
    }

    await loadSessionIntoChat(targetId);
    clearInput();
    return true;
  }

  return false;
};
