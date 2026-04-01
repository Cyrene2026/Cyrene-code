import { useRef, useState } from "react";
import { runQuerySession } from "../../core/query/runQuerySession";
import type { QuerySessionState } from "../../core/query/sessionMachine";
import type { QueryTransport } from "../../core/query/transport";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";

type UseChatAppParams = {
  transport: QueryTransport;
};

export const useChatApp = ({ transport }: UseChatAppParams) => {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [items, setItems] = useState<ChatItem[]>([
    {
      role: "system",
      text: "Type a query and press Enter. Streaming responses appear below.",
    },
  ]);
  const [sessionState, setSessionState] = useState<QuerySessionState | null>(
    null
  );

  const queueRef = useRef(Promise.resolve());

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

    setItems(previous => [
      ...previous,
      { role: "user", text: query },
      { role: "assistant", text: "" },
    ]);
    setInput("");

    queueRef.current = queueRef.current.then(async () => {
      await runQuerySession({
        query,
        transport,
        onState: next => {
          setSessionState(next);
          setStatus(next.status as ChatStatus);
        },
        onTextDelta: appendToLastAssistant,
        onToolCall: (toolName, toolInput) => {
          const serialized =
            toolInput === undefined ? "" : ` ${JSON.stringify(toolInput)}`;
          appendToLastAssistant(`\n[tool_call] ${toolName}${serialized}\n`);
        },
        onError: message => {
          appendToLastAssistant(`\n[error] ${message}\n`);
        },
      });
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
