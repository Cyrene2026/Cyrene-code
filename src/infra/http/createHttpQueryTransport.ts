import { z } from "zod";
import type { QueryTransport } from "../../core/query/transport";
import type { TokenUsage } from "../../core/query/tokenUsage";
import { loadModelYaml, saveModelYaml } from "../config/modelCatalog";
import { resolveAmbientAppRoot } from "../config/appRoot";

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
            "read_files",
            "read_range",
            "read_json",
            "read_yaml",
            "list_dir",
            "create_dir",
            "create_file",
            "write_file",
            "edit_file",
            "apply_patch",
            "delete_file",
            "stat_path",
            "stat_paths",
            "outline_file",
            "find_files",
            "find_symbol",
            "find_references",
            "search_text",
            "search_text_context",
            "copy_path",
            "move_path",
            "git_status",
            "git_diff",
            "git_log",
            "git_show",
            "git_blame",
            "run_command",
            "run_shell",
            "open_shell",
            "write_shell",
            "read_shell",
            "shell_status",
            "interrupt_shell",
            "close_shell",
          ],
        },
        path: {
          type: "string",
          description:
            "Workspace-relative path. For find_files or search_text across the whole workspace, use '.'.",
        },
        content: { type: "string" },
        paths: {
          type: "array",
          description:
            "Additional workspace-relative paths for read_files or stat_paths. Put the first target in path and the rest in paths.",
          items: { type: "string" },
        },
        startLine: {
          type: "integer",
          description: "1-based inclusive start line for read_range or git_blame.",
          minimum: 1,
        },
        endLine: {
          type: "integer",
          description: "1-based inclusive end line for read_range or git_blame.",
          minimum: 1,
        },
        jsonPath: {
          type: "string",
          description: "Optional dot path for read_json, such as scripts.test or compilerOptions.paths.",
        },
        yamlPath: {
          type: "string",
          description: "Optional dot path for read_yaml, such as services.api.image or deployments.0.name.",
        },
        find: { type: "string" },
        replace: { type: "string" },
        pattern: {
          type: "string",
          description: "Glob pattern for find_files. Omit when unused.",
        },
        symbol: {
          type: "string",
          description: "Symbol name for find_symbol or find_references, such as useChatApp or FileMcpService.",
        },
        query: {
          type: "string",
          description: "Search string for search_text or search_text_context. Omit when unused.",
        },
        before: {
          type: "integer",
          description: "Context lines before each hit for search_text_context.",
          minimum: 0,
        },
        after: {
          type: "integer",
          description: "Context lines after each hit for search_text_context.",
          minimum: 0,
        },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
        caseSensitive: { type: "boolean" },
        destination: { type: "string" },
        revision: {
          type: "string",
          description: "Commit-ish for git_show, such as HEAD~1 or a commit hash.",
        },
        command: { type: "string" },
        input: {
          type: "string",
          description:
            "Shell input for write_shell. Prefer one command, but safe reviewed multiline paste blocks are also allowed there. Omit when unused.",
        },
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
  "{ action, path, content?, paths?, startLine?, endLine?, jsonPath?, yamlPath?, find?, replace?, pattern?, symbol?, query?, before?, after?, maxResults?, caseSensitive?, destination?, revision?, command?, input?, args?, cwd? }.",
  "Never call the file tool with empty arguments, placeholder values, or guessed fields you do not need.",
  "Available actions are:",
  "read_file, read_files, read_range, read_json, read_yaml, list_dir, create_dir, create_file, write_file, edit_file, apply_patch, delete_file, stat_path, stat_paths, outline_file, find_files, find_symbol, find_references, search_text, search_text_context, copy_path, move_path, git_status, git_diff, git_log, git_show, git_blame, run_command, run_shell, open_shell, write_shell, read_shell, shell_status, interrupt_shell, close_shell.",
  "Choose the narrowest action that answers the question. Prefer precise search or metadata actions over broad exploratory reads.",
  "Tool selection rules:",
  "- Use read_files when you already know multiple exact file paths and need to inspect them together.",
  "- Use read_range when you need a specific line window from one file instead of reading the whole file.",
  "- Use read_json for JSON configuration files when you want parsed structured output instead of raw text.",
  "- Use read_yaml for YAML configuration files when you want parsed structured output instead of raw text.",
  "- Use stat_path to confirm whether a path exists and whether it is a file or directory.",
  "- Use stat_paths when you need existence or metadata for several exact paths in one call.",
  "- Use outline_file before full reads on large source files to find the important symbols first.",
  "- Use find_files for file discovery by name or glob pattern.",
  "- Use find_symbol when you need to locate symbol definitions such as classes, functions, interfaces, types, or defs.",
  "- Use find_references when you need cross-file symbol usages rather than definitions.",
  "- Use search_text for content discovery inside files.",
  "- Use search_text_context when surrounding lines around each match matter.",
  "- Use git_status to inspect the repository worktree without going through a reviewed shell command.",
  "- Use git_diff to inspect unstaged and staged diff output for the repo or a path inside it.",
  "- Use git_log to inspect recent commits for the repo or a scoped path.",
  "- Use git_show to inspect one revision in detail. Provide `revision` explicitly.",
  "- Use git_blame to inspect who last changed specific lines in a tracked file.",
  "- For find_files or search_text across the whole workspace, set `path` to `\".\"`.",
  "- For search_text_context across the whole workspace, also set `path` to `\".\"`.",
  "- Omit every optional field you do not need. Do not send empty strings, empty arrays, or placeholder values.",
  "- Use read_file only when you actually need the file contents.",
  "- For read_files, set `path` to the first file and `paths` to any additional files.",
  "- For stat_paths, set `path` to the first target and `paths` to any additional targets.",
  "- For read_range, provide 1-based inclusive `startLine` and `endLine`.",
  "- For read_json, provide `jsonPath` only when you want one nested field instead of the whole document.",
  "- For read_yaml, provide `yamlPath` only when you want one nested field instead of the whole document.",
  "- For find_symbol, provide the exact symbol name in `symbol`.",
  "- For find_references, provide the exact symbol name in `symbol`.",
  "- For search_text_context, use `before` and `after` only when you need surrounding context lines.",
  "- For git_log, use `maxResults` to limit how many commits you need.",
  "- For git_show, use `revision` and an optional scoped `path`.",
  "- For git_blame, provide a file path and optional `startLine` / `endLine` for a narrow range.",
  "- Use list_dir only when the directory listing itself is required.",
  "- Use create_file only for new-only file creation.",
  "- Use write_file for full overwrite writes.",
  "- Use edit_file for targeted replacement.",
  "- Use apply_patch for reviewed targeted patches on one file using `find` and `replace`.",
  "- Use copy_path or move_path for path relocation instead of trying to emulate them with read/write/delete steps.",
  "- Use run_command only for direct program execution such as `node --version`.",
  "- `args` is only for run_command. Do not put search terms for find_files or search_text into args.",
  "- Use run_shell only when true shell semantics are required. For shell actions, set path to a relevant workspace path such as '.'.",
  "- Use open_shell and write_shell when shell state must persist across steps, such as `source .venv/bin/activate`, `. .venv/bin/activate`, `.\\\\.venv\\\\Scripts\\\\Activate.ps1`, or `cd subdir`.",
  "- open_shell opens a persistent shell directly after local validation succeeds. It does not go through the approval panel.",
  "- When a persistent shell may already exist, call shell_status before opening another one.",
  "- Use write_shell only after open_shell has created an active shell session.",
  "- Low-risk write_shell inputs such as workspace-local `cd`, venv activation, allowlisted read-only probes, `python --version`, `pip list`, or `git status` may execute immediately.",
  "- Medium-risk write_shell inputs still require review, and high-risk write_shell inputs are blocked.",
  "- Use read_shell to fetch unread output from a running or recently completed persistent shell command.",
  "- Use interrupt_shell to send Ctrl+C to the active persistent shell when a command is still running.",
  "- Use close_shell to terminate the active persistent shell session when it is no longer needed.",
  "- Do not put shell syntax such as pipes, redirection, chaining, or subshells into run_command.",
  "- run_shell currently supports only a safe single-command subset. Do not use pipes, redirection, chaining, background execution, or subshell syntax.",
  "- run_shell does not accept multiline shell input. If the user pasted multiple shell lines, use open_shell plus write_shell instead.",
  "- write_shell supports a safe reviewed subset. Multiline paste blocks are allowed there, but pipes, redirection, chaining, subshells, and background execution are still forbidden.",
  "Avoid repetitive list_dir/read_file probing when search_text or find_files can answer directly.",
  "Directory-state rules:",
  "- If list_dir already returned a confirmed directory state for the same path, treat that result as authoritative until a mutation happens.",
  "- Do not call list_dir again just to re-check the same path.",
  "- After list_dir confirms that a target directory exists, is empty, or contains the needed files, immediately move to the next concrete action.",
  "- If the user asked to create files and you already confirmed the target directory, start creating files instead of listing again.",
  "Read-file rules:",
  "- If read_file returns `(empty file)`, treat that as a confirmed result rather than retrying the same read.",
  "- Do not repeat read_file for the same path unless a write or edit actually changed that file.",
  "- After successful create_file, write_file, edit_file, or apply_patch, treat that result as a confirmed mutation. Do not immediately call read_file on the same path just to confirm the write unless the user explicitly asked to inspect or verify it.",
  "Anti-loop rules:",
  "- Do not repeat the same tool call with the same input unless task state materially changed.",
  "- Do not alternate between list_dir and read_file without learning anything new.",
  "- If a previous tool result already answered your question, reuse it and continue.",
  "Response-language rules:",
  "- Match the user's language for all progress and final responses (for Chinese users, keep Chinese).",
  "- Do not mix languages in the same response unless the user explicitly asks for bilingual output.",
  "Progress narration rules:",
  "- Keep pre-tool narration concise (one short sentence max) or skip it when the next tool action is obvious.",
  "- Avoid repetitive phrases that restate the same plan across consecutive turns.",
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
const joinVisibleParts = (parts: string[]) => parts.filter(Boolean).join("");

const extractTextValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    value?: unknown;
    text?: unknown;
  };
  if (typeof record.value === "string") {
    return record.value;
  }
  if (typeof record.text === "string") {
    return record.text;
  }

  return "";
};

const extractReasoningText = (value: unknown, depth = 0): string => {
  if (depth > 4) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return joinVisibleParts(
      value.map(item => extractReasoningText(item, depth + 1))
    );
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    type?: unknown;
    text?: unknown;
    value?: unknown;
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
    summary?: unknown;
  };
  const type = typeof record.type === "string" ? record.type : undefined;

  if (
    type === "text" ||
    type === "output_text" ||
    type === "input_text" ||
    type === "reasoning" ||
    type === "reasoning_text" ||
    type === "thinking" ||
    type === "summary_text"
  ) {
    return joinVisibleParts([
      extractTextValue(record.text),
      extractTextValue(record.value),
      extractReasoningText(record.content, depth + 1),
    ]);
  }

  return joinVisibleParts([
    extractTextValue(record.text),
    extractTextValue(record.value),
    extractReasoningText(record.content, depth + 1),
    extractReasoningText(record.reasoning, depth + 1),
    extractReasoningText(record.reasoning_content, depth + 1),
    extractReasoningText(record.thinking, depth + 1),
    extractReasoningText(record.summary, depth + 1),
  ]);
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const typedContent = content as {
      type?: unknown;
      text?: unknown;
    };
    if (
      typedContent.type === "text" ||
      typedContent.type === "output_text" ||
      typedContent.type === "input_text"
    ) {
      return extractTextValue(typedContent.text);
    }
    return "";
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return joinVisibleParts(
    content.map(item => {
      if (typeof item === "string") {
        return item;
      }
      if (!item || typeof item !== "object") {
        return "";
      }
      const typedItem = item as {
        type?: unknown;
        text?: unknown;
      };
      if (
        typedItem.type === "text" ||
        typedItem.type === "output_text" ||
        typedItem.type === "input_text"
      ) {
        return extractTextValue(typedItem.text);
      }
      return "";
    })
  );
};

