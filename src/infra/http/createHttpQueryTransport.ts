import { z } from "zod";
import {
  inferProviderType,
  isProviderType,
  resolveProviderTypeFamily,
  resolveProviderTypeFormat,
  type ProviderEndpointKind,
  type ProviderEndpointOverrideEntry,
  type ProviderEndpointOverrideMap,
  type ProviderEndpointSetResult,
  type ProviderFormatOverrideMap,
  type ProviderModelCatalogMode,
  type ProviderModelCatalogModeMap,
  type ProviderNameOverrideMap,
  type ProviderFormatSetResult,
  type ProviderProfile,
  type ProviderProfileOverrideMap,
  type ProviderType,
  type ProviderTypeOverrideMap,
  type ProviderTypeSetResult,
  type QueryTransport,
  type TransportFormat,
} from "../../core/query/transport";
import type { TokenUsage } from "../../core/query/tokenUsage";
import type { McpToolDescriptor } from "../../core/mcp/runtimeTypes";
import { loadModelYaml, saveModelYaml } from "../config/modelCatalog";
import { resolveAmbientAppRoot } from "../config/appRoot";

const envSchema = z.object({
  CYRENE_BASE_URL: z.string().min(1).optional(),
  CYRENE_API_KEY: z.string().min(1).optional(),
  CYRENE_OPENAI_API_KEY: z.string().min(1).optional(),
  CYRENE_GEMINI_API_KEY: z.string().min(1).optional(),
  CYRENE_ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CYRENE_MODEL: z.string().min(1).optional(),
});

const PROVIDER_ALIASES = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  anthropic: "https://api.anthropic.com",
  claude: "https://api.anthropic.com",
} as const;

type ProviderAlias = keyof typeof PROVIDER_ALIASES;
type ProviderFamily = "openai" | "gemini" | "anthropic" | "glm";
type ManualProviderProfile = Exclude<ProviderProfile, "custom">;
const PROVIDER_PROFILE_VALUES = ["openai", "gemini", "anthropic"] as const;
const TRANSPORT_FORMAT_VALUES = [
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
  "gemini_generate_content",
] as const;
const PROVIDER_ENDPOINT_KIND_VALUES = [
  "responses",
  "chat_completions",
  "models",
  "anthropic_messages",
  "gemini_generate_content",
] as const;

type ParsedProvider = {
  providerBaseUrl: string;
  family: ProviderFamily;
};

const isManualProviderProfile = (
  value: string
): value is ManualProviderProfile =>
  (PROVIDER_PROFILE_VALUES as readonly string[]).includes(value);

const isTransportFormat = (value: string): value is TransportFormat =>
  (TRANSPORT_FORMAT_VALUES as readonly string[]).includes(value);

const isProviderEndpointKind = (value: string): value is ProviderEndpointKind =>
  (PROVIDER_ENDPOINT_KIND_VALUES as readonly string[]).includes(value);

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
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

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
    cachedTokens: parsedUsage.data.prompt_tokens_details?.cached_tokens,
    completionTokens: parsedUsage.data.completion_tokens,
    totalTokens: parsedUsage.data.total_tokens,
  };
};

const buildUsageSignature = (usage: TokenUsage) =>
  `${usage.promptTokens}:${usage.cachedTokens ?? 0}:${usage.completionTokens}:${usage.totalTokens}`;

const extractUsageEvent = (payload: unknown) => {
  const usage = extractUsage(payload);
  if (!usage) {
    return null;
  }

  return {
    usage,
    event: JSON.stringify({
      type: "usage",
      promptTokens: usage.promptTokens,
      ...(typeof usage.cachedTokens === "number"
        ? { cachedTokens: usage.cachedTokens }
        : {}),
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    }),
  };
};

const MAX_HTTP_FAILURE_DETAIL_LENGTH = 1200;

const truncateHttpFailureDetail = (value: string) =>
  value.length > MAX_HTTP_FAILURE_DETAIL_LENGTH
    ? `${value.slice(0, MAX_HTTP_FAILURE_DETAIL_LENGTH)}...`
    : value;

const extractHttpFailureDetail = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    error?: unknown;
    message?: unknown;
    detail?: unknown;
  };

  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record.detail === "string" && record.detail.trim()) {
    return record.detail.trim();
  }

  if (record.error && typeof record.error === "object") {
    const errorRecord = record.error as {
      message?: unknown;
      detail?: unknown;
      code?: unknown;
      type?: unknown;
    };
    if (
      typeof errorRecord.message === "string" &&
      errorRecord.message.trim()
    ) {
      return errorRecord.message.trim();
    }
    if (typeof errorRecord.detail === "string" && errorRecord.detail.trim()) {
      return errorRecord.detail.trim();
    }

    const compactError = JSON.stringify(record.error);
    if (compactError && compactError !== "{}") {
      return compactError;
    }
  }

  const compactPayload = JSON.stringify(payload);
  if (compactPayload && compactPayload !== "{}") {
    return compactPayload;
  }
  return null;
};

const readHttpFailureDetail = async (response: Response) => {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return null;
    }

    try {
      const payload = JSON.parse(text) as unknown;
      const detail = extractHttpFailureDetail(payload);
      if (detail) {
        return truncateHttpFailureDetail(detail);
      }
    } catch {
      // Fall back to the raw response body when it is not JSON.
    }

    return truncateHttpFailureDetail(text);
  } catch {
    return null;
  }
};

