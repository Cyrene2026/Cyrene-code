import type { QueryTransport } from "../../core/query/transport";

const buildAssistantReply = (query: string) => {
  const normalized = query.trim().toLowerCase();

  if (normalized.includes("time") || normalized.includes("时间")) {
    const now = new Date().toISOString();
    return {
      toolCall: {
        toolName: "time_now",
        input: { timezone: "Asia/Shanghai" },
      },
      text: `Current time (ISO): ${now}`,
    };
  }

  if (normalized.includes("help") || normalized.includes("/help")) {
    return {
      text: "Local core is running. Try asking: What time is it?",
    };
  }

  return {
    text: `Local core received: ${query}`,
  };
};

export const createLocalCoreTransport = (): QueryTransport => {
  const sessionQueries = new Map<string, string>();
  let currentModel = "local-core";

  return {
    getModel: () => currentModel,
    setModel: async (model: string) => {
      const next = model.trim();
      if (!next) {
        return {
          ok: false,
          message: "Model name cannot be empty.",
        };
      }
      if (next !== "local-core") {
        return {
          ok: false,
          message: `Model "${next}" is not in model catalog.`,
        };
      }
      currentModel = next;
      return {
        ok: true,
        message: `Model switched to: ${currentModel}`,
      };
    },
    listModels: async () => ["local-core"],
    refreshModels: async () => ({
      ok: true,
      message: "Local transport uses static model; nothing to refresh.",
      models: [currentModel],
    }),
    summarizeText: async () => ({
      ok: false,
      message: "Local transport does not support AI summaries.",
    }),
    requestStreamUrl: async (query: string) => {
      const id = crypto.randomUUID();
      sessionQueries.set(id, query);
      return `local://${id}`;
    },
    stream: async function* (streamUrl: string) {
      const id = streamUrl.replace("local://", "");
      const query = sessionQueries.get(id);
      sessionQueries.delete(id);

      if (!query) {
        throw new Error("Unknown local stream session");
      }

      const reply = buildAssistantReply(query);

      yield JSON.stringify({
        type: "text_delta",
        text: `Thinking with ${currentModel}...\n`,
      });

      if (reply.toolCall) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: reply.toolCall.toolName,
          input: reply.toolCall.input,
        });
      }

      yield JSON.stringify({
        type: "text_delta",
        text: `${reply.text}\n`,
      });

      yield JSON.stringify({ type: "done" });
    },
  };
};