const extractVisibleDeltaText = (delta: unknown) => {
  if (!delta || typeof delta !== "object") {
    return "";
  }

  const typedDelta = delta as {
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
  };

  return joinVisibleParts([
    extractTextContent(typedDelta.content),
    extractReasoningText(typedDelta.reasoning_content),
    extractReasoningText(typedDelta.reasoning),
    extractReasoningText(typedDelta.thinking),
  ]);
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
                content?: unknown;
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
          const deltaText = extractVisibleDeltaText(delta);

          if (deltaText) {
            yield JSON.stringify({ type: "text_delta", text: deltaText });
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

type HttpQueryTransportOptions = {
  appRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export const createHttpQueryTransport = (
  options?: HttpQueryTransportOptions
): QueryTransport => {
  const effectiveEnv = options?.env ?? process.env;
  const appRoot =
    options?.appRoot ??
    resolveAmbientAppRoot({
      cwd: options?.cwd,
      env: effectiveEnv,
    });
  const env = envSchema.safeParse({
    CYRENE_BASE_URL: effectiveEnv.CYRENE_BASE_URL,
    CYRENE_API_KEY: effectiveEnv.CYRENE_API_KEY,
    CYRENE_MODEL: effectiveEnv.CYRENE_MODEL,
  });

  const baseUrl = env.success ? env.data.CYRENE_BASE_URL : undefined;
  const apiKey = env.success ? env.data.CYRENE_API_KEY : undefined;
  let currentModel = env.success
    ? env.data.CYRENE_MODEL ?? "gpt-4o-mini"
    : "gpt-4o-mini";
  let currentProvider = resolveProviderBaseUrl(baseUrl);
  let availableModels: string[] = [];
  let providerCatalog = currentProvider ? [currentProvider] : ([] as string[]);
  let initializationError: string | null = null;
  const sessionQueries = new Map<string, string>();
  const dedupeProviders = (providers: Array<string | undefined>) =>
    Array.from(new Set(providers.map(provider => resolveProviderBaseUrl(provider)).filter(Boolean))) as string[];
  const resolvePersistedModels = () =>
    availableModels.length > 0
      ? [...availableModels]
      : currentModel.trim()
        ? [currentModel]
        : ["gpt-4o-mini"];
  const persistCatalog = async (
    models: string[],
    selectedModel: string,
    provider: string | undefined
  ) => {
    providerCatalog = dedupeProviders([...providerCatalog, provider]);
    await saveModelYaml(models, selectedModel, {
      lastUsedModel: selectedModel,
      providerBaseUrl: provider,
      providers: providerCatalog,
    }, appRoot);
  };

  const refreshFromApi = async (
    preferredModel?: string,
    providerOverride?: string
  ) => {
    const targetProvider = resolveProviderBaseUrl(providerOverride ?? currentProvider ?? baseUrl);
    if (!targetProvider || !apiKey) {
      throw new Error("Missing CYRENE_BASE_URL or CYRENE_API_KEY.");
    }
    const response = await fetch(resolveModelsUrl(targetProvider), {
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
    await persistCatalog(models, selectedModel, targetProvider);
    availableModels = models;
    currentModel = selectedModel;
    currentProvider = targetProvider;
    initializationError = null;

    return models;
  };

  const initializeModels = async () => {
    try {
      const local = await loadModelYaml(appRoot);
      providerCatalog = dedupeProviders([
        ...local.providers,
        local.providerBaseUrl,
        currentProvider,
      ]);
      const providerChanged =
        Boolean(currentProvider) &&
        Boolean(local.providerBaseUrl) &&
        local.providerBaseUrl !== currentProvider;
      if (providerChanged) {
        await refreshFromApi(
          local.lastUsedModel ?? local.defaultModel ?? currentModel,
          currentProvider
        );
        return;
      }
      currentProvider = currentProvider ?? local.providerBaseUrl;
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
      if (providerCatalog.length > 0) {
        await persistCatalog(local.models, currentModel, currentProvider);
      }
      return;
    } catch {
      // Fall through to remote fetch.
    }

    try {
      await refreshFromApi(undefined, currentProvider);
    } catch (error) {
      initializationError =
        error instanceof Error ? error.message : String(error);
    }
  };

  const modelInit = initializeModels();

  return {
    getModel: () => currentModel,
    getProvider: () => currentProvider ?? "none",
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
        await persistCatalog(availableModels, next, currentProvider);
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
    listProviders: async () => {
      await modelInit;
      providerCatalog = dedupeProviders([...providerCatalog, currentProvider]);
      return [...providerCatalog];
    },
    setProvider: async (provider: string) => {
      await modelInit;
      const nextProvider = resolveProviderBaseUrl(provider.trim());
      if (!nextProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }
      if (!apiKey) {
        return {
          ok: false,
          message: "Missing CYRENE_API_KEY for HTTP transport.",
        };
      }
      if (currentProvider === nextProvider) {
        providerCatalog = dedupeProviders([...providerCatalog, currentProvider]);
        return {
          ok: true,
          message: `Provider already active: ${nextProvider}`,
          currentProvider: nextProvider,
          providers: [...providerCatalog],
          models: [...availableModels],
        };
      }
      try {
        const models = await refreshFromApi(undefined, nextProvider);
        return {
          ok: true,
          message: `Provider switched to: ${nextProvider}\nCurrent model: ${currentModel}`,
          currentProvider: currentProvider ?? nextProvider,
          providers: [...providerCatalog],
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
    refreshModels: async () => {
      try {
        const models = await refreshFromApi(undefined, currentProvider);
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
      const targetProvider = currentProvider ?? resolveProviderBaseUrl(baseUrl);
      if (!targetProvider || !apiKey) {
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
      return completeTextOpenAI(
        targetProvider,
        apiKey,
        currentModel,
        normalizedPrompt
      );
    },
    requestStreamUrl: async (query: string) => {
      await modelInit;
      const targetProvider = currentProvider ?? resolveProviderBaseUrl(baseUrl);
      if (!targetProvider || !apiKey) {
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

      if (!query || !apiKey) {
        throw new Error("Invalid HTTP stream session.");
      }
      const targetProvider = currentProvider ?? resolveProviderBaseUrl(baseUrl);

      if (!targetProvider) {
        throw new Error("Invalid HTTP stream session.");
      }

      for await (const event of streamSseOpenAI(
        targetProvider,
        apiKey,
        currentModel,
        query
      )) {
        yield event;
      }
    },
  };
};