const formatHttpFailure = async (
  label: "Stream error" | "Model fetch failed",
  response: Response,
  requestUrl: string
) => {
  const resolvedUrl = response.url?.trim() || requestUrl;
  const detail = await readHttpFailureDetail(response);
  return detail
    ? `${label}: ${response.status} ${response.statusText} | url ${resolvedUrl} | detail ${detail}`
    : `${label}: ${response.status} ${response.statusText} | url ${resolvedUrl}`;
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
            "ts_hover",
            "ts_definition",
            "ts_references",
            "ts_diagnostics",
            "ts_prepare_rename",
            "lsp_hover",
            "lsp_definition",
            "lsp_implementation",
            "lsp_type_definition",
            "lsp_references",
            "lsp_workspace_symbols",
            "lsp_document_symbols",
            "lsp_diagnostics",
            "lsp_prepare_rename",
            "lsp_rename",
            "lsp_code_actions",
            "lsp_format_document",
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
        line: {
          type: "integer",
          description:
            "1-based line for ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, lsp_references, lsp_rename, or lsp_code_actions.",
          minimum: 1,
        },
        column: {
          type: "integer",
          description:
            "1-based column for ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, lsp_references, lsp_rename, or lsp_code_actions.",
          minimum: 1,
        },
        newName: {
          type: "string",
          description: "Replacement identifier for ts_prepare_rename, lsp_prepare_rename, or lsp_rename.",
        },
        serverId: {
          type: "string",
          description:
            "Optional explicit LSP server id for lsp_* actions when more than one configured LSP server matches the path.",
        },
        title: {
          type: "string",
          description:
            "Exact code action title for lsp_code_actions apply mode. Omit to list available actions.",
        },
        kind: {
          type: "string",
          description:
            "Optional code action kind filter for lsp_code_actions, such as quickfix or refactor.extract.",
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
          description: "Symbol name for find_symbol or find_references, such as FileMcpService or SessionRepository.",
        },
        query: {
          type: "string",
          description:
            "Search string for search_text/search_text_context, or symbol query for lsp_workspace_symbols. Omit when unused.",
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
        tabSize: {
          type: "integer",
          minimum: 1,
          description: "Optional tab size for lsp_format_document.",
        },
        insertSpaces: {
          type: "boolean",
          description: "Optional spacing mode for lsp_format_document.",
        },
        caseSensitive: { type: "boolean" },
        findInComments: {
          type: "boolean",
          description: "Whether ts_prepare_rename should include comment matches.",
        },
        findInStrings: {
          type: "boolean",
          description: "Whether ts_prepare_rename should include string literal matches.",
        },
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
  "You are operating inside a workspace with function tools.",
  "The `file` function is always available for filesystem and shell work.",
  "When a domain-specific MCP tool is available for the task, prefer that tool instead of forcing the task through `file`.",
  "Tool-call protocol is strict: when a tool call is needed, output exactly one valid function tool call and nothing else.",
  "Do not output XML tags, pseudo-tags, markdown code fences, wrapper text, mixed tool syntaxes, or partially formed tool calls.",
  "Do not emit placeholders such as `<path>`, `your/path`, `example`, `...`, empty strings, or guessed arguments.",
  "Do not guess missing required arguments. If you do not know a required path or symbol yet, call a narrower discovery tool first.",
  "Use exact exposed tool names and provide arguments that match the tool schema.",
  "If a previous tool call was rejected, correct the exact schema error and retry with one corrected tool call only.",
  "Function arguments must be valid JSON and include required fields:",
  "{ action, path, content?, paths?, startLine?, endLine?, line?, column?, newName?, serverId?, title?, kind?, tabSize?, insertSpaces?, jsonPath?, yamlPath?, find?, replace?, pattern?, symbol?, query?, before?, after?, maxResults?, caseSensitive?, findInComments?, findInStrings?, destination?, revision?, command?, input?, args?, cwd? }.",
  "Never call the `file` tool with empty arguments, placeholder values, guessed fields you do not need, or unrelated extra fields.",
  "Available `file` actions are:",
  "read_file, read_files, read_range, read_json, read_yaml, list_dir, create_dir, create_file, write_file, edit_file, apply_patch, delete_file, stat_path, stat_paths, outline_file, find_files, find_symbol, find_references, search_text, search_text_context, copy_path, move_path, git_status, git_diff, git_log, git_show, git_blame, ts_hover, ts_definition, ts_references, ts_diagnostics, ts_prepare_rename, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, lsp_references, lsp_workspace_symbols, lsp_document_symbols, lsp_diagnostics, lsp_prepare_rename, lsp_rename, lsp_code_actions, lsp_format_document, run_command, run_shell, open_shell, write_shell, read_shell, shell_status, interrupt_shell, close_shell.",
  "Choose the narrowest action that answers the question. Prefer precise search or metadata actions over broad exploratory reads.",
  "Single-action discipline:",
  "- One tool call must express exactly one action. Do not mix read/search/edit/shell intents in the same payload.",
  "- If the next step requires a tool, do not output a natural-language plan instead of the tool call.",
  "- If you already have enough information to answer or act, stop calling tools and continue the task.",
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
  "- Use ts_hover for TypeScript/JavaScript quick info at an exact file position.",
  "- Use ts_definition for TypeScript/JavaScript definition lookup at an exact file position.",
  "- Use ts_references for semantic TypeScript/JavaScript references at an exact file position.",
  "- Prefer lsp_diagnostics for TypeScript/JavaScript diagnostics when a matching LSP server is configured; use ts_diagnostics as the fallback when LSP diagnostics are unavailable or clearly not configured.",
  "- Use ts_diagnostics for TypeScript/JavaScript diagnostics on one file when you specifically need the tsserver fallback path.",
  "- Use ts_prepare_rename to preview a semantic TypeScript/JavaScript rename before any file mutation.",
  "- Use lsp_hover for generic language-server hover info when TS-specific tools do not apply.",
  "- Use lsp_definition for generic language-server definition lookup.",
  "- Use lsp_implementation for generic language-server implementation lookup.",
  "- Use lsp_type_definition for generic language-server type-definition lookup.",
  "- Use lsp_references for generic language-server references.",
  "- Use lsp_workspace_symbols for generic language-server workspace symbol search.",
  "- Use lsp_document_symbols for generic language-server document symbols or outline.",
  "- Use lsp_diagnostics for generic language-server diagnostics on one file, including TypeScript/JavaScript workspaces that already have a matching LSP server.",
  "- Use lsp_prepare_rename to preview a generic language-server rename before any file mutation.",
  "- Use lsp_rename to apply a reviewed generic language-server rename.",
  "- Use lsp_code_actions to list available generic language-server code actions, or provide `title` to apply one reviewed edit-based action.",
  "- Use lsp_format_document to apply reviewed generic language-server formatting edits.",
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
  "- For read_file, provide `path` only. Do not send `paths`.",
  "- For stat_paths, set `path` to the first target and `paths` to any additional targets.",
  "- For stat_path, provide `path` only. Do not send `paths`.",
  "- For read_range, provide 1-based inclusive `startLine` and `endLine`.",
  "- For read_json, provide `jsonPath` only when you want one nested field instead of the whole document.",
  "- For read_yaml, provide `yamlPath` only when you want one nested field instead of the whole document.",
  "- For find_symbol, provide the exact symbol name in `symbol`.",
  "- For find_references, provide the exact symbol name in `symbol`.",
  "- For ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, and lsp_references, provide exact 1-based `line` and `column`.",
  "- For ts_diagnostics, provide a TS/JS file path and optional `maxResults` when you need fewer entries.",
  "- For ts_prepare_rename, provide exact 1-based `line`, `column`, and a non-empty `newName`.",
  "- For lsp_workspace_symbols, provide a non-empty `query`, a relevant `path` such as `.` or a matching file, and optional `serverId` when multiple configured LSP servers exist.",
  "- For lsp_document_symbols and lsp_diagnostics, provide a file path and optional `serverId` when multiple configured LSP servers could match.",
  "- For lsp_prepare_rename, provide exact 1-based `line`, `column`, a non-empty `newName`, and optional `serverId`.",
  "- For lsp_rename, provide exact 1-based `line`, `column`, a non-empty `newName`, and optional `serverId`.",
  "- For lsp_code_actions, provide exact 1-based `line` and `column`, optional `kind`, and optional `title` only when you want to apply one matching action.",
  "- For lsp_format_document, provide a file path and optional `serverId`, `tabSize`, or `insertSpaces`.",
  "- For search_text_context, use `before` and `after` only when you need surrounding context lines.",
  "- For git_log, use `maxResults` to limit how many commits you need.",
  "- For git_show, use `revision` and an optional scoped `path`.",
  "- For git_blame, provide a file path and optional `startLine` / `endLine` for a narrow range.",
  "- Use list_dir only when the directory listing itself is required.",
  "- Use create_file only for new-only file creation.",
  "- Use write_file for full overwrite writes.",
  "- Use edit_file for targeted replacement.",
  "- Use apply_patch for targeted patches on one file using `find` and `replace`.",
  "- For write_file, provide `content` with the full desired file body.",
  "- For edit_file and apply_patch, provide both `find` and `replace`.",
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
  "Invalid payload examples to avoid:",
  "- Do not send read_files with a single-file intent.",
  "- Do not send read_file together with `paths`.",
  "- Do not send read_files without a first target in `path`.",
  "- Do not send wrapper text before or after the tool call.",
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

const DEFAULT_DYNAMIC_TOOL_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const;

type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

const FILE_ACTION_NAMES = new Set<string>(
  FILE_TOOL.function.parameters.properties.action.enum
);

const normalizeDynamicToolSchema = (inputSchema: unknown) =>
  inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
    ? inputSchema
    : DEFAULT_DYNAMIC_TOOL_PARAMETERS;

const buildDynamicFunctionTools = (
  mcpTools: McpToolDescriptor[]
): OpenAIFunctionTool[] => {
  const seen = new Set<string>([FILE_TOOL.function.name]);
  const tools: OpenAIFunctionTool[] = [
    {
      type: "function",
      function: {
        name: FILE_TOOL.function.name,
        description: FILE_TOOL.function.description,
        parameters: FILE_TOOL.function.parameters,
      },
    },
  ];

  for (const tool of mcpTools) {
    const name = tool.name.trim();
    if (!name || seen.has(name) || FILE_ACTION_NAMES.has(name)) {
      continue;
    }
    seen.add(name);
    tools.push({
      type: "function" as const,
      function: {
        name,
        description: tool.description ?? tool.label,
        parameters: normalizeDynamicToolSchema(tool.inputSchema),
      },
    });
  }

  return tools;
};

const buildGeminiFunctionTools = (mcpTools: McpToolDescriptor[]) => ({
  functionDeclarations: buildDynamicFunctionTools(mcpTools).map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters:
      sanitizeGeminiSchema(tool.function.parameters) ?? {
        type: "object",
      },
  })),
});

const buildAnthropicTools = (mcpTools: McpToolDescriptor[]) =>
  buildDynamicFunctionTools(mcpTools).map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));

const buildToolUsageSystemPrompt = (mcpTools: McpToolDescriptor[]) => {
  const visibleTools = mcpTools
    .filter(tool => tool.enabled && tool.exposure !== "hidden")
    .map(tool => {
      const description = (tool.description ?? tool.label).trim();
      return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
    });

  if (visibleTools.length === 0) {
    return TOOL_USAGE_SYSTEM_PROMPT;
  }

  return [
    TOOL_USAGE_SYSTEM_PROMPT,
    "Additional available MCP tools:",
    ...visibleTools,
    "Use these additional tools directly when they are a better match than `file`.",
  ].join("\n");
};

const trimProviderInput = (value: string) => value.trim();

const repairCommonSchemeTypos = (value: string) => {
  const trimmed = value.trim();
  if (/^https\/\//i.test(trimmed)) {
    return `https://${trimmed.slice("https//".length)}`;
  }
  if (/^http\/\//i.test(trimmed)) {
    return `http://${trimmed.slice("http//".length)}`;
  }
  return trimmed;
};

const resolveProviderAlias = (value: string) => {
  const normalizedKey = trimProviderInput(value).toLowerCase() as ProviderAlias;
  return PROVIDER_ALIASES[normalizedKey];
};

const parseProviderBaseUrl = (provider: string): ParsedProvider => {
  const trimmed = repairCommonSchemeTypos(trimProviderInput(provider));
  if (!trimmed) {
    throw new Error("Provider cannot be empty.");
  }

  const aliased = resolveProviderAlias(trimmed);
  const candidate = aliased ?? trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    if (aliased) {
      parsed = new URL(aliased);
    } else {
      throw new Error(
        "Provider must be a valid URL or one of: openai, gemini, anthropic."
      );
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https.");
  }

  const normalized = parsed.toString().replace(/\/+$/, "");
  const host = parsed.hostname.toLowerCase();
  const family: ProviderFamily = host.includes("anthropic.com")
    ? "anthropic"
    : host.includes("generativelanguage.googleapis.com")
      ? "gemini"
      : host.includes("bigmodel.cn") || host.includes("zhipuai.cn")
        ? "glm"
        : "openai";

  return {
    providerBaseUrl: normalized,
    family,
  };
};

export const normalizeProviderBaseUrl = (url: string) =>
  parseProviderBaseUrl(url).providerBaseUrl;

const resolveProviderFamily = (providerBaseUrl: string): ProviderFamily =>
  parseProviderBaseUrl(providerBaseUrl).family;

const resolveProviderEndpointOverrideUrl = (
  baseUrl: string,
  override: string
) => {
  const trimmed = override.trim();
  if (!trimmed) {
    throw new Error("Provider endpoint override cannot be empty.");
  }
  const repaired = repairCommonSchemeTypos(trimmed);
  try {
    const absolute = new URL(repaired);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      throw new Error("Provider endpoint override must use http or https.");
    }
    return absolute.toString();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Provider endpoint override must use http or https."
    ) {
      throw error;
    }
  }

  const normalized = normalizeProviderBaseUrl(baseUrl);
  const baseWithSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return new URL(repaired, baseWithSlash).toString();
};

const resolveChatCompletionsUrl = (
  baseUrl: string,
  endpointOverride?: string | null
) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride);
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const family = resolveProviderFamily(normalized);
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (family === "glm") {
    return normalized.endsWith("/api/paas/v4") || normalized.endsWith("/v4")
      ? `${normalized}/chat/completions`
      : `${normalized}/chat/completions`;
  }
  if (normalized.endsWith("/openai")) {
    return `${normalized}/chat/completions`;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};

const resolveResponsesUrls = (baseUrl: string, endpointOverride?: string | null) => {
  if (endpointOverride?.trim()) {
    return [resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride)];
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (normalized.endsWith("/responses")) {
    return [normalized];
  }
  if (normalized.endsWith("/openai")) {
    return [`${normalized}/responses`];
  }
  if (normalized.endsWith("/v1")) {
    return [`${normalized}/responses`];
  }
  return [`${normalized}/responses`, `${normalized}/v1/responses`];
};

