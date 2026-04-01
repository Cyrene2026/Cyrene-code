import { z } from "zod";
import type { QueryTransport } from "../../core/query/transport";

const envSchema = z.object({
  CYRENE_BASE_URL: z.string().url().optional(),
  CYRENE_API_KEY: z.string().min(1).optional(),
  CYRENE_MODEL: z.string().min(1).optional(),
});

const parseSseEventData = (rawEvent: string): string[] => {
  const lines = rawEvent.split("\n");
  return lines
    .filter(line => line.startsWith("data:"))
    .map(line => line.replace(/^data:\s?/, ""));
};

const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, "");
const resolveChatCompletionsUrl = (baseUrl: string) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};
const DONE_EVENT = JSON.stringify({ type: "done" });

const normalizeOpenAIEvent = (data: string): string[] => {
  if (data === "[DONE]") {
    return [DONE_EVENT];
  }

  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };

    const choice = parsed.choices?.[0];
    if (!choice?.delta) {
      return [];
    }

    const events: string[] = [];

    if (choice.delta.content) {
      events.push(
        JSON.stringify({ type: "text_delta", text: choice.delta.content })
      );
    }

    if (choice.delta.tool_calls) {
      for (const call of choice.delta.tool_calls) {
        if (!call.function?.name && !call.function?.arguments) {
          continue;
        }
        events.push(
          JSON.stringify({
            type: "tool_call",
            toolName: call.function?.name ?? "unknown_tool",
            input: {
              argumentsChunk: call.function?.arguments ?? "",
            },
          })
        );
      }
    }

    return events;
  } catch {
    return [];
  }
};

async function* streamSseOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string
): AsyncGenerator<string> {
  const response = await fetch(resolveChatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: query }],
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Stream error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const dataLines = parseSseEventData(rawEvent);
      for (const line of dataLines) {
        const events = normalizeOpenAIEvent(line);
        for (const event of events) {
          if (event === DONE_EVENT) {
            yield event;
            return;
          }
          yield event;
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const dataLines = parseSseEventData(buffer);
    for (const line of dataLines) {
      const events = normalizeOpenAIEvent(line);
      for (const event of events) {
        yield event;
      }
    }
  }

  yield JSON.stringify({ type: "done" });
}

export const createHttpQueryTransport = (): QueryTransport => {
  const env = envSchema.safeParse({
    CYRENE_BASE_URL: process.env.CYRENE_BASE_URL,
    CYRENE_API_KEY: process.env.CYRENE_API_KEY,
    CYRENE_MODEL: process.env.CYRENE_MODEL,
  });

  const baseUrl = env.success ? env.data.CYRENE_BASE_URL : undefined;
  const apiKey = env.success ? env.data.CYRENE_API_KEY : undefined;
  let currentModel = env.success
    ? env.data.CYRENE_MODEL ?? "gpt-4o-mini"
    : "gpt-4o-mini";
  const sessionQueries = new Map<string, string>();

  return {
    getModel: () => currentModel,
    setModel: (model: string) => {
      const next = model.trim();
      if (next) {
        currentModel = next;
      }
    },
    requestStreamUrl: async (query: string) => {
      if (!baseUrl || !apiKey) {
        throw new Error(
          "Missing CYRENE_BASE_URL or CYRENE_API_KEY for HTTP transport."
        );
      }
      const sessionId = crypto.randomUUID();
      sessionQueries.set(sessionId, query);
      return `openai://${sessionId}`;
    },
    stream: async function* (streamUrl: string) {
      const sessionId = streamUrl.replace("openai://", "");
      const query = sessionQueries.get(sessionId);
      sessionQueries.delete(sessionId);

      if (!query || !baseUrl || !apiKey) {
        throw new Error("Invalid HTTP stream session.");
      }

      for await (const event of streamSseOpenAI(
        baseUrl,
        apiKey,
        currentModel,
        query
      )) {
        yield event;
      }
    },
  };
};
