import { useRef, useState } from "react";
import { useInput } from "ink";
import { runQuerySession } from "../../core/query/runQuerySession";
import { buildPromptWithContext } from "../../core/session/buildPromptWithContext";
import { compressContext } from "../../core/session/contextCompression";
import type { SessionStore } from "../../core/session/store";
import type { QuerySessionState } from "../../core/query/sessionMachine";
import type { QueryTransport } from "../../core/query/transport";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";
import type { SessionListItem, SessionRecord } from "../../core/session/types";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import type { FileAction, PendingReviewItem } from "../../core/tools/mcp/types";

type UseChatAppParams = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
  mcpService: FileMcpService;
};

type ResumePickerState = {
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

type ApprovalPreviewMode = "summary" | "full";

type ApprovalPanelState = {
  active: boolean;
  selectedIndex: number;
  previewMode: ApprovalPreviewMode;
  lastOpenedAt: string | null;
};

const defaultSystemText =
  "Type /help to view commands. Use /resume to open session picker.";
const RESUME_PAGE_SIZE = 1;
const MODEL_PAGE_SIZE = 8;
const HELP_TEXT = [
  "Commands:",
  "/help",
  "/model",
  "/model refresh",
  "/model <name>",
  "/system",
  "/system <text>",
  "/system reset",
  "/sessions",
  "/resume",
  "/resume <id>",
  "/new",
  "/pin <note>",
  "/pins",
  "/unpin <index>",
  "/review - inspect full review previews",
  "/review <id> - inspect one pending operation",
  "/approve [id] - approve pending operation",
  "/reject [id] - reject pending operation",
].join("\n");

const condenseForMemory = (text: string, max = 480) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  const head = normalized.slice(0, 320);
  const tail = normalized.slice(-120);
  return `${head} ... ${tail}`;
};

const condenseForDisplay = (text: string, maxLines = 18, maxChars = 1200) => {
  const lines = text.split("\n");
  const limitedLines = lines.slice(0, maxLines);
  let joined = limitedLines.join("\n");
  if (joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars)}...`;
  }
  if (lines.length > maxLines) {
    joined = `${joined}\n... ${lines.length - maxLines} more lines`;
  }
  return joined;
};

const actionColor = (action?: FileAction): ChatItem["color"] => {
  if (!action) {
    return undefined;
  }
  if (action === "delete_file") {
    return "red";
  }
  if (
    action === "create_dir" ||
    action === "create_file" ||
    action === "write_file" ||
    action === "edit_file"
  ) {
    return "green";
  }
  return undefined;
};

const isHighRiskReviewAction = (action: FileAction) =>
  action === "edit_file" || action === "delete_file";

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

const condensePreview = (text: string, maxLines = 120) => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n... ${lines.length - maxLines} more lines`;
};

const normalizeMcpMessage = (raw: string): {
  text: string;
  kind: ChatItem["kind"];
  tone: ChatItem["tone"];
  color: ChatItem["color"];
} => {
  const [header = "", ...rest] = raw.split("\n");
  const body = rest.join("\n");

  if (header.startsWith("[tool result]")) {
    const detail = header.replace("[tool result]", "").trim();
    return {
      text: `Tool result: ${detail}${body ? `\n${body}` : ""}`,
      kind: "tool_status",
      tone: "info",
      color: "cyan",
    };
  }
  if (header.startsWith("[tool error]")) {
    const detail = header.replace("[tool error]", "").trim();
    return {
      text: `Tool error: ${detail}${body ? `\n${body}` : ""}`,
      kind: "error",
      tone: "danger",
      color: "red",
    };
  }
  if (header.startsWith("[approved]")) {
    const id = header.replace("[approved]", "").trim();
    return {
      text: `Approved ${id}${body ? `\n${body}` : ""}`,
      kind: "review_status",
      tone: "success",
      color: "green",
    };
  }
  if (header.startsWith("[approve failed]")) {
    const id = header.replace("[approve failed]", "").trim();
    return {
      text: `Approve failed ${id}${body ? `\n${body}` : ""}`,
      kind: "error",
      tone: "danger",
      color: "red",
    };
  }
  if (header.startsWith("[rejected]")) {
    const id = header.replace("[rejected]", "").trim();
    return {
      text: `Rejected ${id}`,
      kind: "review_status",
      tone: "warning",
      color: "yellow",
    };
  }
  if (raw.startsWith("Pending operation not found:")) {
    const id = raw.replace("Pending operation not found:", "").trim();
    return {
      text: `Pending operation not found: ${id}`,
      kind: "error",
      tone: "danger",
      color: "red",
    };
  }

  return {
    text: raw,
    kind: "system_hint",
    tone: "neutral",
    color: "white",
  };
};

