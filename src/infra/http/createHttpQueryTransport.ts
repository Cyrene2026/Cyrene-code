import { z } from "zod";
import type { QueryTransport } from "../../core/query/transport";
import type { TokenUsage } from "../../core/query/tokenUsage";
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

const usagePayloadSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

const extractUsage = (payload: unknown): TokenUsage | null => {
  if (!payload || typeof payload !== "object" || !("usage" in payload)) {
    return null;
  }

  const parsedUsage = usagePayloadSchema.safeParse(
    (payload as { usage?: unknown }).usage
  );
  if (!parsedUsage.success) {
    return null;
  }

  return {
    promptTokens: parsedUsage.data.prompt_tokens,
    completionTokens: parsedUsage.data.completion_tokens,
    totalTokens: parsedUsage.data.total_tokens,
  };
};

const extractUsageEvent = (payload: unknown) => {
  const usage = extractUsage(payload);
  if (!usage) {
    return null;
  }

  return JSON.stringify({
    type: "usage",
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  });
};

export const FILE_TOOL = {
  type: "function",
  function: {
    name: "file",
    description:
      "Operate files and shell actions inside workspace. Use action-based JSON. Write, move, copy, and command actions require review.",
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
            "stat_path",
            "find_files",
            "search_text",
            "copy_path",
            "move_path",
            "run_command",
            "run_shell",
          ],
        },
        path: {
          type: "string",
          description:
            "Workspace-relative path. For find_files or search_text across the whole workspace, use '.'.",
        },
        content: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        pattern: {
          type: "string",
          description: "Glob pattern for find_files. Omit when unused.",
        },
        query: {
          type: "string",
          description: "Search string for search_text. Omit when unused.",
        },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
        caseSensitive: { type: "boolean" },
        destination: { type: "string" },
        command: { type: "string" },
        args: {
          type: "array",
          description:
            "Program arguments for run_command only. Omit args for all other actions.",
          items: { type: "string" },
        },
        cwd: { type: "string" },
      },
      required: ["action", "path"],
    },
  },
} as const;
export const TOOL_USAGE_SYSTEM_PROMPT = [
  "You are operating inside a workspace through exactly one function: `file`.",
  "Whenever you need filesystem or shell work, you MUST call `file` instead of describing the action abstractly.",
  "Function arguments must be valid JSON and include required fields:",
  "{ action, path, content?, find?, replace?, pattern?, query?, maxResults?, caseSensitive?, destination?, command?, args?, cwd? }.",
  "Never call the file tool with empty arguments, placeholder values, or guessed fields you do not need.",
  "Available actions are:",
  "read_file, list_dir, create_dir, create_file, write_file, edit_file, delete_file, stat_path, find_files, search_text, copy_path, move_path, run_command, run_shell.",
  "Choose the narrowest action that answers the question. Prefer precise search or metadata actions over broad exploratory reads.",
  "Tool selection rules:",
  "- Use stat_path to confirm whether a path exists and whether it is a file or directory.",
  "- Use find_files for file discovery by name or glob pattern.",
  "- Use search_text for content discovery inside files.",
  "- For find_files or search_text across the whole workspace, set `path` to `\".\"`.",
  "- Omit every optional field you do not need. Do not send empty strings, empty arrays, or placeholder values.",
  "- Use read_file only when you actually need the file contents.",
  "- Use list_dir only when the directory listing itself is required.",
  "- Use create_file only for new-only file creation.",
  "- Use write_file for full overwrite writes.",
  "- Use edit_file for targeted replacement.",
  "- Use copy_path or move_path for path relocation instead of trying to emulate them with read/write/delete steps.",
  "- Use run_command only for direct program execution such as `node --version`.",
  "- `args` is only for run_command. Do not put search terms for find_files or search_text into args.",
  "- Use run_shell only when true shell semantics are required. For shell actions, set path to a relevant workspace path such as '.'.",
  "- Do not put shell syntax such as pipes, redirection, chaining, or subshells into run_command.",
  "- run_shell currently supports only a safe single-command subset. Do not use pipes, redirection, chaining, background execution, or subshell syntax.",
  "Avoid repetitive list_dir/read_file probing when search_text or find_files can answer directly.",
  "Directory-state rules:",
  "- If list_dir already returned a confirmed directory state for the same path, treat that result as authoritative until a mutation happens.",
  "- Do not call list_dir again just to re-check the same path.",
  "- After list_dir confirms that a target directory exists, is empty, or contains the needed files, immediately move to the next concrete action.",
  "- If the user asked to create files and you already confirmed the target directory, start creating files instead of listing again.",
  "Read-file rules:",
  "- If read_file returns `(empty file)`, treat that as a confirmed result rather than retrying the same read.",
  "- Do not repeat read_file for the same path unless a write or edit actually changed that file.",
  "Anti-loop rules:",
  "- Do not repeat the same tool call with the same input unless task state materially changed.",
  "- Do not alternate between list_dir and read_file without learning anything new.",
  "- If a previous tool result already answered your question, reuse it and continue.",
  "Planning rules:",
  "- Before each tool call, decide what new fact you need.",
  "- After each tool result, choose the next concrete step toward finishing the original task.",
  "- Stop exploring once you have enough information to act.",
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
const resolveProviderBaseUrl = (baseUrl: string | undefined) =>
  baseUrl ? normalizeBaseUrl(baseUrl) : undefined;
const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map(item => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const typedItem = item as {
        type?: unknown;
        text?: unknown;
      };
      if (typedItem.type === "text" && typeof typedItem.text === "string") {
        return typedItem.text;
      }
      return "";
    })
    .join("");
};

const parseCompletionTextPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== "object" || !("choices" in payload)) {
    return "";
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object" || !("message" in firstChoice)) {
    return "";
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object" || !("content" in message)) {
    return "";
  }

  return extractTextContent((message as { content?: unknown }).content).trim();
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
      stream_options: {
        include_usage: true,
      },
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
            usage?: unknown;
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
          const usageEvent = extractUsageEvent(parsed);
          if (usageEvent) {
            yield usageEvent;
          }
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

const completeTextOpenAI = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string
) => {
  const response = await fetch(resolveChatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    return {
      ok: false as const,
      message: `Summary request failed: ${response.status} ${response.statusText}`,
    };
  }

  const payload = (await response.json()) as unknown;
  const text = parseCompletionTextPayload(payload);
  if (!text) {
    return {
      ok: false as const,
      message: "Summary response was empty.",
    };
  }

  return {
    ok: true as const,
    text,
    usage: extractUsage(payload) ?? undefined,
  };
};

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
  const providerBaseUrl = resolveProviderBaseUrl(baseUrl);

  const refreshFromApi = async (preferredModel?: string) => {
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
    const selectedModel =
      (preferredModel && models.includes(preferredModel)
        ? preferredModel
        : undefined) ??
      (models.includes(currentModel) ? currentModel : undefined) ??
      firstModel;
    await saveModelYaml(models, selectedModel, {
      lastUsedModel: selectedModel,
      providerBaseUrl,
    });
    availableModels = models;
    currentModel = selectedModel;
    initializationError = null;

    return models;
  };

  const initializeModels = async () => {
    try {
      const local = await loadModelYaml();
      const providerChanged =
        Boolean(providerBaseUrl) &&
        Boolean(local.providerBaseUrl) &&
        local.providerBaseUrl !== providerBaseUrl;
      if (providerChanged) {
        await refreshFromApi(local.lastUsedModel ?? local.defaultModel ?? currentModel);
        return;
      }
      availableModels = local.models;
      currentModel =
        (local.lastUsedModel && local.models.includes(local.lastUsedModel)
          ? local.lastUsedModel
          : undefined) ??
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
      const previousModel = currentModel;
      currentModel = next;
      try {
        await saveModelYaml(availableModels, next, {
          lastUsedModel: next,
          providerBaseUrl,
        });
      } catch (error) {
        currentModel = previousModel;
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : String(error),
        };
      }
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
    summarizeText: async (prompt: string) => {
      await modelInit;
      if (!baseUrl || !apiKey) {
        return {
          ok: false,
          message: "Missing CYRENE_BASE_URL or CYRENE_API_KEY for HTTP transport.",
        };
      }
      if (initializationError && availableModels.length === 0) {
        return {
          ok: false,
          message: `Model initialization failed: ${initializationError}. Run /model refresh after fixing API/base URL.`,
        };
      }
      const normalizedPrompt = prompt.trim();
      if (!normalizedPrompt) {
        return {
          ok: false,
          message: "Summary prompt cannot be empty.",
        };
      }
      return completeTextOpenAI(baseUrl, apiKey, currentModel, normalizedPrompt);
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
