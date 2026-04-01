import { useRef, useState } from "react";
import { runQuerySession } from "../../core/query/runQuerySession";
import { buildPromptWithContext } from "../../core/session/buildPromptWithContext";
import { compressContext } from "../../core/session/contextCompression";
import type { SessionStore } from "../../core/session/store";
import type { QuerySessionState } from "../../core/query/sessionMachine";
import type { QueryTransport } from "../../core/query/transport";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";
import type { SessionRecord } from "../../core/session/types";

type UseChatAppParams = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
};

const defaultSystemText =
  "Type a query and press Enter. Commands: /model, /model <name>, /system, /system <text>, /system reset, /sessions, /resume <id>, /new, /pin <note>, /pins, /unpin <index>.";

const condenseForMemory = (text: string, max = 480) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  const head = normalized.slice(0, 320);
  const tail = normalized.slice(-120);
  return `${head} ... ${tail}`;
};

export const useChatApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
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

  const queueRef = useRef(Promise.resolve());

  const pushSystemMessage = (text: string) => {
    setItems(previous => [...previous, { role: "system", text }]);
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

  const submit = () => {
    const query = input.trim();
    if (!query || status === "streaming") {
      return;
    }

    if (query === "/model") {
      setItems(previous => [
        ...previous,
        { role: "system", text: `Current model: ${transport.getModel()}` },
      ]);
      setInput("");
      return;
    }

    if (query.startsWith("/model ")) {
      const nextModel = query.slice("/model ".length).trim();
      if (nextModel) {
        transport.setModel(nextModel);
        setItems(previous => [
          ...previous,
          { role: "system", text: `Model switched to: ${transport.getModel()}` },
        ]);
      } else {
        setItems(previous => [
          ...previous,
          { role: "system", text: "Usage: /model <model_name>" },
        ]);
      }
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
        pushSystemMessage("Usage: /resume <session_id>");
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

        setActiveSessionId(loaded.id);
        setItems([
          { role: "system", text: defaultSystemText },
          ...loaded.messages.map(message => ({
            role: message.role,
            text: message.text,
          })),
          { role: "system", text: `Resumed session: ${loaded.id}` },
        ]);
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
        onToolCall: (toolName, toolInput) => {
          const serialized =
            toolInput === undefined ? "" : ` ${JSON.stringify(toolInput)}`;
          const line = `\n[tool_call] ${toolName}${serialized}\n`;
          assistantBuffer += line;
          appendToLastAssistant(line);
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
    setInput,
    submit,
  };
};
