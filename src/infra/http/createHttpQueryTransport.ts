import { z } from "zod";
import type { QueryTransport } from "../../core/query/transport";
import { loadModelYaml, saveModelYaml } from "../config/modelCatalog";

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
const FILE_TOOL = {
  type: "function",
  function: {
    name: "file",
    description:
      "Operate files inside workspace. Use action+path. Write actions require review.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "read_file",
            "list_dir",
            "create_dir",
            "create_file",
            "write_file",
            "edit_file",
            "delete_file",
          ],
        },
        path: { type: "string" },
        content: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
      },
      required: ["action", "path"],
    },
  },
} as const;
const TOOL_USAGE_SYSTEM_PROMPT = [
  "When you need filesystem operations, you MUST call function `file`.",
  "Function arguments must be valid JSON and include required fields:",
  "{ action, path, content?, find?, replace? }.",
  "Never call file tool with empty arguments.",
  "Use one of actions:",
  "read_file, list_dir, create_dir, create_file, write_file, edit_file, delete_file.",
].join(" ");

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
const resolveModelsUrl = (baseUrl: string) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/models")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
};
const DONE_EVENT = JSON.stringify({ type: "done" });

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
      tool_choice: "auto",
      tools: [FILE_TOOL],
      messages: [
        { role: "system", content: TOOL_USAGE_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Stream error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolState = new Map<number, { name?: string; args: string; emitted: boolean }>();

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
        if (line === "[DONE]") {
          yield DONE_EVENT;
          return;
        }

        try {
          const parsed = JSON.parse(line) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          if (delta?.content) {
            yield JSON.stringify({ type: "text_delta", text: delta.content });
          }

          if (delta?.tool_calls) {
            for (const call of delta.tool_calls) {
              const index = typeof call.index === "number" ? call.index : 0;
              const current = toolState.get(index) ?? {
                args: "",
                emitted: false,
              };
              if (call.function?.name) {
                current.name = call.function.name;
              }
              if (call.function?.arguments) {
                current.args += call.function.arguments;
              }
              toolState.set(index, current);

              if (current.name && !current.emitted) {
                try {
                  const parsedArgs = current.args ? JSON.parse(current.args) : {};
                  if (
                    parsedArgs &&
                    typeof parsedArgs === "object" &&
                    Object.keys(parsedArgs as Record<string, unknown>).length === 0
                  ) {
                    // Skip empty argument payloads. Wait for fuller chunks or finalization.
                    continue;
                  }
                  yield JSON.stringify({
                    type: "tool_call",
                    toolName: current.name,
                    input: parsedArgs,
                  });
                  current.emitted = true;
                  toolState.set(index, current);
                } catch {
                  // Wait for more argument chunks.
                }
              }
            }
          }

          if (choice?.finish_reason === "tool_calls") {
            for (const [, current] of toolState) {
              if (!current.name || current.emitted) {
                continue;
              }
              let parsedArgs: unknown = {};
              try {
                parsedArgs = current.args ? JSON.parse(current.args) : {};
              } catch {
                parsedArgs = { raw: current.args };
              }
              if (
                parsedArgs &&
                typeof parsedArgs === "object" &&
                Object.keys(parsedArgs as Record<string, unknown>).length === 0
              ) {
                continue;
              }
              yield JSON.stringify({
                type: "tool_call",
                toolName: current.name,
                input: parsedArgs,
              });
              current.emitted = true;
            }
          }

          if (choice?.finish_reason === "stop") {
            yield DONE_EVENT;
            return;
          }
        } catch {
          // ignore malformed SSE data line
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const dataLines = parseSseEventData(buffer);
    for (const line of dataLines) {
      if (line === "[DONE]") {
        yield DONE_EVENT;
        return;
      }
    }
  }

  yield DONE_EVENT;
}

const parseModelsPayload = (payload: unknown): string[] => {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !Array.isArray((payload as { data: unknown[] }).data)
  ) {
    return [];
  }

  const models: string[] = [];
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== "object" || !("id" in item)) {
      continue;
    }
    const id = (item as { id: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      models.push(id.trim());
    }
  }

  return Array.from(new Set(models));
};

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
  let availableModels: string[] = [];
  let initializationError: string | null = null;
  const sessionQueries = new Map<string, string>();

  const refreshFromApi = async () => {
    if (!baseUrl || !apiKey) {
      throw new Error("Missing CYRENE_BASE_URL or CYRENE_API_KEY.");
    }
    const response = await fetch(resolveModelsUrl(baseUrl), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Model fetch failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as unknown;
    const models = parseModelsPayload(payload);
    if (models.length === 0) {
      throw new Error("Model fetch returned empty list.");
    }

    const firstModel = models[0] ?? currentModel;
    const defaultModel = models.includes(currentModel) ? currentModel : firstModel;
    await saveModelYaml(models, defaultModel);
    availableModels = models;
    currentModel = defaultModel;
    initializationError = null;

    return models;
  };

  const initializeModels = async () => {
    try {
      const local = await loadModelYaml();
      availableModels = local.models;
      currentModel =
        (local.defaultModel && local.models.includes(local.defaultModel)
          ? local.defaultModel
          : undefined) ??
        (local.models.includes(currentModel)
          ? currentModel
          : (local.models[0] ?? currentModel));
      initializationError = null;
      return;
    } catch {
      // Fall through to remote fetch.
    }

    try {
      await refreshFromApi();
    } catch (error) {
      initializationError =
        error instanceof Error ? error.message : String(error);
    }
  };

  const modelInit = initializeModels();

  return {
    getModel: () => currentModel,
    setModel: async (model: string) => {
      await modelInit;
      const next = model.trim();
      if (!next) {
        return {
          ok: false,
          message: "Model name cannot be empty.",
        };
      }
      if (availableModels.length === 0) {
        return {
          ok: false,
          message:
            initializationError ??
            "No available models. Run /model refresh to load catalog.",
        };
      }
      if (!availableModels.includes(next)) {
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
    listModels: async () => {
      await modelInit;
      return [...availableModels];
    },
    refreshModels: async () => {
      try {
        const models = await refreshFromApi();
        return {
          ok: true,
          message: `Model list refreshed: ${models.length} models`,
          models,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message,
        };
      }
    },
    requestStreamUrl: async (query: string) => {
      await modelInit;
      if (!baseUrl || !apiKey) {
        throw new Error(
          "Missing CYRENE_BASE_URL or CYRENE_API_KEY for HTTP transport."
        );
      }
      if (initializationError && availableModels.length === 0) {
        throw new Error(
          `Model initialization failed: ${initializationError}. Run /model refresh after fixing API/base URL.`
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