const resolveModelsUrl = (baseUrl: string, endpointOverride?: string | null) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride);
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const family = resolveProviderFamily(normalized);
  if (normalized.endsWith("/models")) {
    return normalized;
  }
  if (family === "glm") {
    return normalized.endsWith("/api/paas/v4") || normalized.endsWith("/v4")
      ? `${normalized}/models`
      : `${normalized}/models`;
  }
  if (normalized.endsWith("/openai")) {
    return `${normalized}/models`;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
};

const resolveAnthropicMessagesUrl = (
  baseUrl: string,
  endpointOverride?: string | null
) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride);
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (normalized.endsWith("/messages")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
};

const resolveGeminiGenerateContentUrl = (
  baseUrl: string,
  model: string,
  endpointOverride?: string | null
) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(
      baseUrl,
      endpointOverride.replaceAll("{model}", encodeURIComponent(model))
    );
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (normalized.includes("/openai")) {
    throw new Error(
      "gemini_generate_content requires a native Gemini base URL, not the OpenAI-compatible /openai endpoint."
    );
  }
  if (/\/models\/[^/?#]+$/.test(normalized)) {
    return `${normalized}:streamGenerateContent?alt=sse`;
  }
  if (normalized.endsWith("/models")) {
    return `${normalized}/${model}:streamGenerateContent?alt=sse`;
  }
  if (normalized.endsWith("/v1beta")) {
    return `${normalized}/models/${model}:streamGenerateContent?alt=sse`;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/models/${model}:streamGenerateContent?alt=sse`;
  }
  return `${normalized}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
};
const DONE_EVENT = JSON.stringify({ type: "done" });
const resolveProviderBaseUrl = (baseUrl: string | undefined) => {
  if (!baseUrl) {
    return undefined;
  }
  try {
    return normalizeProviderBaseUrl(baseUrl);
  } catch {
    return undefined;
  }
};
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

  const stringParts = content.filter(
    (item): item is string => typeof item === "string"
  );
  const typedItems = content
    .filter(
      (item): item is { type?: unknown; text?: unknown } =>
        Boolean(item) && typeof item === "object"
    )
    .filter(
      item =>
        item.type === "text" ||
        item.type === "output_text" ||
        item.type === "input_text"
    );
  const preferredTypedItems = typedItems.some(item => item.type === "output_text")
    ? typedItems.filter(item => item.type === "output_text")
    : typedItems.filter(item => item.type === "text");

  return joinVisibleParts([
    ...stringParts,
    ...preferredTypedItems.map(item => extractTextValue(item.text)),
  ]);
};

const extractVisibleDeltaText = (
  delta: unknown,
  options?: { includeReasoning?: boolean }
) => {
  if (!delta || typeof delta !== "object") {
    return "";
  }

  const typedDelta = delta as {
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
  };

  return joinVisibleParts(
    [
      extractTextContent(typedDelta.content),
      options?.includeReasoning
        ? extractReasoningText(typedDelta.reasoning_content)
        : "",
      options?.includeReasoning
        ? extractReasoningText(typedDelta.reasoning)
        : "",
      options?.includeReasoning ? extractReasoningText(typedDelta.thinking) : "",
    ].filter(Boolean)
  );
};

async function* streamSseOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
  options?: {
    includeReasoning?: boolean;
    temperature?: number;
    family?: ProviderFamily;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
  }
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (options?.family === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  }

  const requestUrl = resolveChatCompletionsUrl(
    baseUrl,
    options?.endpointOverride
  );
  const response = await fetch(
    requestUrl,
    {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: options?.temperature ?? 0.2,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      tool_choice: "auto",
      tools: buildDynamicFunctionTools(options?.mcpTools ?? []),
      messages: [
        { role: "system", content: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    }),
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, requestUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolState = new Map<number, { name?: string; args: string; emitted: boolean }>();
  let lastUsageSignature = "";

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
            const signature = buildUsageSignature(usageEvent.usage);
            if (signature !== lastUsageSignature) {
              lastUsageSignature = signature;
              yield usageEvent.event;
            }
          }
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          const deltaText = extractVisibleDeltaText(delta, {
            includeReasoning: options?.includeReasoning,
          });

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

type GeminiSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
};

const sanitizeGeminiSchema = (value: unknown): GeminiSchema | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    type?: unknown;
    description?: unknown;
    enum?: unknown;
    format?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    required?: unknown;
    items?: unknown;
    properties?: unknown;
  };
  const schema: GeminiSchema = {};

  if (typeof record.type === "string" && record.type.trim()) {
    schema.type = record.type;
  }
  if (typeof record.description === "string" && record.description.trim()) {
    schema.description = record.description;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    schema.enum = [...record.enum];
  }
  if (typeof record.format === "string" && record.format.trim()) {
    schema.format = record.format;
  }
  if (typeof record.minimum === "number" && Number.isFinite(record.minimum)) {
    schema.minimum = record.minimum;
  }
  if (typeof record.maximum === "number" && Number.isFinite(record.maximum)) {
    schema.maximum = record.maximum;
  }
  if (Array.isArray(record.required)) {
    const required = record.required.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    if (required.length > 0) {
      schema.required = required;
    }
  }

  const items = sanitizeGeminiSchema(record.items);
  if (items) {
    schema.items = items;
  }

  if (record.properties && typeof record.properties === "object") {
    const properties = Object.entries(record.properties).reduce<Record<string, GeminiSchema>>(
      (accumulator, [key, child]) => {
        const sanitized = sanitizeGeminiSchema(child);
        if (sanitized) {
          accumulator[key] = sanitized;
        }
        return accumulator;
      },
      {}
    );
    if (Object.keys(properties).length > 0) {
      schema.properties = properties;
    }
  }

  if (Object.keys(schema).length === 0) {
    return undefined;
  }
  return schema;
};

type ResponsesUsageState = {
  lastEmitted?: string;
};

const emitResponseToolCallIfReady = (
  current: { name?: string; args: string; emitted: boolean }
) => {
  if (!current.name || current.emitted) {
    return null;
  }
  let parsedArgs: unknown = {};
  try {
    parsedArgs = current.args ? JSON.parse(current.args) : {};
  } catch {
    return null;
  }
  if (
    parsedArgs &&
    typeof parsedArgs === "object" &&
    Object.keys(parsedArgs as Record<string, unknown>).length === 0
  ) {
    return null;
  }
  current.emitted = true;
  return JSON.stringify({
    type: "tool_call",
    toolName: current.name,
    input: parsedArgs,
  });
};

const extractResponsesUsageEvent = (
  payload: unknown,
  state: ResponsesUsageState
) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    usage?: unknown;
    response?: { usage?: unknown };
  };
  const usageCandidate = record.usage ?? record.response?.usage;
  if (!usageCandidate || typeof usageCandidate !== "object") {
    return null;
  }

  const usageRecord = usageCandidate as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
  };
  const promptTokens =
    typeof usageRecord.input_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.input_tokens))
      : 0;
  const completionTokens =
    typeof usageRecord.output_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.output_tokens))
      : 0;
  const totalTokens =
    typeof usageRecord.total_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.total_tokens))
      : promptTokens + completionTokens;
  const cachedTokens =
    typeof usageRecord.input_tokens_details?.cached_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.input_tokens_details.cached_tokens))
      : undefined;
  const signature = `${promptTokens}:${cachedTokens ?? 0}:${completionTokens}:${totalTokens}`;
  if (state.lastEmitted === signature) {
    return null;
  }
  state.lastEmitted = signature;
  return JSON.stringify({
    type: "usage",
    promptTokens,
    ...(typeof cachedTokens === "number" ? { cachedTokens } : {}),
    completionTokens,
    totalTokens,
  });
};