export const useChatApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  mcpService,
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
  const [sessionState, setSessionState] = useState<QuerySessionState | null>(
    null
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [resumePicker, setResumePicker] = useState<ResumePickerState>({
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
  const [pendingReviews, setPendingReviews] = useState<PendingReviewItem[]>([]);
  const [approvalPanel, setApprovalPanel] = useState<ApprovalPanelState>({
    active: false,
    selectedIndex: 0,
    previewMode: "summary",
    lastOpenedAt: null,
  });

  const queueRef = useRef(Promise.resolve());

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

  const ensureActiveSession = async (titleHint?: string) => {
    if (activeSessionId) {
      const loaded = await sessionStore.loadSession(activeSessionId);
      if (loaded) {
        return loaded;
      }
    }

    const created = await sessionStore.createSession(titleHint);
    setActiveSessionId(created.id);
    return created;
  };

  const appendToLastAssistant = (text: string) => {
    setItems(previous => {
      const next = [...previous];
      let lastAssistantIndex = -1;
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index]?.role === "assistant") {
          lastAssistantIndex = index;
          break;
        }
      }

      if (lastAssistantIndex === -1) {
        return previous;
      }

      const last = next[lastAssistantIndex];
      if (!last) {
        return previous;
      }

      next[lastAssistantIndex] = {
        role: "assistant",
        text: last.text + text,
        kind: "transcript",
        tone: "neutral",
      };
      return next;
    });
  };

  const applyLoadedSession = (loaded: SessionRecord) => {
    setActiveSessionId(loaded.id);
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
    ]);
    setResumePicker({
      active: false,
      sessions: [],
      selectedIndex: 0,
      pageSize: RESUME_PAGE_SIZE,
    });
  };

  const closeModelPicker = () => {
    setModelPicker({
      active: false,
      models: [],
      selectedIndex: 0,
      pageSize: MODEL_PAGE_SIZE,
    });
  };

  const updatePendingState = (
    nextPending: PendingReviewItem[],
    options?: {
      open?: boolean;
      focusLatest?: boolean;
      selectId?: string;
      selectedIndex?: number;
      previewMode?: ApprovalPreviewMode;
    }
  ) => {
    setPendingReviews(nextPending);
    setApprovalPanel(previous => {
      if (nextPending.length === 0) {
        return {
          active: false,
          selectedIndex: 0,
          previewMode: options?.previewMode ?? previous.previewMode,
          lastOpenedAt: previous.lastOpenedAt,
        };
      }

      let nextIndex = previous.selectedIndex;
      if (typeof options?.selectedIndex === "number") {
        nextIndex = options.selectedIndex;
      } else if (options?.selectId) {
        const matchedIndex = nextPending.findIndex(
          item => item.id === options.selectId
        );
        if (matchedIndex >= 0) {
          nextIndex = matchedIndex;
        }
      } else if (options?.focusLatest) {
        nextIndex = nextPending.length - 1;
      }

      const boundedIndex = Math.max(0, Math.min(nextIndex, nextPending.length - 1));
      const nextActive = options?.open ?? previous.active;

      return {
        active: nextActive,
        selectedIndex: boundedIndex,
        previewMode: options?.previewMode ?? previous.previewMode,
        lastOpenedAt: nextActive
          ? new Date().toISOString()
          : previous.lastOpenedAt,
      };
    });
  };

  const closeApprovalPanel = () => {
    setApprovalPanel(previous => ({
      ...previous,
      active: false,
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
    updatePendingState(nextPending, {
      ...options,
      open: nextPending.length > 0,
    });
  };

  const approvePendingReview = (id: string) => {
    enqueueTask(async () => {
      const before = mcpService.listPending();
      const target = before.find(item => item.id === id);
      const currentIndex = Math.max(
        0,
        before.findIndex(item => item.id === id)
      );
      const result = await mcpService.approve(id);
      const nextPending = mcpService.listPending();
      updatePendingState(nextPending, {
        open: approvalPanel.active && nextPending.length > 0,
        selectedIndex: Math.min(currentIndex, Math.max(0, nextPending.length - 1)),
      });

      if (!target) {
        pushSystemMessage(buildApprovalMessage("Approval error", undefined, [result.message]), {
          kind: "error",
          tone: "danger",
          color: "red",
        });
        return;
      }

      if (!result.ok) {
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
        return;
      }

      const output = extractMessageBody(result.message);
      pushSystemMessage(
        buildApprovalMessage("Approved", target, output ? [output] : []),
        {
          kind: "review_status",
          tone: "success",
          color: actionColor(target.request.action) ?? "green",
        }
      );
    });
  };

  const rejectPendingReview = (id: string) => {
    enqueueTask(async () => {
      const before = mcpService.listPending();
      const target = before.find(item => item.id === id);
      const currentIndex = Math.max(
        0,
        before.findIndex(item => item.id === id)
      );
      const result = mcpService.reject(id);
      const nextPending = mcpService.listPending();
      updatePendingState(nextPending, {
        open: approvalPanel.active && nextPending.length > 0,
        selectedIndex: Math.min(currentIndex, Math.max(0, nextPending.length - 1)),
      });

      if (!target || !result.ok) {
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
        return;
      }

      pushSystemMessage(buildApprovalMessage("Rejected", target), {
        kind: "review_status",
        tone: "warning",
        color: "yellow",
      });
    });
  };

  const approveCurrentPendingReview = () => {
    const target = pendingReviews[approvalPanel.selectedIndex];
    if (!target) {
      pushSystemMessage("Approval error\nNo pending operation selected.", {
        kind: "error",
        tone: "danger",
        color: "red",
      });
      return;
    }
    approvePendingReview(target.id);
  };

  const rejectCurrentPendingReview = () => {
    const target = pendingReviews[approvalPanel.selectedIndex];
    if (!target) {
      pushSystemMessage("Approval error\nNo pending operation selected.", {
        kind: "error",
        tone: "danger",
        color: "red",
      });
      return;
    }
    rejectPendingReview(target.id);
  };

  useInput((inputValue, key) => {
    if (modelPicker.active) {
      if (key.escape) {
        closeModelPicker();
        pushSystemMessage("Model picker closed.");
        return;
      }

      if (key.upArrow) {
        setModelPicker(previous => ({
          ...previous,
          selectedIndex:
            previous.selectedIndex <= 0
              ? previous.models.length - 1
              : previous.selectedIndex - 1,
        }));
        return;
      }

      if (key.downArrow) {
        setModelPicker(previous => ({
          ...previous,
          selectedIndex:
            previous.selectedIndex >= previous.models.length - 1
              ? 0
              : previous.selectedIndex + 1,
        }));
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setModelPicker(previous => {
          const total = previous.models.length;
          if (total === 0) {
            return previous;
          }
          const pageSize = previous.pageSize;
          const currentPage = Math.floor(previous.selectedIndex / pageSize);
          const maxPage = Math.floor((total - 1) / pageSize);
          const offset = previous.selectedIndex % pageSize;
          const nextPage = key.leftArrow
            ? currentPage <= 0
              ? maxPage
              : currentPage - 1
            : currentPage >= maxPage
              ? 0
              : currentPage + 1;
          const nextIndex = Math.min(nextPage * pageSize + offset, total - 1);
          return {
            ...previous,
            selectedIndex: nextIndex,
          };
        });
      }
      return;
    }

    if (resumePicker.active) {
      if (key.escape) {
        setResumePicker({
          active: false,
          sessions: [],
          selectedIndex: 0,
          pageSize: RESUME_PAGE_SIZE,
        });
        pushSystemMessage("Resume picker closed.");
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setResumePicker(previous => {
          const total = previous.sessions.length;
          if (total === 0) {
            return previous;
          }
          const pageSize = previous.pageSize;
          const currentPage = Math.floor(previous.selectedIndex / pageSize);
          const maxPage = Math.floor((total - 1) / pageSize);
          const offset = previous.selectedIndex % pageSize;
          const nextPage = key.leftArrow
            ? currentPage <= 0
              ? maxPage
              : currentPage - 1
            : currentPage >= maxPage
              ? 0
              : currentPage + 1;
          const nextIndex = Math.min(nextPage * pageSize + offset, total - 1);
          return {
            ...previous,
            selectedIndex: nextIndex,
          };
        });
      }
      return;
    }

    if (!approvalPanel.active) {
      return;
    }

    if (pendingReviews.length === 0) {
      closeApprovalPanel();
      return;
    }

    if (key.escape) {
      closeApprovalPanel();
      pushSystemMessage("Approval panel closed.", {
        kind: "system_hint",
        tone: "neutral",
        color: "gray",
      });
      return;
    }

    if (key.upArrow) {
      setApprovalPanel(previous => ({
        ...previous,
        selectedIndex:
          previous.selectedIndex <= 0
            ? pendingReviews.length - 1
            : previous.selectedIndex - 1,
      }));
      return;
    }

    if (key.downArrow) {
      setApprovalPanel(previous => ({
        ...previous,
        selectedIndex:
          previous.selectedIndex >= pendingReviews.length - 1
            ? 0
            : previous.selectedIndex + 1,
      }));
      return;
    }

    if (key.tab) {
      setApprovalPanel(previous => ({
        ...previous,
        previewMode: previous.previewMode === "summary" ? "full" : "summary",
      }));
      return;
    }

    if (inputValue.toLowerCase() === "a") {
      approveCurrentPendingReview();
      return;
    }

    if (inputValue.toLowerCase() === "r") {
      rejectCurrentPendingReview();
    }
  });

  const submit = () => {
    const query = input.trim();
    if (status === "streaming") {
      return;
    }

    if (!query && modelPicker.active) {
      enqueueTask(async () => {
        const selected = modelPicker.models[modelPicker.selectedIndex];
        if (!selected) {
          pushSystemMessage("No model selected.");
          return;
        }
        const result = await transport.setModel(selected);
        if (result.ok) {
          pushSystemMessage(result.message);
          closeModelPicker();
        } else {
          pushSystemMessage(`[model switch failed] ${result.message}`);
        }
      });
      return;
    }

    if (!query && resumePicker.active) {
      enqueueTask(async () => {
        const selected = resumePicker.sessions[resumePicker.selectedIndex];
        if (!selected) {
          pushSystemMessage("No session selected.");
          return;
        }
        const loaded = await sessionStore.loadSession(selected.id);
        if (!loaded) {
          pushSystemMessage(`Session not found: ${selected.id}`);
          return;
        }
        applyLoadedSession(loaded);
      });
      return;
    }

    if (approvalPanel.active) {
      return;
    }

    if (!query) {
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
      setInput("");
      return;
    }

    if (query === "/model") {
      enqueueTask(async () => {
        const models = await transport.listModels();
        if (models.length === 0) {
          pushSystemMessage("No models available. Try /model refresh.");
          return;
        }
        const current = transport.getModel();
        const selectedIndex = Math.max(0, models.indexOf(current));
        setModelPicker({
          active: true,
          models,
          selectedIndex,
          pageSize: MODEL_PAGE_SIZE,
        });
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
        setActiveSessionId(created.id);
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
          const lines = sessions
            .map(session => `${session.id} | ${session.updatedAt} | ${session.title}`)
            .join("\n");
          pushSystemMessage(`Sessions:\n${lines}`);
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
          openApprovalPanel(pending, {
            focusLatest: true,
            previewMode: "summary",
          });
          pushSystemMessage(
            buildApprovalMessage("Approval required", undefined, [
              `pending: ${pending.length}`,
              "panel: opened",
              "keys: ↑/↓ select  Tab preview  a approve  r reject  Esc close",
            ]),
            { kind: "review_status", tone: "warning", color: "yellow" }
          );
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

        openApprovalPanel(pending, {
          selectId: target.id,
          previewMode: "full",
        });
        pushSystemMessage(
          buildApprovalMessage("Approval required", target, [
            "panel: opened",
            "preview: full",
          ]),
          { kind: "review_status", tone: "warning", color: "yellow" }
        );
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
          setResumePicker({
            active: true,
            sessions,
            selectedIndex: 0,
            pageSize: RESUME_PAGE_SIZE,
          });
          pushSystemMessage(
            "Resume picker opened: use Left/Right to page, Enter to resume, Esc to cancel."
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

        const loaded = await sessionStore.loadSession(targetId);
        if (!loaded) {
          pushSystemMessage(`Session not found: ${targetId}`);
          setInput("");
          return;
        }

        applyLoadedSession(loaded);
        setInput("");
        return;
      }

      setItems(previous => [
        ...previous,
        { role: "user", text: query, kind: "transcript", tone: "neutral" },
        { role: "assistant", text: "", kind: "transcript", tone: "neutral" },
      ]);
      setInput("");

      const session = await ensureActiveSession(query);
      const now = new Date().toISOString();
      let persisted: SessionRecord = await sessionStore.appendMessage(session.id, {
        role: "user",
        text: query,
        createdAt: now,
      });

      const compressedForQuery = compressContext(persisted.messages);
      persisted = await sessionStore.updateSummary(
        session.id,
        compressedForQuery.summary
      );

      const prompt = buildPromptWithContext(
        query,
        systemPrompt,
        projectPrompt,
        persisted.summary,
        persisted.focus,
        compressedForQuery.recent
      );
      let assistantBuffer = "";

      await runQuerySession({
        query: prompt,
        transport,
        onState: next => {
          setSessionState(next);
          setStatus(next.status as ChatStatus);
        },
        onTextDelta: text => {
          assistantBuffer += text;
          appendToLastAssistant(text);
        },
        onToolCall: async (toolName, toolInput) => {
          const result = await mcpService.handleToolCall(toolName, toolInput);
          if (result.pending) {
            openApprovalPanel(mcpService.listPending(), {
              focusLatest: true,
              previewMode: "summary",
            });
            const reviewMode = isHighRiskReviewAction(result.pending.request.action)
              ? "block"
              : "queue";
            pushSystemMessage(
              buildApprovalMessage("Approval required", result.pending, [
                `mode: ${reviewMode}`,
                "panel: opened",
                "keys: ↑/↓ select  Tab preview  a approve  r reject  Esc close",
              ]),
              {
              kind: "review_status",
              tone: reviewMode === "block" ? "warning" : "info",
              color: reviewMode === "block" ? "red" : "yellow",
              }
            );
            return {
              message: `Approval required ${result.pending.id} | ${result.pending.request.action} | ${result.pending.request.path}`,
              reviewMode,
            };
          }
          const normalized = normalizeMcpMessage(result.message);
          const displayMessage = condenseForDisplay(normalized.text);
          pushSystemMessage(displayMessage, {
            kind: normalized.kind,
            tone: normalized.tone,
            color: normalized.color,
          });
          return { message: result.message };
        },
        onError: message => {
          pushSystemMessage(
            `Stream error: ${message}`,
            {
              kind: "error",
              tone: "danger",
              color: "red",
            }
          );
        },
      });

      if (assistantBuffer.trim()) {
        const memoryText = condenseForMemory(assistantBuffer);
        const withAssistant = await sessionStore.appendMessage(session.id, {
          role: "assistant",
          text: memoryText,
          createdAt: new Date().toISOString(),
        });
        const compressed = compressContext(withAssistant.messages);
        await sessionStore.updateSummary(session.id, compressed.summary);
        if (assistantBuffer.length > memoryText.length + 40) {
          pushSystemMessage(
            "Long assistant output was compressed in session memory. Use /pin to keep key points.",
            { kind: "system_hint", tone: "neutral", color: "gray" }
          );
        }
      }
    });
  };

  return {
    input,
    items,
    status,
    sessionState,
    resumePicker,
    modelPicker,
    pendingReviews,
    approvalPanel,
    closeApprovalPanel,
    openApprovalPanel,
    approveCurrentPendingReview,
    rejectCurrentPendingReview,
    setInput,
    submit,
  };
};
