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
import type { FileAction } from "../../core/tools/mcp/types";

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
  "/review",
  "/approve [id]",
  "/reject [id]",
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
    action === "create_file" ||
    action === "write_file" ||
    action === "edit_file"
  ) {
    return "green";
  }
  return undefined;
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

  const queueRef = useRef(Promise.resolve());

  const pushSystemMessage = (text: string, color?: ChatItem["color"]) => {
    setItems(previous => [...previous, { role: "system", text, color }]);
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
      const lastIndex = next.length - 1;
      const last = next[lastIndex];

      if (!last || last.role !== "assistant") {
        return previous;
      }

      next[lastIndex] = { role: "assistant", text: last.text + text };
      return next;
    });
  };

  const applyLoadedSession = (loaded: SessionRecord) => {
    setActiveSessionId(loaded.id);
    setItems([
      { role: "system", text: defaultSystemText },
      ...loaded.messages.map(message => ({
        role: message.role,
        text: message.text,
      })),
      { role: "system", text: `Resumed session: ${loaded.id}` },
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

  useInput((_, key) => {
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

    if (!resumePicker.active) {
      return;
    }

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
  });

  const submit = () => {
    const query = input.trim();
    if (status === "streaming") {
      return;
    }

    if (!query && modelPicker.active) {
      queueRef.current = queueRef.current.then(async () => {
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
      queueRef.current = queueRef.current.then(async () => {
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

    if (!query) {
      return;
    }

    if (query === "/help") {
      setItems(previous => [...previous, { role: "system", text: HELP_TEXT }]);
      setInput("");
      return;
    }

    if (query === "/model") {
      queueRef.current = queueRef.current.then(async () => {
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
      queueRef.current = queueRef.current.then(async () => {
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
      queueRef.current = queueRef.current.then(async () => {
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

    queueRef.current = queueRef.current.then(async () => {
      if (query === "/new") {
        const created = await sessionStore.createSession();
        setActiveSessionId(created.id);
        setItems([
          { role: "system", text: defaultSystemText },
          {
            role: "system",
            text: `Started new session: ${created.id}`,
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
          pushSystemMessage("No pending reviewed operations.");
        } else {
          const lines = pending
            .map(item => `${item.id} | ${item.createdAt}\n${item.previewFull}`)
            .join("\n");
          pushSystemMessage(`Pending operations:\n${lines}`);
        }
        setInput("");
        return;
      }

      if (query === "/approve") {
        const pending = mcpService.listPending();
        if (pending.length === 0) {
          pushSystemMessage("No pending operations to approve.");
          setInput("");
          return;
        }
        if (pending.length > 1) {
          pushSystemMessage(
            `Multiple pending operations. Use /approve <id>.\n${pending
              .map(item => `${item.id} | ${item.previewSummary}`)
              .join("\n")}`
          );
          setInput("");
          return;
        }
        const only = pending[0];
        if (!only) {
          pushSystemMessage("No pending operations to approve.");
          setInput("");
          return;
        }
        const result = await mcpService.approve(only.id);
        pushSystemMessage(result.message, actionColor(only.request.action));
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
        const pending = mcpService.listPending().find(item => item.id === id);
        const result = await mcpService.approve(id);
        pushSystemMessage(result.message, actionColor(pending?.request.action));
        setInput("");
        return;
      }

      if (query === "/reject") {
        const pending = mcpService.listPending();
        if (pending.length === 0) {
          pushSystemMessage("No pending operations to reject.");
          setInput("");
          return;
        }
        if (pending.length > 1) {
          pushSystemMessage(
            `Multiple pending operations. Use /reject <id>.\n${pending
              .map(item => `${item.id} | ${item.previewSummary}`)
              .join("\n")}`
          );
          setInput("");
          return;
        }
        const only = pending[0];
        if (!only) {
          pushSystemMessage("No pending operations to reject.");
          setInput("");
          return;
        }
        const result = mcpService.reject(only.id);
        pushSystemMessage(result.message, "yellow");
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
        const result = mcpService.reject(id);
        pushSystemMessage(result.message, "yellow");
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
        { role: "user", text: query },
        { role: "assistant", text: "" },
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
          const color = actionColor(result.pending?.request.action);
          if (result.pending) {
            const shortReviewMessage = [
              `[review required] ${result.pending.id}`,
              `action=${result.pending.request.action} | path=${result.pending.request.path}`,
              "Full preview is available in /review. Use /approve <id> or /reject <id>.",
            ].join("\n");
            const line = `\n${shortReviewMessage}\n`;
            assistantBuffer += line;
            appendToLastAssistant(line);
            pushSystemMessage(
              `[review required] ${result.pending.id}\n${result.pending.previewSummary}`,
              color
            );
            return { message: shortReviewMessage, halt: true };
          }
          const displayMessage = condenseForDisplay(result.message);
          const line = `\n${displayMessage}\n`;
          assistantBuffer += line;
          appendToLastAssistant(line);
          return { message: displayMessage };
        },
        onError: message => {
          appendToLastAssistant(`\n[error] ${message}\n`);
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
            "Long assistant output was compressed in session memory. Use /pin to keep human-selected key points."
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
    setInput,
    submit,
  };
};