async function* streamSseOpenAIResponses(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
  options?: {
    temperature?: number;
    family?: ProviderFamily;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
  }
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (options?.family === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  }

  const body = JSON.stringify({
    model,
    temperature: options?.temperature ?? 0.2,
    stream: true,
    tool_choice: "auto",
    tools: buildDynamicFunctionTools(options?.mcpTools ?? []),
    instructions: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT,
    input: query,
  });
  const candidateUrls = resolveResponsesUrls(
    baseUrl,
    options?.endpointOverride
  );
  let attemptedUrl = candidateUrls[0] ?? baseUrl;
  let response = await fetch(attemptedUrl, {
    method: "POST",
    headers,
    body,
  });

  if (
    candidateUrls.length > 1 &&
    !response.ok &&
    (response.status === 404 ||
      response.status === 405 ||
      response.status === 410 ||
      response.status === 501)
  ) {
    attemptedUrl = candidateUrls[1]!;
    response = await fetch(attemptedUrl, {
      method: "POST",
      headers,
      body,
    });
  }

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, attemptedUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageState: ResponsesUsageState = {};
  const toolState = new Map<
    string,
    {
      name?: string;
      args: string;
      emitted: boolean;
    }
  >();

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
            type?: unknown;
            delta?: unknown;
            item_id?: unknown;
            output_index?: unknown;
            item?: {
              type?: unknown;
              name?: unknown;
              arguments?: unknown;
              call_id?: unknown;
            };
            response?: { output?: Array<unknown>; usage?: unknown };
          };
          const usageEvent = extractResponsesUsageEvent(parsed, usageState);
          if (usageEvent) {
            yield usageEvent;
          }

          const eventType =
            typeof parsed.type === "string" ? parsed.type : "";
          if (
            (eventType === "response.output_text.delta" ||
              eventType === "response.refusal.delta") &&
            typeof parsed.delta === "string" &&
            parsed.delta
          ) {
            yield JSON.stringify({
              type: "text_delta",
              text: parsed.delta,
            });
          }

          if (
            eventType === "response.output_item.added" ||
            eventType === "response.output_item.done"
          ) {
            const item = parsed.item;
            const itemType = typeof item?.type === "string" ? item.type : "";
            if (itemType === "function_call") {
              const key =
                (typeof parsed.item_id === "string" && parsed.item_id) ||
                (typeof item?.call_id === "string" && item.call_id) ||
                String(parsed.output_index ?? 0);
              const current = toolState.get(key) ?? {
                args: "",
                emitted: false,
              };
              if (typeof item?.name === "string") {
                current.name = item.name;
              }
              if (typeof item?.arguments === "string") {
                current.args = item.arguments;
              }
              toolState.set(key, current);
              const toolEvent = emitResponseToolCallIfReady(current);
              if (toolEvent) {
                yield toolEvent;
              }
            }
          }

          if (eventType === "response.function_call_arguments.delta") {
            const key =
              (typeof parsed.item_id === "string" && parsed.item_id) ||
              String(parsed.output_index ?? 0);
            const current = toolState.get(key) ?? {
              args: "",
              emitted: false,
            };
            if (typeof parsed.delta === "string") {
              current.args += parsed.delta;
            }
            toolState.set(key, current);
            const toolEvent = emitResponseToolCallIfReady(current);
            if (toolEvent) {
              yield toolEvent;
            }
          }

          if (eventType === "response.completed") {
            if (parsed.response?.output) {
              for (const item of parsed.response.output) {
                if (!item || typeof item !== "object") {
                  continue;
                }
                const record = item as {
                  type?: unknown;
                  name?: unknown;
                  arguments?: unknown;
                  call_id?: unknown;
                };
                if (record.type !== "function_call") {
                  continue;
                }
                const key =
                  (typeof record.call_id === "string" && record.call_id) ||
                  String(toolState.size);
                const current = toolState.get(key) ?? {
                  args: "",
                  emitted: false,
                };
                if (typeof record.name === "string") {
                  current.name = record.name;
                }
                if (typeof record.arguments === "string") {
                  current.args = record.arguments;
                }
                toolState.set(key, current);
                const toolEvent = emitResponseToolCallIfReady(current);
                if (toolEvent) {
                  yield toolEvent;
                }
              }
            }
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

      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          delta?: unknown;
          item_id?: unknown;
          output_index?: unknown;
          item?: {
            type?: unknown;
            name?: unknown;
            arguments?: unknown;
            call_id?: unknown;
          };
          response?: { output?: Array<unknown>; usage?: unknown };
        };
        const usageEvent = extractResponsesUsageEvent(parsed, usageState);
        if (usageEvent) {
          yield usageEvent;
        }

        const eventType =
          typeof parsed.type === "string" ? parsed.type : "";
        if (
          (eventType === "response.output_text.delta" ||
            eventType === "response.refusal.delta") &&
          typeof parsed.delta === "string" &&
          parsed.delta
        ) {
          yield JSON.stringify({
            type: "text_delta",
            text: parsed.delta,
          });
        }

        if (
          eventType === "response.output_item.added" ||
          eventType === "response.output_item.done"
        ) {
          const item = parsed.item;
          const itemType = typeof item?.type === "string" ? item.type : "";
          if (itemType === "function_call") {
            const key =
              (typeof parsed.item_id === "string" && parsed.item_id) ||
              (typeof item?.call_id === "string" && item.call_id) ||
              String(parsed.output_index ?? 0);
            const current = toolState.get(key) ?? {
              args: "",
              emitted: false,
            };
            if (typeof item?.name === "string") {
              current.name = item.name;
            }
            if (typeof item?.arguments === "string") {
              current.args = item.arguments;
            }
            toolState.set(key, current);
            const toolEvent = emitResponseToolCallIfReady(current);
            if (toolEvent) {
              yield toolEvent;
            }
          }
        }

        if (eventType === "response.function_call_arguments.delta") {
          const key =
            (typeof parsed.item_id === "string" && parsed.item_id) ||
            String(parsed.output_index ?? 0);
          const current = toolState.get(key) ?? {
            args: "",
            emitted: false,
          };
          if (typeof parsed.delta === "string") {
            current.args += parsed.delta;
          }
          toolState.set(key, current);
          const toolEvent = emitResponseToolCallIfReady(current);
          if (toolEvent) {
            yield toolEvent;
          }
        }

        if (eventType === "response.completed") {
          if (parsed.response?.output) {
            for (const item of parsed.response.output) {
              if (!item || typeof item !== "object") {
                continue;
              }
              const record = item as {
                type?: unknown;
                name?: unknown;
                arguments?: unknown;
                call_id?: unknown;
              };
              if (record.type !== "function_call") {
                continue;
              }
              const key =
                (typeof record.call_id === "string" && record.call_id) ||
                String(toolState.size);
              const current = toolState.get(key) ?? {
                args: "",
                emitted: false,
              };
              if (typeof record.name === "string") {
                current.name = record.name;
              }
              if (typeof record.arguments === "string") {
                current.args = record.arguments;
              }
              toolState.set(key, current);
              const toolEvent = emitResponseToolCallIfReady(current);
              if (toolEvent) {
                yield toolEvent;
              }
            }
          }
          yield DONE_EVENT;
          return;
        }
      } catch {
        // ignore malformed SSE data line
      }
    }
  }

  yield DONE_EVENT;
}

type GeminiUsageState = {
  lastEmitted?: string;
};

const extractGeminiUsageEvent = (
  payload: unknown,
  state: GeminiUsageState
) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const usageRecord = (payload as { usageMetadata?: unknown }).usageMetadata;
  if (!usageRecord || typeof usageRecord !== "object") {
    return null;
  }

  const typedUsage = usageRecord as {
    promptTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
  const promptTokens =
    typeof typedUsage.promptTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.promptTokenCount))
      : 0;
  const cachedTokens =
    typeof typedUsage.cachedContentTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.cachedContentTokenCount))
      : undefined;
  const completionTokens =
    typeof typedUsage.candidatesTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.candidatesTokenCount))
      : 0;
  const totalTokens =
    typeof typedUsage.totalTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.totalTokenCount))
      : promptTokens + completionTokens;
  const signature = `${promptTokens}:${cachedTokens ?? 0}:${completionTokens}:${totalTokens}`;
  if (state.lastEmitted === signature) {
    return null;
  }
  state.lastEmitted = signature;
  return JSON.stringify({
    type: "usage",
    promptTokens,
    ...(typeof cachedTokens === "number" ? { cachedTokens } : {}),
    completionTokens,
    totalTokens,
  });
};

const collectGeminiCandidateParts = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return [] as Array<Record<string, unknown>>;
  }

  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return [] as Array<Record<string, unknown>>;
  }

  return candidates.flatMap(candidate => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const content = (candidate as { content?: unknown }).content;
    if (!content || typeof content !== "object") {
      return [];
    }
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) {
      return [];
    }
    return parts.filter(
      (part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === "object"
    );
  });
};

const extractGeminiTextEvents = (payload: unknown) =>
  collectGeminiCandidateParts(payload)
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .map(text => JSON.stringify({ type: "text_delta", text }));

const extractGeminiToolEvents = (
  payload: unknown,
  emitted: Set<string>
) => {
  const events: string[] = [];
  for (const part of collectGeminiCandidateParts(payload)) {
    const functionCall = part.functionCall;
    if (!functionCall || typeof functionCall !== "object") {
      continue;
    }

    const typedFunctionCall = functionCall as {
      id?: unknown;
      name?: unknown;
      args?: unknown;
    };
    const toolName =
      typeof typedFunctionCall.name === "string" ? typedFunctionCall.name : "";
    if (!toolName) {
      continue;
    }

    let input: unknown = {};
    if (typeof typedFunctionCall.args === "string") {
      try {
        input = JSON.parse(typedFunctionCall.args);
      } catch {
        input = { raw: typedFunctionCall.args };
      }
    } else if (
      typedFunctionCall.args &&
      typeof typedFunctionCall.args === "object"
    ) {
      input = typedFunctionCall.args;
    }

    if (
      input &&
      typeof input === "object" &&
      Object.keys(input as Record<string, unknown>).length === 0
    ) {
      continue;
    }

    const signature = [
      typeof typedFunctionCall.id === "string" ? typedFunctionCall.id : "",
      toolName,
      JSON.stringify(input),
    ].join(":");
    if (emitted.has(signature)) {
      continue;
    }
    emitted.add(signature);
    events.push(
      JSON.stringify({
        type: "tool_call",
        toolName,
        input,
      })
    );
  }
  return events;
};

async function* streamSseGeminiGenerateContent(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
  options?: {
    temperature?: number;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
  }
): AsyncGenerator<string> {
  const requestUrl = resolveGeminiGenerateContentUrl(
    baseUrl,
    model,
    options?.endpointOverride
  );
  const response = await fetch(
    requestUrl,
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: query }],
          },
        ],
        tools: [buildGeminiFunctionTools(options?.mcpTools ?? [])],
        toolConfig: {
          functionCallingConfig: {
            mode: "AUTO",
          },
        },
        generationConfig: {
          temperature: options?.temperature ?? 0.2,
        },
      }),
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, requestUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageState: GeminiUsageState = {};
  const emittedToolCalls = new Set<string>();

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
          const parsed = JSON.parse(line) as unknown;
          const usageEvent = extractGeminiUsageEvent(parsed, usageState);
          if (usageEvent) {
            yield usageEvent;
          }
          for (const event of extractGeminiTextEvents(parsed)) {
            yield event;
          }
          for (const event of extractGeminiToolEvents(parsed, emittedToolCalls)) {
            yield event;
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

      try {
        const parsed = JSON.parse(line) as unknown;
        const usageEvent = extractGeminiUsageEvent(parsed, usageState);
        if (usageEvent) {
          yield usageEvent;
        }
        for (const event of extractGeminiTextEvents(parsed)) {
          yield event;
        }
        for (const event of extractGeminiToolEvents(parsed, emittedToolCalls)) {
          yield event;
        }
      } catch {
        // ignore malformed SSE data line
      }
    }
  }

  yield DONE_EVENT;
}

type AnthropicUsageState = {
  inputTokens?: number;
  outputTokens?: number;
  lastEmitted?: string;
};

const parseAnthropicToolArgs = (rawArgs: string): unknown => {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Anthropic may emit an empty input object at block start before streaming
    // the real JSON arguments via input_json_delta chunks.
    if (trimmed.startsWith("{}")) {
      try {
        return JSON.parse(trimmed.slice(2).trimStart());
      } catch {
        // fall through to raw payload below
      }
    }
    return { raw: rawArgs };
  }
};

const extractAnthropicUsageEvent = (
  payload: unknown,
  state: AnthropicUsageState
) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    usage?: unknown;
    message?: { usage?: unknown };
  };
  const usageCandidate = record.usage ?? record.message?.usage;
  if (!usageCandidate || typeof usageCandidate !== "object") {
    return null;
  }

  const usageRecord = usageCandidate as {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  if (typeof usageRecord.input_tokens === "number") {
    state.inputTokens = Math.max(0, Math.floor(usageRecord.input_tokens));
  }
  if (typeof usageRecord.output_tokens === "number") {
    state.outputTokens = Math.max(0, Math.floor(usageRecord.output_tokens));
  }

  if (
    typeof state.inputTokens !== "number" &&
    typeof state.outputTokens !== "number"
  ) {
    return null;
  }

  const promptTokens = state.inputTokens ?? 0;
  const completionTokens = state.outputTokens ?? 0;
  const signature = `${promptTokens}:${completionTokens}`;
  if (state.lastEmitted === signature) {
    return null;
  }
  state.lastEmitted = signature;
  return JSON.stringify({
    type: "usage",
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
};

async function* streamSseAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
  options?: {
    temperature?: number;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
  }
): AsyncGenerator<string> {
  const requestUrl = resolveAnthropicMessagesUrl(
    baseUrl,
    options?.endpointOverride
  );
  const response = await fetch(
    requestUrl,
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 4096,
        temperature: options?.temperature ?? 0.2,
        system: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT,
        tools: buildAnthropicTools(options?.mcpTools ?? []),
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: query }],
      }),
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, requestUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageState: AnthropicUsageState = {};
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
            type?: unknown;
            index?: unknown;
            content_block?: {
              type?: unknown;
              text?: unknown;
              name?: unknown;
              input?: unknown;
            };
            delta?: {
              type?: unknown;
              text?: unknown;
              partial_json?: unknown;
            };
          };
          const usageEvent = extractAnthropicUsageEvent(parsed, usageState);
          if (usageEvent) {
            yield usageEvent;
          }

          const eventType =
            typeof parsed.type === "string" ? parsed.type : "";
          const index = typeof parsed.index === "number" ? parsed.index : 0;

          if (eventType === "content_block_start") {
            const contentBlock = parsed.content_block;
            const blockType =
              contentBlock && typeof contentBlock.type === "string"
                ? contentBlock.type
                : "";
            if (blockType === "text" && typeof contentBlock?.text === "string") {
              if (contentBlock.text) {
                yield JSON.stringify({
                  type: "text_delta",
                  text: contentBlock.text,
                });
              }
            }
            if (blockType === "tool_use") {
              const current = toolState.get(index) ?? {
                args: "",
                emitted: false,
              };
              if (typeof contentBlock?.name === "string") {
                current.name = contentBlock.name;
              }
              if (typeof contentBlock?.input === "string") {
                current.args += contentBlock.input;
              } else if (
                contentBlock?.input &&
                typeof contentBlock.input === "object"
              ) {
                const serializedInput = JSON.stringify(contentBlock.input);
                if (serializedInput !== "{}") {
                  current.args = serializedInput;
                }
              }
              toolState.set(index, current);
            }
          }

          if (eventType === "content_block_delta") {
            const deltaType =
              parsed.delta && typeof parsed.delta.type === "string"
                ? parsed.delta.type
                : "";
            if (
              deltaType === "text_delta" &&
              typeof parsed.delta?.text === "string" &&
              parsed.delta.text
            ) {
              yield JSON.stringify({
                type: "text_delta",
                text: parsed.delta.text,
              });
            }
            if (
              deltaType === "input_json_delta" &&
              typeof parsed.delta?.partial_json === "string"
            ) {
              const current = toolState.get(index) ?? {
                args: "",
                emitted: false,
              };
              current.args += parsed.delta.partial_json;
              toolState.set(index, current);
            }
          }

          if (eventType === "content_block_stop") {
            const current = toolState.get(index);
            if (current?.name && !current.emitted) {
              const parsedArgs = parseAnthropicToolArgs(current.args);
              if (
                parsedArgs &&
                typeof parsedArgs === "object" &&
                Object.keys(parsedArgs as Record<string, unknown>).length > 0
              ) {
                yield JSON.stringify({
                  type: "tool_call",
                  toolName: current.name,
                  input: parsedArgs,
                });
                current.emitted = true;
                toolState.set(index, current);
              }
            }
          }

          if (eventType === "message_stop") {
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
    payload &&
    typeof payload === "object" &&
    "models" in payload &&
    Array.isArray((payload as { models: unknown[] }).models)
  ) {
    const models = (payload as { models: Array<{ name?: unknown }> }).models
      .map(item => (typeof item?.name === "string" ? item.name : ""))
      .map(name => name.replace(/^models\//, "").trim())
      .filter(Boolean);
    return Array.from(new Set(models));
  }

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

const shouldFallbackToManualModelCatalog = (status: number) =>
  status === 404 || status === 405 || status === 410 || status === 501;

const buildManualModelCatalog = (options: {
  providerBaseUrl: string;
  providerFamily: ProviderFamily;
  preferredModel?: string;
  currentModel?: string;
}): ProviderModelCatalogResult => {
  const fallbackModel = resolveDefaultModelForFamily(options.providerFamily);
  const selectedModel =
    options.preferredModel?.trim() ||
    options.currentModel?.trim() ||
    fallbackModel;
  const models = Array.from(
    new Set(
      [
        options.preferredModel?.trim(),
        options.currentModel?.trim(),
        selectedModel,
      ].filter(Boolean)
    )
  ) as string[];
  return {
    providerBaseUrl: options.providerBaseUrl,
    models,
    selectedModel,
    catalogMode: "manual",
  };
};

export type ProviderModelCatalogResult = {
  providerBaseUrl: string;
  models: string[];
  selectedModel: string;
  catalogMode: ProviderModelCatalogMode;
};

export const fetchProviderModelCatalog = async (options: {
  baseUrl: string;
  apiKey: string;
  preferredModel?: string;
  currentModel?: string;
  familyOverride?: ProviderFamily;
  endpointOverride?: string | null;
}): Promise<ProviderModelCatalogResult> => {
  const parsedProvider = parseProviderBaseUrl(options.baseUrl);
  const providerBaseUrl = parsedProvider.providerBaseUrl;
  const providerFamily = options.familyOverride ?? parsedProvider.family;
  const requestUrl = resolveModelsUrl(providerBaseUrl, options.endpointOverride);
  const response =
    providerFamily === "anthropic"
      ? await fetch(requestUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
        })
      : await fetch(requestUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            ...(providerFamily === "gemini"
              ? { "x-goog-api-key": options.apiKey }
              : {}),
          },
        });
  if (!response.ok) {
    if (shouldFallbackToManualModelCatalog(response.status)) {
      return buildManualModelCatalog({
        providerBaseUrl,
        providerFamily,
        preferredModel: options.preferredModel,
        currentModel: options.currentModel,
      });
    }
    throw new Error(await formatHttpFailure("Model fetch failed", response, requestUrl));
  }
  const payload = (await response.json()) as unknown;
  const models = parseModelsPayload(payload);
  if (models.length === 0) {
    throw new Error("Model fetch returned empty list.");
  }

  const fallbackModel = resolveDefaultModelForFamily(providerFamily);
  const firstModel = models[0] ?? options.currentModel ?? fallbackModel;
  const selectedModel =
    (options.preferredModel && models.includes(options.preferredModel)
      ? options.preferredModel
      : undefined) ??
    (options.currentModel && models.includes(options.currentModel)
      ? options.currentModel
      : undefined) ??
    firstModel;

  return {
    providerBaseUrl,
    models,
    selectedModel,
    catalogMode: "api",
  };
};

export type HttpQueryTransportOptions = {
  appRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTemperature?: number;
  mcpTools?: McpToolDescriptor[];
};

type ParsedHttpEnv = z.infer<typeof envSchema>;

const resolveDefaultModelForFamily = (family: ProviderFamily) =>
  family === "anthropic"
    ? "claude-3-7-sonnet-latest"
    : family === "glm"
      ? "glm-4-flash"
      : "gpt-4o-mini";

const resolveDefaultFormatForProvider = (
  provider: string | undefined,
  familyOverride?: ProviderFamily
): TransportFormat => {
  const normalizedProvider = resolveProviderBaseUrl(provider);
  const family =
    familyOverride ??
    (normalizedProvider ? resolveProviderFamily(normalizedProvider) : "openai");
  if (family === "anthropic") {
    return "anthropic_messages";
  }
  if (
    family === "gemini" &&
    normalizedProvider &&
    !normalizedProvider.includes("/openai")
  ) {
    try {
      if (
        new URL(normalizedProvider).hostname.toLowerCase() ===
        "generativelanguage.googleapis.com"
      ) {
        return "gemini_generate_content";
      }
    } catch {
      // Fall through to the default OpenAI-compatible format.
    }
  }
  if (normalizedProvider && normalizedProvider.endsWith("/responses")) {
    return "openai_responses";
  }
  return "openai_chat";
};

const resolveDefaultTypeForProvider = (
  provider: string | undefined,
  familyOverride?: ProviderFamily
): ProviderType | null => {
  const normalizedProvider = resolveProviderBaseUrl(provider);
  const family =
    familyOverride ??
    (normalizedProvider ? resolveProviderFamily(normalizedProvider) : "openai");
  return inferProviderType({
    family,
    format: resolveDefaultFormatForProvider(normalizedProvider, family),
  });
};

const resolveApiKeySourceForFamily = (
  family: ProviderFamily,
  env: ParsedHttpEnv
) => {
  if (family === "anthropic" && env.CYRENE_ANTHROPIC_API_KEY) {
    return "CYRENE_ANTHROPIC_API_KEY";
  }
  if (family === "gemini" && env.CYRENE_GEMINI_API_KEY) {
    return "CYRENE_GEMINI_API_KEY";
  }
  if (family === "glm") {
    return env.CYRENE_API_KEY ? "CYRENE_API_KEY" : "none";
  }
  if (family === "openai" && env.CYRENE_OPENAI_API_KEY) {
    return "CYRENE_OPENAI_API_KEY";
  }
  return env.CYRENE_API_KEY ? "CYRENE_API_KEY" : "none";
};

const resolveApiKeyForFamily = (
  family: ProviderFamily,
  env: ParsedHttpEnv
) => {
  if (family === "anthropic") {
    return env.CYRENE_ANTHROPIC_API_KEY ?? env.CYRENE_API_KEY;
  }
  if (family === "gemini") {
    return env.CYRENE_GEMINI_API_KEY ?? env.CYRENE_API_KEY;
  }
  if (family === "glm") {
    return env.CYRENE_API_KEY;
  }
  return env.CYRENE_OPENAI_API_KEY ?? env.CYRENE_API_KEY;
};

const resolveApiKeySourceForProvider = (
  provider: string | undefined,
  env: ParsedHttpEnv,
  resolveFamily?: (provider: string) => ProviderFamily
) => {
  if (!provider) {
    return env.CYRENE_API_KEY ? "CYRENE_API_KEY" : "none";
  }
  const family = resolveFamily
    ? resolveFamily(provider)
    : resolveProviderFamily(provider);
  return resolveApiKeySourceForFamily(family, env);
};

const resolveApiKeyForProvider = (
  provider: string | undefined,
  env: ParsedHttpEnv,
  resolveFamily?: (provider: string) => ProviderFamily
) => {
  if (!provider) {
    return env.CYRENE_API_KEY;
  }
  const family = resolveFamily
    ? resolveFamily(provider)
    : resolveProviderFamily(provider);
  return resolveApiKeyForFamily(family, env);
};

export const createHttpQueryTransport = (
  options?: HttpQueryTransportOptions
): QueryTransport => {
  const effectiveEnv = options?.env ?? process.env;
  const includeReasoningInTranscript =
    effectiveEnv.CYRENE_STREAM_REASONING === "1";
  const requestTemperature =
    typeof options?.requestTemperature === "number" &&
    Number.isFinite(options.requestTemperature)
      ? Math.min(2, Math.max(0, options.requestTemperature))
      : 0.2;
  const appRoot =
    options?.appRoot ??
    resolveAmbientAppRoot({
      cwd: options?.cwd,
      env: effectiveEnv,
    });
  const exposedMcpTools = (options?.mcpTools ?? []).filter(
    tool => tool.enabled && tool.exposure !== "hidden"
  );
  const toolUsageSystemPrompt = buildToolUsageSystemPrompt(exposedMcpTools);
  const env = envSchema.safeParse({
    CYRENE_BASE_URL: effectiveEnv.CYRENE_BASE_URL,
    CYRENE_API_KEY: effectiveEnv.CYRENE_API_KEY,
    CYRENE_OPENAI_API_KEY: effectiveEnv.CYRENE_OPENAI_API_KEY,
    CYRENE_GEMINI_API_KEY: effectiveEnv.CYRENE_GEMINI_API_KEY,
    CYRENE_ANTHROPIC_API_KEY: effectiveEnv.CYRENE_ANTHROPIC_API_KEY,
    CYRENE_MODEL: effectiveEnv.CYRENE_MODEL,
  });

  const parsedEnv: ParsedHttpEnv = env.success
    ? env.data
    : {
        CYRENE_BASE_URL: undefined,
        CYRENE_API_KEY: undefined,
        CYRENE_OPENAI_API_KEY: undefined,
        CYRENE_GEMINI_API_KEY: undefined,
        CYRENE_ANTHROPIC_API_KEY: undefined,
        CYRENE_MODEL: undefined,
      };
  const baseUrl = parsedEnv.CYRENE_BASE_URL;
  let currentModel = env.success
    ? env.data.CYRENE_MODEL ??
      resolveDefaultModelForFamily(
        baseUrl ? resolveProviderFamily(baseUrl) : "openai"
      )
    : "gpt-4o-mini";
  let currentProvider = resolveProviderBaseUrl(baseUrl);
  let availableModels: string[] = [];
  let providerCatalog = currentProvider ? [currentProvider] : ([] as string[]);
  let providerProfileOverrides: ProviderProfileOverrideMap = {};
  let providerTypeOverrides: ProviderTypeOverrideMap = {};
  let providerModelModes: ProviderModelCatalogModeMap = {};
  let providerFormatOverrides: ProviderFormatOverrideMap = {};
  let providerEndpointOverrides: ProviderEndpointOverrideMap = {};
  let providerNameOverrides: ProviderNameOverrideMap = {};
  let initializationError: string | null = null;
  const sessionQueries = new Map<
    string,
    {
      query: string;
      provider: string;
      model: string;
      apiKey: string;
      family: ProviderFamily;
      format: TransportFormat;
      endpointOverrides: ProviderEndpointOverrideEntry;
      mcpTools: McpToolDescriptor[];
      systemPrompt: string;
    }
  >();
  const dedupeProviders = (providers: Array<string | undefined>) =>
    Array.from(new Set(providers.map(provider => resolveProviderBaseUrl(provider)).filter(Boolean))) as string[];
  const getProviderTypeOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerTypeOverrides[normalizedProvider] ?? null;
  };
  const setProviderTypeOverride = (
    provider: string | undefined,
    type: ProviderType | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (!type) {
      if (normalizedProvider in providerTypeOverrides) {
        const next = { ...providerTypeOverrides };
        delete next[normalizedProvider];
        providerTypeOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerTypeOverrides[normalizedProvider] === type) {
      return normalizedProvider;
    }
    providerTypeOverrides = {
      ...providerTypeOverrides,
      [normalizedProvider]: type,
    };
    return normalizedProvider;
  };
  const resolveFamilyForProvider = (provider: string | undefined): ProviderFamily => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return "openai";
    }
    const overrideType = getProviderTypeOverride(normalizedProvider);
    if (overrideType) {
      return resolveProviderTypeFamily(overrideType);
    }
    const overrideFamily = providerProfileOverrides[normalizedProvider];
    if (overrideFamily) {
      return overrideFamily;
    }
    return resolveProviderFamily(normalizedProvider);
  };
  const getProviderProfileOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerProfileOverrides[normalizedProvider] ?? null;
  };
  const setProviderProfileOverride = (
    provider: string | undefined,
    profile: ManualProviderProfile | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (!profile) {
      if (normalizedProvider in providerProfileOverrides) {
        const next = { ...providerProfileOverrides };
        delete next[normalizedProvider];
        providerProfileOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerProfileOverrides[normalizedProvider] === profile) {
      return normalizedProvider;
    }
    providerProfileOverrides = {
      ...providerProfileOverrides,
      [normalizedProvider]: profile,
    };
    return normalizedProvider;
  };
  const getProviderModelMode = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return "api" as const;
    }
    return providerModelModes[normalizedProvider] ?? "api";
  };
  const hasResolvedProviderModelMode = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return false;
    }
    return normalizedProvider in providerModelModes;
  };
  const setProviderModelMode = (
    provider: string | undefined,
    mode: ProviderModelCatalogMode
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (providerModelModes[normalizedProvider] === mode) {
      return normalizedProvider;
    }
    providerModelModes = {
      ...providerModelModes,
      [normalizedProvider]: mode,
    };
    return normalizedProvider;
  };
  const getProviderFormatOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerFormatOverrides[normalizedProvider] ?? null;
  };
  const resolveLegacyFormatForProvider = (
    provider: string | undefined,
    familyOverride?: ProviderFamily
  ): TransportFormat | null => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return (
      getProviderFormatOverride(normalizedProvider) ??
      resolveDefaultFormatForProvider(
        normalizedProvider,
        familyOverride ?? resolveFamilyForProvider(normalizedProvider)
      )
    );
  };
  const setProviderFormatOverride = (
    provider: string | undefined,
    format: TransportFormat | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (!format) {
      if (normalizedProvider in providerFormatOverrides) {
        const next = { ...providerFormatOverrides };
        delete next[normalizedProvider];
        providerFormatOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerFormatOverrides[normalizedProvider] === format) {
      return normalizedProvider;
    }
    providerFormatOverrides = {
      ...providerFormatOverrides,
      [normalizedProvider]: format,
    };
    return normalizedProvider;
  };
  const getProviderNameOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerNameOverrides[normalizedProvider] ?? null;
  };
  const cloneProviderEndpointOverrideEntry = (
    entry: ProviderEndpointOverrideEntry | undefined
  ): ProviderEndpointOverrideEntry => ({ ...(entry ?? {}) });
  const cloneProviderEndpointOverrideMap = (
    endpoints: ProviderEndpointOverrideMap
  ): ProviderEndpointOverrideMap =>
    Object.fromEntries(
      Object.entries(endpoints).map(([provider, entry]) => [
        provider,
        cloneProviderEndpointOverrideEntry(entry),
      ])
    );
  const getProviderEndpointOverrides = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return {};
    }
    return cloneProviderEndpointOverrideEntry(
      providerEndpointOverrides[normalizedProvider]
    );
  };
  const getProviderEndpointOverride = (
    provider: string | undefined,
    kind: ProviderEndpointKind
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerEndpointOverrides[normalizedProvider]?.[kind] ?? null;
  };
  const setProviderEndpointOverride = (
    provider: string | undefined,
    kind: ProviderEndpointKind,
    endpoint: string | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    const trimmedEndpoint = endpoint?.trim();
    const currentEntry = providerEndpointOverrides[normalizedProvider] ?? {};
    if (!trimmedEndpoint) {
      if (kind in currentEntry) {
        const nextEntry = { ...currentEntry };
        delete nextEntry[kind];
        if (Object.keys(nextEntry).length === 0) {
          const next = { ...providerEndpointOverrides };
          delete next[normalizedProvider];
          providerEndpointOverrides = next;
        } else {
          providerEndpointOverrides = {
            ...providerEndpointOverrides,
            [normalizedProvider]: nextEntry,
          };
        }
      }
      return normalizedProvider;
    }
    if (currentEntry[kind] === trimmedEndpoint) {
      return normalizedProvider;
    }
    providerEndpointOverrides = {
      ...providerEndpointOverrides,
      [normalizedProvider]: {
        ...currentEntry,
        [kind]: trimmedEndpoint,
      },
    };
    return normalizedProvider;
  };
  const setProviderNameOverride = (
    provider: string | undefined,
    name: string | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    const trimmedName = name?.trim();
    if (!trimmedName) {
      if (normalizedProvider in providerNameOverrides) {
        const next = { ...providerNameOverrides };
        delete next[normalizedProvider];
        providerNameOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerNameOverrides[normalizedProvider] === trimmedName) {
      return normalizedProvider;
    }
    providerNameOverrides = {
      ...providerNameOverrides,
      [normalizedProvider]: trimmedName,
    };
    return normalizedProvider;
  };
  const normalizeLoadedProviderProfiles = (
    profiles: Record<string, string | undefined> | undefined
  ): ProviderProfileOverrideMap => {
    const normalizedEntries: Array<[string, ManualProviderProfile]> = [];
    for (const [provider, profile] of Object.entries(profiles ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        continue;
      }
      if (!profile || !isManualProviderProfile(profile)) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, profile]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderProfileOverrideMap;
  };
  const normalizeLoadedProviderTypes = (
    types: Record<string, string | undefined> | undefined
  ): ProviderTypeOverrideMap => {
    const normalizedEntries: Array<[string, ProviderType]> = [];
    for (const [provider, type] of Object.entries(types ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider || !type || !isProviderType(type)) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, type]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderTypeOverrideMap;
  };
  const normalizeLoadedProviderFormats = (
    formats: Record<string, string | undefined> | undefined
  ): ProviderFormatOverrideMap => {
    const normalizedEntries: Array<[string, TransportFormat]> = [];
    for (const [provider, format] of Object.entries(formats ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider || !format || !isTransportFormat(format)) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, format]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderFormatOverrideMap;
  };
  const normalizeLoadedProviderModelModes = (
    modes: Record<string, string | undefined> | undefined
  ): ProviderModelCatalogModeMap => {
    const normalizedEntries: Array<[string, ProviderModelCatalogMode]> = [];
    for (const [provider, mode] of Object.entries(modes ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (
        !normalizedProvider ||
        (mode !== "api" && mode !== "manual")
      ) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, mode]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderModelCatalogModeMap;
  };
  const normalizeLoadedProviderNames = (
    names: Record<string, string | undefined> | undefined
  ): ProviderNameOverrideMap => {
    const normalizedEntries: Array<[string, string]> = [];
    for (const [provider, name] of Object.entries(names ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      const normalizedName = name?.trim();
      if (!normalizedProvider || !normalizedName) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, normalizedName]);
    }
    return Object.fromEntries(normalizedEntries);
  };
  const normalizeLoadedProviderEndpoints = (
    endpoints: ProviderEndpointOverrideMap | undefined
  ): ProviderEndpointOverrideMap => {
    const normalizedEntries: Array<[string, ProviderEndpointOverrideEntry]> = [];
    for (const [provider, entry] of Object.entries(endpoints ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        continue;
      }
      const normalizedEntry = Object.fromEntries(
        Object.entries(entry ?? {})
          .map(([kind, endpoint]) => {
            const trimmedEndpoint = endpoint?.trim();
            return isProviderEndpointKind(kind) && trimmedEndpoint
              ? ([kind, trimmedEndpoint] as const)
              : null;
          })
          .filter(
            (endpointEntry): endpointEntry is [ProviderEndpointKind, string] =>
              Boolean(endpointEntry)
          )
      ) as ProviderEndpointOverrideEntry;
      if (Object.keys(normalizedEntry).length === 0) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, normalizedEntry]);
    }
    return Object.fromEntries(normalizedEntries);
  };
  const resolvePersistedModels = () =>
    availableModels.length > 0
      ? [...availableModels]
      : currentModel.trim()
        ? [currentModel]
        : ["gpt-4o-mini"];
  const resolveTypeForProvider = (
    provider: string | undefined,
    familyOverride?: ProviderFamily,
    formatOverride?: TransportFormat
  ): ProviderType | null => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return (
      getProviderTypeOverride(normalizedProvider) ??
      inferProviderType({
        family: familyOverride ?? resolveFamilyForProvider(normalizedProvider),
        format:
          formatOverride ??
          resolveLegacyFormatForProvider(
            normalizedProvider,
            familyOverride ?? resolveFamilyForProvider(normalizedProvider)
          ) ??
          resolveDefaultFormatForProvider(normalizedProvider),
      })
    );
  };
  const resolveFormatForProvider = (
    provider: string | undefined,
    familyOverride?: ProviderFamily
  ): TransportFormat | null => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    const overrideType = getProviderTypeOverride(normalizedProvider);
    if (overrideType) {
      return resolveProviderTypeFormat(overrideType, normalizedProvider);
    }
    return resolveLegacyFormatForProvider(normalizedProvider, familyOverride);
  };
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
      providerProfiles: providerProfileOverrides,
      providerTypes: providerTypeOverrides,
      providerModelModes,
      providerFormats: providerFormatOverrides,
      providerEndpoints: providerEndpointOverrides,
      providerNames: providerNameOverrides,
    }, appRoot, {
      cwd: options?.cwd,
      env: effectiveEnv,
    });
  };

  const refreshFromApi = async (
    preferredModel?: string,
    providerOverride?: string
  ) => {
    const targetProvider = resolveProviderBaseUrl(providerOverride ?? currentProvider ?? baseUrl);
    const targetApiKey = resolveApiKeyForProvider(
      targetProvider,
      parsedEnv,
      resolveFamilyForProvider
    );
    if (!targetProvider || !targetApiKey) {
      throw new Error("Missing provider or API key. Use /provider and /login.");
    }
    const catalog = await fetchProviderModelCatalog({
      baseUrl: targetProvider,
      apiKey: targetApiKey,
      preferredModel,
      currentModel,
      familyOverride: resolveFamilyForProvider(targetProvider),
      endpointOverride: getProviderEndpointOverride(targetProvider, "models"),
    });
    const previousProviderModelModes = providerModelModes;
    setProviderModelMode(catalog.providerBaseUrl, catalog.catalogMode);
    try {
      await persistCatalog(
        catalog.models,
        catalog.selectedModel,
        catalog.providerBaseUrl
      );
    } catch (error) {
      providerModelModes = previousProviderModelModes;
      throw error;
    }
    availableModels = catalog.models;
    currentModel = catalog.selectedModel;
    currentProvider = catalog.providerBaseUrl;
    initializationError = null;

    return catalog.models;
  };

  const initializeModels = async () => {
    try {
      const local = await loadModelYaml(appRoot, {
        cwd: options?.cwd,
        env: effectiveEnv,
      });
      providerProfileOverrides = normalizeLoadedProviderProfiles(
        local.providerProfiles
      );
      providerTypeOverrides = normalizeLoadedProviderTypes(local.providerTypes);
      providerModelModes = normalizeLoadedProviderModelModes(
        local.providerModelModes
      );
      providerFormatOverrides = normalizeLoadedProviderFormats(
        local.providerFormats
      );
      providerEndpointOverrides = normalizeLoadedProviderEndpoints(
        local.providerEndpoints
      );
      providerNameOverrides = normalizeLoadedProviderNames(local.providerNames);
      const localProvider = resolveProviderBaseUrl(local.providerBaseUrl);
      providerCatalog = dedupeProviders([
        ...local.providers,
        ...Object.keys(providerProfileOverrides),
        ...Object.keys(providerTypeOverrides),
        ...Object.keys(providerModelModes),
        ...Object.keys(providerFormatOverrides),
        ...Object.keys(providerEndpointOverrides),
        ...Object.keys(providerNameOverrides),
        localProvider,
        currentProvider,
      ]);
      const providerChanged =
        Boolean(currentProvider) &&
        Boolean(localProvider) &&
        localProvider !== currentProvider;
      if (providerChanged) {
        await refreshFromApi(
          local.lastUsedModel ?? local.defaultModel ?? currentModel,
          currentProvider
        );
        return;
      }
      currentProvider = currentProvider ?? localProvider;
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
    describeProvider: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return {
          provider: "none",
          vendor: "none",
          keySource: "none",
        };
      }
      const family = resolveFamilyForProvider(normalizedProvider);
      const keySource = resolveApiKeySourceForProvider(
        normalizedProvider,
        parsedEnv,
        resolveFamilyForProvider
      );
      const vendor = family === "glm" ? "custom" : family;
      const format = resolveFormatForProvider(normalizedProvider, family) ?? undefined;
      return {
        provider: normalizedProvider,
        vendor,
        keySource,
        type:
          family === "glm"
            ? undefined
            : (resolveTypeForProvider(normalizedProvider, family, format) ?? undefined),
        format,
      };
    },
    setProviderProfile: async (provider: string, profile: ProviderProfile) => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const normalizedProfile = profile.trim().toLowerCase();
      const isCustomProfile = normalizedProfile === "custom";
      if (!isCustomProfile && !isManualProviderProfile(normalizedProfile)) {
        return {
          ok: false,
          message:
            "Profile must be one of: openai, gemini, anthropic, custom.",
        };
      }

      const previousOverrides = providerProfileOverrides;
      const previousTypeOverrides = providerTypeOverrides;
      const previousProvider = currentProvider;
      const previousModel = currentModel;
      const previousModels = [...availableModels];
      const previousProviderCatalog = [...providerCatalog];

      setProviderTypeOverride(normalizedProvider, null);
      setProviderProfileOverride(
        normalizedProvider,
        isCustomProfile ? null : normalizedProfile
      );
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        if (currentProvider === normalizedProvider) {
          await refreshFromApi(undefined, normalizedProvider);
        } else {
          await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
        }
      } catch (error) {
        providerProfileOverrides = previousOverrides;
        providerTypeOverrides = previousTypeOverrides;
        currentProvider = previousProvider;
        currentModel = previousModel;
        availableModels = previousModels;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider profile: ${error.message}`
              : `Failed to apply provider profile: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderProfileOverride(normalizedProvider);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider profile override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider profile override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        profile: appliedOverride ?? "custom",
      };
    },
    getProviderProfile: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return getProviderProfileOverride(normalizedProvider) ?? "custom";
    },
    listProviderProfiles: () => ({ ...providerProfileOverrides }),
    setProviderType: async (
      provider: string,
      type: ProviderType | null
    ): Promise<ProviderTypeSetResult> => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const normalizedType =
        typeof type === "string" && type.trim()
          ? (type.trim().toLowerCase() as ProviderType)
          : null;
      if (normalizedType && !isProviderType(normalizedType)) {
        return {
          ok: false,
          message:
            "Provider type must be one of: openai-compatible, openai-responses, gemini, anthropic.",
        };
      }

      const previousTypeOverrides = providerTypeOverrides;
      const previousProfileOverrides = providerProfileOverrides;
      const previousFormatOverrides = providerFormatOverrides;
      const previousProvider = currentProvider;
      const previousModel = currentModel;
      const previousModels = [...availableModels];
      const previousProviderCatalog = [...providerCatalog];

      if (normalizedType) {
        setProviderProfileOverride(normalizedProvider, null);
        setProviderFormatOverride(normalizedProvider, null);
      }
      setProviderTypeOverride(normalizedProvider, normalizedType);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        if (currentProvider === normalizedProvider) {
          await refreshFromApi(undefined, normalizedProvider);
        } else {
          await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
        }
      } catch (error) {
        providerTypeOverrides = previousTypeOverrides;
        providerProfileOverrides = previousProfileOverrides;
        providerFormatOverrides = previousFormatOverrides;
        currentProvider = previousProvider;
        currentModel = previousModel;
        availableModels = previousModels;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider type: ${error.message}`
              : `Failed to apply provider type: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderTypeOverride(normalizedProvider);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider type override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider type override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        type:
          appliedOverride ??
          resolveDefaultTypeForProvider(
            normalizedProvider,
            resolveFamilyForProvider(normalizedProvider)
          ) ??
          undefined,
      };
    },
    getProviderType: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return resolveTypeForProvider(normalizedProvider);
    },
    listProviderTypes: () => ({ ...providerTypeOverrides }),
    setProviderFormat: async (
      provider: string,
      format: TransportFormat | null
    ): Promise<ProviderFormatSetResult> => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const normalizedFormat =
        typeof format === "string" && format.trim()
          ? (format.trim().toLowerCase() as TransportFormat)
          : null;
      if (normalizedFormat && !isTransportFormat(normalizedFormat)) {
        return {
          ok: false,
          message:
            "Format must be one of: openai_chat, openai_responses, anthropic_messages, gemini_generate_content.",
        };
      }

      const previousOverrides = providerFormatOverrides;
      const previousTypeOverrides = providerTypeOverrides;
      const previousProviderCatalog = [...providerCatalog];

      setProviderTypeOverride(normalizedProvider, null);
      setProviderFormatOverride(normalizedProvider, normalizedFormat);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
      } catch (error) {
        providerFormatOverrides = previousOverrides;
        providerTypeOverrides = previousTypeOverrides;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider format: ${error.message}`
              : `Failed to apply provider format: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderFormatOverride(normalizedProvider);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider format override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider format override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        format:
          appliedOverride ??
          resolveDefaultFormatForProvider(
            normalizedProvider,
            resolveFamilyForProvider(normalizedProvider)
          ),
      };
    },
    getProviderFormat: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return resolveFormatForProvider(normalizedProvider);
    },
    listProviderFormats: () => ({ ...providerFormatOverrides }),
    setProviderEndpoint: async (
      provider: string,
      kind: ProviderEndpointKind,
      endpoint: string | null
    ): Promise<ProviderEndpointSetResult> => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }
      if (!isProviderEndpointKind(kind)) {
        return {
          ok: false,
          message:
            "Endpoint kind must be one of: responses, chat_completions, models, anthropic_messages, gemini_generate_content.",
        };
      }

      const trimmedEndpoint = endpoint?.trim() ?? "";
      if (trimmedEndpoint.includes(" ")) {
        return {
          ok: false,
          message:
            "Endpoint override must be a single path or absolute URL without spaces.",
        };
      }
      if (trimmedEndpoint) {
        try {
          switch (kind) {
            case "responses":
              resolveResponsesUrls(normalizedProvider, trimmedEndpoint);
              break;
            case "chat_completions":
              resolveChatCompletionsUrl(normalizedProvider, trimmedEndpoint);
              break;
            case "models":
              resolveModelsUrl(normalizedProvider, trimmedEndpoint);
              break;
            case "anthropic_messages":
              resolveAnthropicMessagesUrl(normalizedProvider, trimmedEndpoint);
              break;
            case "gemini_generate_content":
              resolveGeminiGenerateContentUrl(
                normalizedProvider,
                currentModel || resolveDefaultModelForFamily(resolveFamilyForProvider(normalizedProvider)),
                trimmedEndpoint
              );
              break;
          }
        } catch (error) {
          return {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : `Invalid endpoint override: ${String(error)}`,
          };
        }
      }

      const previousOverrides = providerEndpointOverrides;
      const previousProviderCatalog = [...providerCatalog];

      setProviderEndpointOverride(normalizedProvider, kind, trimmedEndpoint || null);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
      } catch (error) {
        providerEndpointOverrides = previousOverrides;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider endpoint: ${error.message}`
              : `Failed to apply provider endpoint: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderEndpointOverride(normalizedProvider, kind);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider ${kind} endpoint override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider ${kind} endpoint override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        kind,
        endpoint: appliedOverride ?? undefined,
      };
    },
    getProviderEndpoint: (
      provider: string | undefined,
      kind: ProviderEndpointKind
    ) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider || !isProviderEndpointKind(kind)) {
        return null;
      }
      return getProviderEndpointOverride(normalizedProvider, kind);
    },
    listProviderEndpoints: () =>
      cloneProviderEndpointOverrideMap(providerEndpointOverrides),
    setProviderName: async (provider: string, name: string | null) => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const previousOverrides = providerNameOverrides;
      const previousProviderCatalog = [...providerCatalog];
      const trimmedName = name?.trim() ?? "";

      setProviderNameOverride(normalizedProvider, trimmedName || null);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
      } catch (error) {
        providerNameOverrides = previousOverrides;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to save provider name: ${error.message}`
              : `Failed to save provider name: ${String(error)}`,
        };
      }

      return {
        ok: true,
        message: trimmedName
          ? `Provider name set: ${normalizedProvider} => ${trimmedName}`
          : `Provider name cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        name: trimmedName || undefined,
      };
    },
    getProviderName: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return getProviderNameOverride(normalizedProvider);
    },
    listProviderNames: () => ({ ...providerNameOverrides }),
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
      let manualModelMode = getProviderModelMode(currentProvider) === "manual";
      if (
        !manualModelMode &&
        !availableModels.includes(next) &&
        hasResolvedProviderModelMode(currentProvider) === false &&
        currentProvider
      ) {
        try {
          await refreshFromApi(next, currentProvider);
          manualModelMode = getProviderModelMode(currentProvider) === "manual";
        } catch {
          manualModelMode = false;
        }
      }
      if (!availableModels.includes(next) && !manualModelMode) {
        return {
          ok: false,
          message: `Model "${next}" is not in model catalog.`,
        };
      }
      const previousModel = currentModel;
      const previousModels = [...availableModels];
      if (!availableModels.includes(next)) {
        availableModels = [...availableModels, next];
      }
      currentModel = next;
      try {
        await persistCatalog(availableModels, next, currentProvider);
      } catch (error) {
        currentModel = previousModel;
        availableModels = previousModels;
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
      providerCatalog = dedupeProviders([
        ...providerCatalog,
        ...Object.keys(providerProfileOverrides),
        ...Object.keys(providerTypeOverrides),
        ...Object.keys(providerFormatOverrides),
        ...Object.keys(providerEndpointOverrides),
        ...Object.keys(providerNameOverrides),
        currentProvider,
      ]);
      return [...providerCatalog];
    },
    setProvider: async (provider: string) => {
      await modelInit;
      let nextProvider: string;
      try {
        nextProvider = normalizeProviderBaseUrl(provider.trim());
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const providerApiKey = resolveApiKeyForProvider(
        nextProvider,
        parsedEnv,
        resolveFamilyForProvider
      );
      if (!providerApiKey) {
        return {
          ok: false,
          message:
            "Missing API key for selected provider. Set CYRENE_API_KEY (or provider-specific key).",
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
    requestStreamUrl: async (query: string) => {
      await modelInit;
      const targetProvider = currentProvider ?? resolveProviderBaseUrl(baseUrl);
      if (!targetProvider) {
        throw new Error(
          "Missing CYRENE_BASE_URL (or /provider) for HTTP transport."
        );
      }
      const targetApiKey = resolveApiKeyForProvider(
        targetProvider,
        parsedEnv,
        resolveFamilyForProvider
      );
      if (!targetApiKey) {
        throw new Error(
          "Missing API key for current provider. Use /login or set provider-specific key env."
        );
      }
      if (initializationError && availableModels.length === 0) {
        throw new Error(
          `Model initialization failed: ${initializationError}. Run /model refresh after fixing API/base URL.`
        );
      }
      const providerFamily = resolveFamilyForProvider(targetProvider);
      const providerFormat =
        resolveFormatForProvider(targetProvider, providerFamily) ??
        resolveDefaultFormatForProvider(targetProvider, providerFamily);
      const modelForRequest =
        currentModel || resolveDefaultModelForFamily(providerFamily);
      const sessionId = crypto.randomUUID();
      sessionQueries.set(sessionId, {
        query,
        provider: targetProvider,
        model: modelForRequest,
        apiKey: targetApiKey,
        family: providerFamily,
        format: providerFormat,
        endpointOverrides: getProviderEndpointOverrides(targetProvider),
        mcpTools: exposedMcpTools,
        systemPrompt: toolUsageSystemPrompt,
      });
      return `openai://${sessionId}`;
    },
    stream: async function* (streamUrl: string) {
      const sessionId = streamUrl.replace("openai://", "");
      const session = sessionQueries.get(sessionId);
      sessionQueries.delete(sessionId);

      if (!session) {
        throw new Error("Invalid HTTP stream session.");
      }

      if (session.format === "anthropic_messages") {
        for await (const event of streamSseAnthropic(
          session.provider,
          session.apiKey,
          session.model,
          session.query,
          {
            temperature: requestTemperature,
            endpointOverride: session.endpointOverrides.anthropic_messages,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
          }
        )) {
          yield event;
        }
        return;
      }

      if (session.format === "openai_responses") {
        for await (const event of streamSseOpenAIResponses(
          session.provider,
          session.apiKey,
          session.model,
          session.query,
          {
            temperature: requestTemperature,
            family: session.family,
            endpointOverride: session.endpointOverrides.responses,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
          }
        )) {
          yield event;
        }
        return;
      }

      if (session.format === "gemini_generate_content") {
        for await (const event of streamSseGeminiGenerateContent(
          session.provider,
          session.apiKey,
          session.model,
          session.query,
          {
            temperature: requestTemperature,
            endpointOverride: session.endpointOverrides.gemini_generate_content,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
          }
        )) {
          yield event;
        }
        return;
      }

      for await (const event of streamSseOpenAI(
        session.provider,
        session.apiKey,
        session.model,
        session.query,
          {
            includeReasoning: includeReasoningInTranscript,
            temperature: requestTemperature,
            family: session.family,
            endpointOverride: session.endpointOverrides.chat_completions,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
          }
        )) {
          yield event;
        }
    },
  };
};
