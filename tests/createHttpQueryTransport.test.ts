import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMcpService } from "../src/core/mcp";
import { parseStreamChunk } from "../src/core/query/streamProtocol";
import {
  FILE_TOOL,
  TOOL_USAGE_SYSTEM_PROMPT,
  createHttpQueryTransport,
  normalizeProviderBaseUrl,
} from "../src/infra/http/createHttpQueryTransport";
import { resetConfiguredAppRoot, setConfiguredAppRoot } from "../src/infra/config/appRoot";

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];
const tempServices: FileMcpService[] = [];

const createTransport = (
  options: {
    appRoot: string;
    cyreneHome?: string;
    cwd?: string;
    env?: Partial<NodeJS.ProcessEnv>;
    requestTemperature?: number;
  }
) => {
  const env: NodeJS.ProcessEnv = {
    CYRENE_BASE_URL: undefined,
    CYRENE_API_KEY: undefined,
    CYRENE_MODEL: undefined,
    CYRENE_ROOT: options.appRoot,
    CYRENE_HOME: options.cyreneHome ?? join(options.appRoot, ".cyrene"),
    ...options.env,
  };
  return createHttpQueryTransport({
    appRoot: options.appRoot,
    cwd: options.cwd ?? options.appRoot,
    env,
    requestTemperature: options.requestTemperature,
  });
};

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-http-transport-test-"));
  tempRoots.push(root);
  const cyreneHome = join(root, ".cyrene");
  await mkdir(cyreneHome, { recursive: true });
  return {
    root,
    cyreneHome,
    modelFile: join(cyreneHome, "model.yaml"),
  };
};

const createRelaxedFileService = (root: string) => {
  const service = new FileMcpService({
    workspaceRoot: root,
    maxReadBytes: 1024 * 1024,
    requireReview: [
      "delete_file",
      "copy_path",
      "move_path",
      "run_command",
      "run_shell",
      "open_shell",
      "write_shell",
    ],
  });
  tempServices.push(service);
  return service;
};

const collectParsedStreamEvents = async (
  transport: ReturnType<typeof createTransport>,
  query: string
) => {
  const streamUrl = await transport.requestStreamUrl(query);
  const events: ReturnType<typeof parseStreamChunk>[number][] = [];
  for await (const chunk of transport.stream(streamUrl)) {
    events.push(...parseStreamChunk(chunk));
  }
  return events;
};

afterEach(async () => {
  resetConfiguredAppRoot();
  for (const service of tempServices.splice(0)) {
    service.dispose();
  }
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("createHttpQueryTransport tool exposure", () => {
  test("exports expanded file tool schema", () => {
    const actionEnum = FILE_TOOL.function.parameters.properties.action.enum;

    expect(actionEnum).toContain("run_command");
    expect(actionEnum).toContain("run_shell");
    expect(actionEnum).toContain("open_shell");
    expect(actionEnum).toContain("write_shell");
    expect(actionEnum).toContain("read_shell");
    expect(actionEnum).toContain("shell_status");
    expect(actionEnum).toContain("interrupt_shell");
    expect(actionEnum).toContain("close_shell");
    expect(actionEnum).toContain("read_files");
    expect(actionEnum).toContain("read_range");
    expect(actionEnum).toContain("read_json");
    expect(actionEnum).toContain("read_yaml");
    expect(actionEnum).toContain("stat_path");
    expect(actionEnum).toContain("stat_paths");
    expect(actionEnum).toContain("outline_file");
    expect(actionEnum).toContain("find_files");
    expect(actionEnum).toContain("find_symbol");
    expect(actionEnum).toContain("find_references");
    expect(actionEnum).toContain("search_text");
    expect(actionEnum).toContain("search_text_context");
    expect(actionEnum).toContain("copy_path");
    expect(actionEnum).toContain("move_path");
    expect(actionEnum).toContain("git_status");
    expect(actionEnum).toContain("git_diff");
    expect(actionEnum).toContain("git_log");
    expect(actionEnum).toContain("git_show");
    expect(actionEnum).toContain("git_blame");
    expect(actionEnum).toContain("ts_hover");
    expect(actionEnum).toContain("ts_definition");
    expect(actionEnum).toContain("ts_references");
    expect(actionEnum).toContain("ts_diagnostics");
    expect(actionEnum).toContain("ts_prepare_rename");
    expect(actionEnum).toContain("lsp_hover");
    expect(actionEnum).toContain("lsp_definition");
    expect(actionEnum).toContain("lsp_implementation");
    expect(actionEnum).toContain("lsp_type_definition");
    expect(actionEnum).toContain("lsp_references");
    expect(actionEnum).toContain("lsp_workspace_symbols");
    expect(actionEnum).toContain("lsp_document_symbols");
    expect(actionEnum).toContain("lsp_diagnostics");
    expect(actionEnum).toContain("lsp_prepare_rename");
    expect(actionEnum).toContain("lsp_rename");
    expect(actionEnum).toContain("lsp_code_actions");
    expect(actionEnum).toContain("lsp_format_document");
    expect(actionEnum).toContain("apply_patch");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("paths");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("startLine");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("endLine");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("line");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("column");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("newName");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("serverId");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("title");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("kind");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("tabSize");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("insertSpaces");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("jsonPath");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("yamlPath");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("pattern");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("symbol");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("query");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("before");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("after");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("destination");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("revision");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("command");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("input");
  });

  test("system prompt teaches model about search and command actions", () => {
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("read_files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("read_range");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("read_json");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("read_yaml");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("find_files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("find_symbol");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("find_references");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("search_text");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("search_text_context");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("stat_path");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("stat_paths");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("outline_file");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("git_status");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("git_diff");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("git_log");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("git_show");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("git_blame");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("ts_hover");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("ts_definition");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("ts_references");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("ts_diagnostics");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("ts_prepare_rename");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_hover");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_definition");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_implementation");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_type_definition");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_references");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_workspace_symbols");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_document_symbols");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_diagnostics");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_prepare_rename");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_rename");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_code_actions");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("lsp_format_document");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("apply_patch");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("run_command");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("run_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("open_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("write_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("read_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("shell_status");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("interrupt_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("close_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_files when you already know multiple exact file paths");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("output exactly one valid `file` tool call and nothing else");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not output XML tags");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not guess missing required arguments");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("correct the exact schema error");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_range when you need a specific line window");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_json for JSON configuration files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_yaml for YAML configuration files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use stat_paths when you need existence or metadata for several exact paths");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use outline_file before full reads on large source files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use find_symbol when you need to locate symbol definitions");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use find_references when you need cross-file symbol usages");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use ts_hover for TypeScript/JavaScript quick info");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use ts_definition for TypeScript/JavaScript definition lookup");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use ts_references for semantic TypeScript/JavaScript references");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "Prefer lsp_diagnostics for TypeScript/JavaScript diagnostics when a matching LSP server is configured"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use ts_diagnostics for TypeScript/JavaScript diagnostics");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use ts_prepare_rename to preview a semantic TypeScript/JavaScript rename");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_hover for generic language-server hover info");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_definition for generic language-server definition lookup");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_implementation for generic language-server implementation lookup");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_type_definition for generic language-server type-definition lookup");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_references for generic language-server references");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_workspace_symbols for generic language-server workspace symbol search");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_document_symbols for generic language-server document symbols");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_diagnostics for generic language-server diagnostics");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_prepare_rename to preview a generic language-server rename");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_rename to apply a reviewed generic language-server rename");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_code_actions to list available generic language-server code actions");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use lsp_format_document to apply reviewed generic language-server formatting edits");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use search_text_context when surrounding lines around each match matter");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use git_log to inspect recent commits");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use git_show to inspect one revision in detail");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use git_blame to inspect who last changed specific lines");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_files, set `path` to the first file");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_file, provide `path` only. Do not send `paths`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For stat_paths, set `path` to the first target");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For stat_path, provide `path` only. Do not send `paths`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_range, provide 1-based inclusive `startLine` and `endLine`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_json, provide `jsonPath` only when you want one nested field");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_yaml, provide `yamlPath` only when you want one nested field");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For find_symbol, provide the exact symbol name in `symbol`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For find_references, provide the exact symbol name in `symbol`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, and lsp_references, provide exact 1-based `line` and `column`"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For lsp_workspace_symbols, provide a non-empty `query`, a relevant `path` such as `.` or a matching file, and optional `serverId`"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For ts_diagnostics, provide a TS/JS file path");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For ts_prepare_rename, provide exact 1-based `line`, `column`, and a non-empty `newName`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For lsp_document_symbols and lsp_diagnostics, provide a file path and optional `serverId`"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For lsp_prepare_rename, provide exact 1-based `line`, `column`, a non-empty `newName`, and optional `serverId`"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For lsp_rename, provide exact 1-based `line`, `column`, a non-empty `newName`, and optional `serverId`"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For lsp_code_actions, provide exact 1-based `line` and `column`, optional `kind`, and optional `title` only when you want to apply one matching action"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "For lsp_format_document, provide a file path and optional `serverId`, `tabSize`, or `insertSpaces`"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For git_log, use `maxResults` to limit how many commits");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For git_show, use `revision`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For git_blame, provide a file path");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For write_file, provide `content` with the full desired file body");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For edit_file and apply_patch, provide both `find` and `replace`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use apply_patch for targeted patches");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not put shell syntax");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("When a persistent shell may already exist, call shell_status before opening another one");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use open_shell and write_shell when shell state must persist across steps");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("open_shell opens a persistent shell directly after local validation succeeds");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use write_shell only after open_shell has created an active shell session");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Low-risk write_shell inputs");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Medium-risk write_shell inputs still require review");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use close_shell to terminate the active persistent shell session");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Avoid repetitive list_dir/read_file probing");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("confirmed directory state");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not repeat the same tool call with the same input");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not send read_file together with `paths`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Choose the narrowest action");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("If the user asked to create files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Stop exploring once you have enough information to act");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("If read_file returns `(empty file)`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain(
      "After successful create_file, write_file, edit_file, or apply_patch, treat that result as a confirmed mutation"
    );
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain('set `path` to `"."`');
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Omit every optional field you do not need");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("`args` is only for run_command");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Match the user's language for all progress and final responses");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not mix languages in the same response");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Keep pre-tool narration concise");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Avoid repetitive phrases that restate the same plan");
  });
});

describe("createHttpQueryTransport streaming usage", () => {
  test("requests include_usage and emits normalized usage events", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"hello"}}]}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":9}}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });
    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];

    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body));
    expect(requestBody.temperature).toBe(0.2);
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 11,
        cachedTokens: 9,
        completionTokens: 5,
        totalTokens: 16,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("dedupes repeated usage snapshots while preserving later updates", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"hello"}}]}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":0,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":9}}}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":0,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":9}}}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":9}}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(
      async () =>
        new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        })
    ) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });
    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];

    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 11,
        cachedTokens: 9,
        completionTokens: 0,
        totalTokens: 11,
      }),
      JSON.stringify({
        type: "usage",
        promptTokens: 11,
        cachedTokens: 9,
        completionTokens: 5,
        totalTokens: 16,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("prefers output_text over plain text parts in structured content array chunks", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":[{"type":"text","text":"thinking "},{"type":"output_text","text":"visible"}]}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(
      async () =>
        new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        })
    ) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
      },
    });
    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];

    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "visible" }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("request body uses the configured request temperature", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(["data: [DONE]", ""].join("\n"))
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      requestTemperature: 0.35,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });
    const streamUrl = await transport.requestStreamUrl("hello");

    for await (const _event of transport.stream(streamUrl)) {
      // exhaust stream
    }

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body));
    expect(requestBody.temperature).toBe(0.35);
  });

  test("ignores reasoning_content and thinking fields by default", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"reasoning_content":"plan: inspect "}}]}',
              "",
              'data: {"choices":[{"delta":{"thinking":{"text":"then patch"}}}]}',
              "",
              'data: {"choices":[{"delta":{"reasoning":[{"type":"reasoning_text","text":" now"}]}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(
      async () =>
        new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        })
    ) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
      },
    });
    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];

    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(events).toEqual([JSON.stringify({ type: "done" })]);
  });

  test("can include reasoning_content and thinking fields when explicitly enabled", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"reasoning_content":"plan: inspect "}}]}',
              "",
              'data: {"choices":[{"delta":{"thinking":{"text":"then patch"}}}]}',
              "",
              'data: {"choices":[{"delta":{"reasoning":[{"type":"reasoning_text","text":" now"}]}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(
      async () =>
        new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        })
    ) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_STREAM_REASONING: "1",
      },
    });
    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];

    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "plan: inspect " }),
      JSON.stringify({ type: "text_delta", text: "then patch" }),
      JSON.stringify({ type: "text_delta", text: " now" }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("setModel persists the most recently used model for next startup", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "models:",
        "  - gpt-test",
        "  - gpt-next",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({ appRoot: root, cyreneHome });

    expect(await transport.listModels()).toEqual(["gpt-test", "gpt-next"]);
    expect(await transport.setModel("gpt-next")).toEqual({
      ok: true,
      message: "Model switched to: gpt-next",
    });
    expect(transport.getModel()).toBe("gpt-next");

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("default_model: gpt-next");
    expect(persisted).toContain("last_used_model: gpt-next");

    const restartedTransport = createTransport({ appRoot: root, cyreneHome });
    expect(await restartedTransport.listModels()).toEqual(["gpt-test", "gpt-next"]);
    expect(restartedTransport.getModel()).toBe("gpt-next");
  });

  test("providers without /models fall back to manual model mode and still stream", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: codex-mini",
        "last_used_model: codex-mini",
        "provider_base_url: https://rawchat.cn/codex",
        "models:",
        "  - codex-mini",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"ok"}}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://rawchat.cn/codex/v1/models") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://rawchat.cn/codex/v1/chat/completions") {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://rawchat.cn/codex",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "codex-mini",
      },
    });

    expect(await transport.listModels()).toEqual(["codex-mini"]);
    expect(transport.getModel()).toBe("codex-mini");
    expect(transport.getProviderFormat?.()).toBe("openai_chat");
    expect(await transport.refreshModels()).toEqual({
      ok: true,
      message: "Model list refreshed: 1 models",
      models: ["codex-mini"],
    });

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls[0]?.url).toBe("https://rawchat.cn/codex/v1/models");
    expect(fetchCalls[1]?.url).toBe(
      "https://rawchat.cn/codex/v1/chat/completions"
    );
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "ok" }),
      JSON.stringify({ type: "done" }),
    ]);

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_model_modes:");
    expect(persisted).toContain("  - provider: https://rawchat.cn/codex");
    expect(persisted).toContain("    mode: manual");
  });

  test("manual model mode lets setModel add arbitrary models and persist them", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: codex-mini",
        "last_used_model: codex-mini",
        "provider_base_url: https://rawchat.cn/codex",
        "provider_model_modes:",
        "  - provider: https://rawchat.cn/codex",
        "    mode: manual",
        "models:",
        "  - codex-mini",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://rawchat.cn/codex",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "codex-mini",
      },
    });

    expect(await transport.listModels()).toEqual(["codex-mini"]);
    expect(await transport.setModel("codex-max")).toEqual({
      ok: true,
      message: "Model switched to: codex-max",
    });
    expect(await transport.listModels()).toEqual(["codex-mini", "codex-max"]);

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("default_model: codex-max");
    expect(persisted).toContain("last_used_model: codex-max");
    expect(persisted).toContain("  - codex-mini");
    expect(persisted).toContain("  - codex-max");
    expect(persisted).toContain("provider_model_modes:");
    expect(persisted).toContain("    mode: manual");
  });

  test("model catalog follows CYRENE_HOME instead of current cwd", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const cwdElsewhere = await mkdtemp(join(tmpdir(), "cyrene-http-cwd-"));
    tempRoots.push(cwdElsewhere);

    await writeFile(
      modelFile,
      [
        "default_model: gpt-root",
        "last_used_model: gpt-root",
        "models:",
        "  - gpt-root",
        "  - gpt-alt",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createHttpQueryTransport({
      cwd: cwdElsewhere,
      env: {
        CYRENE_HOME: cyreneHome,
        CYRENE_ROOT: root,
      },
    });

    expect(await transport.listModels()).toEqual(["gpt-root", "gpt-alt"]);
    expect(transport.getModel()).toBe("gpt-root");
  });

  test("explicit appRoot ignores an unrelated configured app root", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "cyrene-http-other-root-"));
    tempRoots.push(unrelatedRoot);
    await mkdir(join(unrelatedRoot, ".cyrene"), { recursive: true });
    await writeFile(
      join(unrelatedRoot, ".cyrene", "model.yaml"),
      [
        "default_model: wrong-model",
        "last_used_model: wrong-model",
        "models:",
        "  - wrong-model",
        "",
      ].join("\n"),
      "utf8"
    );
    setConfiguredAppRoot(unrelatedRoot);

    await writeFile(
      modelFile,
      [
        "default_model: right-model",
        "last_used_model: right-model",
        "models:",
        "  - right-model",
        "  - right-fast",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({ appRoot: root, cyreneHome });

    expect(await transport.listModels()).toEqual(["right-model", "right-fast"]);
    expect(transport.getModel()).toBe("right-model");
  });

  test("provider change refreshes catalog before restoring current model", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: old-a",
        "last_used_model: old-b",
        "provider_base_url: https://provider-a.test/v1",
        "models:",
        "  - old-a",
        "  - old-b",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: string[] = [];
    const fetchMock = mock(async (url: string) => {
      fetchCalls.push(url);
      return new Response(
        JSON.stringify({
          data: [{ id: "new-main" }, { id: "new-fast" }],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://provider-b.test/v1",
        CYRENE_API_KEY: "test-key",
      },
    });

    expect(await transport.listModels()).toEqual(["new-main", "new-fast"]);
    expect(fetchCalls).toEqual(["https://provider-b.test/v1/models"]);
    expect(transport.getModel()).toBe("new-main");

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_base_url: https://provider-b.test/v1");
    expect(persisted).toContain("default_model: new-main");
    expect(persisted).toContain("last_used_model: new-main");
  });

  test("lists saved providers and switches to a selected provider", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: alpha-main",
        "last_used_model: alpha-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "  - https://provider-b.test/v1",
        "models:",
        "  - alpha-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return new Response(
        JSON.stringify({
          data: [{ id: "beta-main" }, { id: "beta-fast" }],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "test-key",
      },
    });

    expect(await transport.listProviders()).toEqual([
      "https://provider-a.test/v1",
      "https://provider-b.test/v1",
    ]);
    expect(transport.getProvider()).toBe("https://provider-a.test/v1");

    expect(await transport.setProvider("https://provider-b.test/v1")).toEqual({
      ok: true,
      message: "Provider switched to: https://provider-b.test/v1\nCurrent model: beta-main",
      currentProvider: "https://provider-b.test/v1",
      providers: ["https://provider-a.test/v1", "https://provider-b.test/v1"],
      models: ["beta-main", "beta-fast"],
    });
    expect(fetchCalls).toEqual(["https://provider-b.test/v1/models"]);
    expect(transport.getProvider()).toBe("https://provider-b.test/v1");
    expect(await transport.listModels()).toEqual(["beta-main", "beta-fast"]);

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_base_url: https://provider-b.test/v1");
    expect(persisted).toContain("providers:");
    expect(persisted).toContain("  - https://provider-a.test/v1");
    expect(persisted).toContain("  - https://provider-b.test/v1");
  });

  test("normalizes provider presets for openai/gemini/anthropic", () => {
    expect(normalizeProviderBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(normalizeProviderBaseUrl("gemini")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    expect(normalizeProviderBaseUrl("anthropic")).toBe(
      "https://api.anthropic.com"
    );
  });

  test("repairs provider URLs missing the scheme colon", () => {
    expect(normalizeProviderBaseUrl("https//rawchat.cn/codex")).toBe(
      "https://rawchat.cn/codex"
    );
    expect(normalizeProviderBaseUrl("http//relay.test/api")).toBe(
      "http://relay.test/api"
    );
  });

  test("describeProvider reports vendor and key source", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://api.openai.com/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_OPENAI_API_KEY: "openai-key",
        CYRENE_GEMINI_API_KEY: "gemini-key",
      },
    });

    await transport.listModels();
    expect(transport.describeProvider?.()).toEqual({
      provider: "https://api.openai.com/v1",
      vendor: "openai",
      keySource: "CYRENE_OPENAI_API_KEY",
      type: "openai-compatible",
      format: "openai_chat",
    });
    expect(transport.describeProvider?.("gemini")).toEqual({
      provider: "https://generativelanguage.googleapis.com/v1beta/openai",
      vendor: "gemini",
      keySource: "CYRENE_GEMINI_API_KEY",
      type: "gemini",
      format: "openai_chat",
    });
  });

  test("detects glm providers, reuses the generic key, and calls GLM endpoints", async () => {
    const { root, cyreneHome } = await createWorkspace();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"glm"}}]}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"prompt_tokens_details":{"cached_tokens":18}}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "glm-4-flash" }],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
      if (url.endsWith("/chat/completions")) {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
        CYRENE_API_KEY: "glm-key",
      },
    });

    expect(await transport.listModels()).toEqual(["glm-4-flash"]);
    expect(transport.getModel()).toBe("glm-4-flash");
    expect(transport.describeProvider?.()).toEqual({
      provider: "https://open.bigmodel.cn/api/paas/v4",
      vendor: "custom",
      keySource: "CYRENE_API_KEY",
      format: "openai_chat",
    });

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls[0]?.url).toBe("https://open.bigmodel.cn/api/paas/v4/models");
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string>)?.Authorization
    ).toBe("Bearer glm-key");
    expect(fetchCalls[1]?.url).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    );
    expect(
      (fetchCalls[1]?.init?.headers as Record<string, string>)?.Authorization
    ).toBe("Bearer glm-key");
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "glm" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 20,
        cachedTokens: 18,
        completionTokens: 4,
        totalTokens: 24,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("setProvider accepts gemini preset and uses provider-specific API key", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://api.openai.com/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [{ id: "gemini-2.5-pro" }, { id: "gemini-2.5-flash" }],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_GEMINI_API_KEY: "gemini-key",
      },
    });

    const result = await transport.setProvider("gemini");
    expect(result.ok).toBe(true);
    expect(transport.getProvider()).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    expect(fetchCalls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/models"
    );
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string>)?.["x-goog-api-key"]
    ).toBe("gemini-key");
  });

  test("provider profile override APIs manage manual map and clear on custom", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });

    await transport.listModels();
    expect(transport.getProviderProfile?.("https://relay.test/openai")).toBe(
      "custom"
    );

    const setResult = await transport.setProviderProfile?.(
      "https://relay.test/openai",
      "gemini"
    );
    expect(setResult?.ok).toBe(true);
    expect(transport.listProviderProfiles?.()).toEqual({
      "https://relay.test/openai": "gemini",
    });
    expect(transport.getProviderProfile?.("https://relay.test/openai")).toBe(
      "gemini"
    );

    const clearResult = await transport.setProviderProfile?.(
      "https://relay.test/openai",
      "custom"
    );
    expect(clearResult?.ok).toBe(true);
    expect(transport.listProviderProfiles?.()).toEqual({});
    expect(transport.getProviderProfile?.("https://relay.test/openai")).toBe(
      "custom"
    );
  });

  test("provider format override APIs manage manual map and persist", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });

    await transport.listModels();
    expect(transport.getProviderFormat?.("https://provider-a.test/v1")).toBe(
      "openai_chat"
    );

    const setResult = await transport.setProviderFormat?.(
      "https://provider-a.test/v1",
      "openai_responses"
    );
    expect(setResult?.ok).toBe(true);
    expect(transport.listProviderFormats?.()).toEqual({
      "https://provider-a.test/v1": "openai_responses",
    });
    expect(transport.getProviderFormat?.("https://provider-a.test/v1")).toBe(
      "openai_responses"
    );

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_formats:");
    expect(persisted).toContain("  - provider: https://provider-a.test/v1");
    expect(persisted).toContain("    format: openai_responses");

    const clearResult = await transport.setProviderFormat?.(
      "https://provider-a.test/v1",
      null
    );
    expect(clearResult?.ok).toBe(true);
    expect(transport.listProviderFormats?.()).toEqual({});
    expect(transport.getProviderFormat?.("https://provider-a.test/v1")).toBe(
      "openai_chat"
    );
  });

  test("provider type override APIs manage manual map, persist, and clear legacy overrides", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const provider = "https://relay.test/v1";
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });

    await transport.listModels();
    await transport.setProviderProfile?.(provider, "anthropic");
    await transport.setProviderFormat?.(provider, "openai_responses");
    expect(transport.listProviderProfiles?.()).toEqual({
      [provider]: "anthropic",
    });
    expect(transport.listProviderFormats?.()).toEqual({
      [provider]: "openai_responses",
    });

    const setResult = await transport.setProviderType?.(provider, "anthropic");
    expect(setResult?.ok).toBe(true);
    expect(setResult?.type).toBe("anthropic");
    expect(transport.listProviderTypes?.()).toEqual({
      [provider]: "anthropic",
    });
    expect(transport.listProviderProfiles?.()).toEqual({});
    expect(transport.listProviderFormats?.()).toEqual({});
    expect(transport.getProviderType?.(provider)).toBe("anthropic");
    expect(transport.getProviderFormat?.(provider)).toBe(
      "anthropic_messages"
    );

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_types:");
    expect(persisted).toContain(`  - provider: ${provider}`);
    expect(persisted).toContain("    type: anthropic");
    expect(persisted).not.toContain("provider_profiles:");
    expect(persisted).not.toContain("provider_formats:");

    const reloaded = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });
    await reloaded.listModels();
    expect(reloaded.listProviderTypes?.()).toEqual({
      [provider]: "anthropic",
    });
    expect(reloaded.getProviderType?.(provider)).toBe("anthropic");
    expect(reloaded.getProviderFormat?.(provider)).toBe(
      "anthropic_messages"
    );
  });

  test("legacy provider overrides clear explicit provider type overrides", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const openaiRelay = "https://relay-openai.test/v1";
    const geminiRelay = "https://relay-gemini.test";
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });

    await transport.listModels();

    const setOpenAiType = await transport.setProviderType?.(
      openaiRelay,
      "openai-responses"
    );
    expect(setOpenAiType?.ok).toBe(true);
    expect(transport.listProviderTypes?.()).toEqual({
      [openaiRelay]: "openai-responses",
    });

    const setFormat = await transport.setProviderFormat?.(
      openaiRelay,
      "openai_chat"
    );
    expect(setFormat?.ok).toBe(true);
    expect(transport.listProviderTypes?.()).toEqual({});
    expect(transport.listProviderFormats?.()).toEqual({
      [openaiRelay]: "openai_chat",
    });
    expect(transport.getProviderType?.(openaiRelay)).toBe(
      "openai-compatible"
    );

    const setGeminiType = await transport.setProviderType?.(
      geminiRelay,
      "gemini"
    );
    expect(setGeminiType?.ok).toBe(true);
    expect(transport.listProviderTypes?.()).toEqual({
      [geminiRelay]: "gemini",
    });

    const setProfile = await transport.setProviderProfile?.(
      geminiRelay,
      "gemini"
    );
    expect(setProfile?.ok).toBe(true);
    expect(transport.listProviderTypes?.()).toEqual({});
    expect(transport.listProviderProfiles?.()).toEqual({
      [geminiRelay]: "gemini",
    });
    expect(transport.getProviderType?.(geminiRelay)).toBe("gemini");
  });

  test("provider endpoint override APIs manage manual maps by kind and persist", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });

    await transport.listModels();
    expect(
      transport.getProviderEndpoint?.("https://provider-a.test/v1", "responses")
    ).toBeNull();

    const setResult = await transport.setProviderEndpoint?.(
      "https://provider-a.test/v1",
      "responses",
      "/responses"
    );
    expect(setResult?.ok).toBe(true);
    expect(transport.listProviderEndpoints?.()).toEqual({
      "https://provider-a.test/v1": {
        responses: "/responses",
      },
    });
    expect(
      transport.getProviderEndpoint?.("https://provider-a.test/v1", "responses")
    ).toBe("/responses");

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_endpoints:");
    expect(persisted).toContain("  - provider: https://provider-a.test/v1");
    expect(persisted).toContain("    kind: responses");
    expect(persisted).toContain("    endpoint: /responses");

    const clearResult = await transport.setProviderEndpoint?.(
      "https://provider-a.test/v1",
      "responses",
      null
    );
    expect(clearResult?.ok).toBe(true);
    expect(transport.listProviderEndpoints?.()).toEqual({});
    expect(
      transport.getProviderEndpoint?.("https://provider-a.test/v1", "responses")
    ).toBeNull();
  });

  test("provider name APIs manage custom labels and persist them", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://provider-a.test/v1",
        "providers:",
        "  - https://provider-a.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "shared-key",
      },
    });

    await transport.listModels();
    expect(transport.getProviderName?.("https://provider-a.test/v1")).toBeNull();

    const setResult = await transport.setProviderName?.(
      "https://provider-a.test/v1",
      "Work Relay"
    );
    expect(setResult?.ok).toBe(true);
    expect(transport.listProviderNames?.()).toEqual({
      "https://provider-a.test/v1": "Work Relay",
    });
    expect(transport.getProviderName?.("https://provider-a.test/v1")).toBe(
      "Work Relay"
    );

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_names:");
    expect(persisted).toContain("  - provider: https://provider-a.test/v1");
    expect(persisted).toContain("    name: Work Relay");

    const clearResult = await transport.setProviderName?.(
      "https://provider-a.test/v1",
      null
    );
    expect(clearResult?.ok).toBe(true);
    expect(transport.listProviderNames?.()).toEqual({});
    expect(transport.getProviderName?.("https://provider-a.test/v1")).toBeNull();
  });

  test("manual profile override forces anthropic family for relay provider and persists", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-main",
        "last_used_model: gpt-main",
        "provider_base_url: https://relay.test/v1",
        "providers:",
        "  - https://relay.test/v1",
        "models:",
        "  - gpt-main",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
              "",
              'event: message_stop',
              'data: {"type":"message_stop"}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "claude-relay" }],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
      if (url.endsWith("/v1/messages")) {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://relay.test/v1",
        CYRENE_API_KEY: "shared-key",
        CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    await transport.listModels();
    const overrideResult = await transport.setProviderProfile?.(
      "https://relay.test/v1",
      "anthropic"
    );
    expect(overrideResult?.ok).toBe(true);
    expect(transport.describeProvider?.()?.vendor).toBe("anthropic");

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls[0]?.url).toBe("https://relay.test/v1/models");
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string>)?.["x-api-key"]
    ).toBe("anthropic-key");
    expect(fetchCalls[1]?.url).toBe("https://relay.test/v1/messages");
    expect(
      (fetchCalls[1]?.init?.headers as Record<string, string>)?.["x-api-key"]
    ).toBe("anthropic-key");
    expect(events).toContain(JSON.stringify({ type: "text_delta", text: "ok" }));
    expect(events.at(-1)).toBe(JSON.stringify({ type: "done" }));

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_profiles:");
    expect(persisted).toContain("  - provider: https://relay.test/v1");
    expect(persisted).toContain("    profile: anthropic");

    const reloaded = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
      },
    });
    await reloaded.listModels();
    expect(reloaded.describeProvider?.()?.vendor).toBe("anthropic");
    expect(reloaded.listProviderProfiles?.()).toEqual({
      "https://relay.test/v1": "anthropic",
    });
  });

  test("anthropic provider streams text/tool events via native messages API", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: claude-3-7-sonnet-latest",
        "last_used_model: claude-3-7-sonnet-latest",
        "provider_base_url: https://api.anthropic.com",
        "models:",
        "  - claude-3-7-sonnet-latest",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: message_start',
              'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
              "",
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
              "",
              'event: content_block_start',
              'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"file"}}',
              "",
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"action\\":\\"read_file\\",\\"path\\":\\"README.md\\"}"}}',
              "",
              'event: content_block_stop',
              'data: {"type":"content_block_stop","index":1}',
              "",
              'event: message_delta',
              'data: {"type":"message_delta","usage":{"output_tokens":5}}',
              "",
              'event: message_stop',
              'data: {"type":"message_stop"}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string>)?.["x-api-key"]
    ).toBe("anthropic-key");
    expect(events).toContain(JSON.stringify({ type: "text_delta", text: "hello" }));
    expect(events).toContain(
      JSON.stringify({
        type: "tool_call",
        toolName: "file",
        input: { action: "read_file", path: "README.md" },
      })
    );
    expect(events.at(-1)).toBe(JSON.stringify({ type: "done" }));
  });

  test("anthropic tool input ignores empty object seeds before streamed json deltas", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: claude-3-7-sonnet-latest",
        "last_used_model: claude-3-7-sonnet-latest",
        "provider_base_url: https://api.anthropic.com",
        "models:",
        "  - claude-3-7-sonnet-latest",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: content_block_start',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"file","input":{}}}',
              "",
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"action\\": \\"list_dir\\", "}}',
              "",
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"path\\": \\".\\"}"}}',
              "",
              'event: content_block_stop',
              'data: {"type":"content_block_stop","index":0}',
              "",
              'event: message_stop',
              'data: {"type":"message_stop"}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(events).toContain(
      JSON.stringify({
        type: "tool_call",
        toolName: "file",
        input: { action: "list_dir", path: "." },
      })
    );
    expect(events.at(-1)).toBe(JSON.stringify({ type: "done" }));
  });

  test("openai responses format streams text/tool/usage events via responses API", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"response.output_text.delta","delta":"hello"}',
              "",
              'data: {"type":"response.output_item.added","item_id":"fc_1","item":{"type":"function_call","name":"file"}}',
              "",
              'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"action\\":\\"read_file\\",\\"path\\":\\"README.md\\"}"}',
              "",
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16,"input_tokens_details":{"cached_tokens":9}}}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const formatResult = await transport.setProviderFormat?.(
      "https://example.test/v1",
      "openai_responses"
    );
    expect(formatResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://example.test/v1/responses");
    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body));
    expect(requestBody.model).toBe("gpt-test");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.tool_choice).toBe("auto");
    expect(requestBody.input).toBe("hello");
    expect(requestBody.instructions).toBe(TOOL_USAGE_SYSTEM_PROMPT);
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "tool_call",
        toolName: "file",
        input: { action: "read_file", path: "README.md" },
      }),
      JSON.stringify({
        type: "usage",
        promptTokens: 11,
        cachedTokens: 9,
        completionTokens: 5,
        totalTokens: 16,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("openai responses format falls back to /responses for providers without /v1 suffix", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://relay.test/api",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"response.output_text.delta","delta":"hello"}',
              "",
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://relay.test/api/responses") {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://relay.test/api",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const formatResult = await transport.setProviderFormat?.(
      "https://relay.test/api",
      "openai_responses"
    );
    expect(formatResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://relay.test/api/responses");
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("openai responses format uses explicit provider endpoint override when configured", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://relay.test/api",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"response.output_text.delta","delta":"hello"}',
              "",
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://relay.test/custom/responses") {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://relay.test/api",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const formatResult = await transport.setProviderFormat?.(
      "https://relay.test/api",
      "openai_responses"
    );
    expect(formatResult?.ok).toBe(true);
    const endpointResult = await transport.setProviderEndpoint?.(
      "https://relay.test/api",
      "responses",
      "https://relay.test/custom/responses"
    );
    expect(endpointResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://relay.test/custom/responses");
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("provider endpoint override repairs absolute URLs missing the scheme colon", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://relay.test/api",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"response.output_text.delta","delta":"hello"}',
              "",
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://rawchat.cn/codex/responses") {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://relay.test/api",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const formatResult = await transport.setProviderFormat?.(
      "https://relay.test/api",
      "openai_responses"
    );
    expect(formatResult?.ok).toBe(true);
    const endpointResult = await transport.setProviderEndpoint?.(
      "https://relay.test/api",
      "responses",
      "https//rawchat.cn/codex/responses"
    );
    expect(endpointResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://rawchat.cn/codex/responses");
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("openai chat format uses explicit chat_completions endpoint override when configured", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://relay.test/api",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"hello"}}]}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://relay.test/custom/chat/completions") {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://relay.test/api",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const endpointResult = await transport.setProviderEndpoint?.(
      "https://relay.test/api",
      "chat_completions",
      "https://relay.test/custom/chat/completions"
    );
    expect(endpointResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://relay.test/custom/chat/completions");
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("stream errors include the final request URL and response body", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://rawchat.cn/codex",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    globalThis.fetch = mock(async (url: string) => {
      if (url === "https://rawchat.cn/codex/v1/chat/completions") {
        return new Response("not found", { status: 404, statusText: "Not Found" });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://rawchat.cn/codex",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const streamUrl = await transport.requestStreamUrl("hello");

    await expect(async () => {
      for await (const _event of transport.stream(streamUrl)) {
        // unreachable
      }
    }).toThrow(
      "Stream error: 404 Not Found | url https://rawchat.cn/codex/v1/chat/completions | detail not found"
    );
  });

  test("stream errors surface provider JSON error messages", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://api.siliconflow.cn/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );

    globalThis.fetch = mock(async (url: string) => {
      if (url === "https://api.siliconflow.cn/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            error: {
              message: "stream_options is not supported",
              type: "invalid_request_error",
            },
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://api.siliconflow.cn/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    await transport.listModels();
    const streamUrl = await transport.requestStreamUrl("hello");

    await expect(async () => {
      for await (const _event of transport.stream(streamUrl)) {
        // unreachable
      }
    }).toThrow(
      "Stream error: 400 Bad Request | url https://api.siliconflow.cn/v1/chat/completions | detail stream_options is not supported"
    );
  });

  test("codex-style providers with /v1 stay on chat format until explicitly overridden", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: codex-mini",
        "last_used_model: codex-mini",
        "provider_base_url: https://code.newcli.com/codex/v1",
        "models:",
        "  - codex-mini",
        "",
      ].join("\n"),
      "utf8"
    );

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://code.newcli.com/codex/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "codex-mini",
      },
    });

    await transport.listModels();
    expect(transport.getProviderFormat?.()).toBe("openai_chat");

    const formatResult = await transport.setProviderFormat?.(
      "https://code.newcli.com/codex/v1",
      "openai_responses"
    );
    expect(formatResult?.ok).toBe(true);
    expect(transport.getProviderFormat?.()).toBe("openai_responses");
  });

  test("model refresh uses explicit models endpoint override when configured", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gpt-old",
        "last_used_model: gpt-old",
        "provider_base_url: https://relay.test/api",
        "models:",
        "  - gpt-old",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://relay.test/custom/models") {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-new" }, { id: "gpt-fast" }],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_API_KEY: "test-key",
      },
    });

    await transport.listModels();
    const endpointResult = await transport.setProviderEndpoint?.(
      "https://relay.test/api",
      "models",
      "https://relay.test/custom/models"
    );
    expect(endpointResult?.ok).toBe(true);

    const refreshResult = await transport.refreshModels();
    expect(refreshResult).toEqual({
      ok: true,
      message: "Model list refreshed: 2 models",
      models: ["gpt-new", "gpt-fast"],
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://relay.test/custom/models");
  });

  test("anthropic format uses explicit anthropic_messages endpoint override when configured", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: claude-3-7-sonnet-latest",
        "last_used_model: claude-3-7-sonnet-latest",
        "provider_base_url: https://api.anthropic.com",
        "models:",
        "  - claude-3-7-sonnet-latest",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
              "",
              'event: message_stop',
              'data: {"type":"message_stop"}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (url === "https://relay.test/custom/messages") {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
      },
    });

    await transport.listModels();
    const endpointResult = await transport.setProviderEndpoint?.(
      "https://api.anthropic.com",
      "anthropic_messages",
      "https://relay.test/custom/messages"
    );
    expect(endpointResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://relay.test/custom/messages");
    expect(events).toContain(JSON.stringify({ type: "text_delta", text: "ok" }));
    expect(events.at(-1)).toBe(JSON.stringify({ type: "done" }));
  });

  test("native Gemini format uses explicit generateContent endpoint override when configured", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gemini-2.5-flash",
        "last_used_model: gemini-2.5-flash",
        "provider_base_url: https://generativelanguage.googleapis.com/v1beta",
        "models:",
        "  - gemini-2.5-flash",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      if (
        url ===
        "https://relay.test/native/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
      ) {
        return new Response(streamBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
        CYRENE_GEMINI_API_KEY: "gemini-key",
        CYRENE_MODEL: "gemini-2.5-flash",
      },
    });

    await transport.listModels();
    const endpointResult = await transport.setProviderEndpoint?.(
      "https://generativelanguage.googleapis.com/v1beta",
      "gemini_generate_content",
      "https://relay.test/native/models/{model}:streamGenerateContent?alt=sse"
    );
    expect(endpointResult?.ok).toBe(true);

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://relay.test/native/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    expect(events).toEqual([
      JSON.stringify({
        type: "usage",
        promptTokens: 5,
        completionTokens: 2,
        totalTokens: 7,
      }),
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("native Gemini format streams text/tool/usage events via generateContent SSE", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    await writeFile(
      modelFile,
      [
        "default_model: gemini-2.5-flash",
        "last_used_model: gemini-2.5-flash",
        "provider_base_url: https://generativelanguage.googleapis.com/v1beta",
        "models:",
        "  - gemini-2.5-flash",
        "",
      ].join("\n"),
      "utf8"
    );

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}',
              "",
              'data: {"candidates":[{"content":{"parts":[{"text":"world"},{"functionCall":{"name":"file","args":{"action":"read_file","path":"README.md"}}}]}}],"usageMetadata":{"promptTokenCount":12,"cachedContentTokenCount":4,"candidatesTokenCount":7,"totalTokenCount":19}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
        CYRENE_GEMINI_API_KEY: "gemini-key",
        CYRENE_MODEL: "gemini-2.5-flash",
      },
    });

    await transport.listModels();
    expect(transport.getProviderFormat?.()).toBe("gemini_generate_content");
    expect(transport.describeProvider?.()?.format).toBe("gemini_generate_content");

    const streamUrl = await transport.requestStreamUrl("hello");
    const events: string[] = [];
    for await (const event of transport.stream(streamUrl)) {
      events.push(event);
    }

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string>)?.[
        "x-goog-api-key"
      ]
    ).toBe("gemini-key");

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body));
    expect(requestBody.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "hello" }],
      },
    ]);
    expect(requestBody.systemInstruction).toEqual({
      parts: [{ text: TOOL_USAGE_SYSTEM_PROMPT }],
    });
    expect(requestBody.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "AUTO",
      },
    });
    expect(requestBody.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("file");
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello " }),
      JSON.stringify({
        type: "usage",
        promptTokens: 12,
        cachedTokens: 4,
        completionTokens: 7,
        totalTokens: 19,
      }),
      JSON.stringify({ type: "text_delta", text: "world" }),
      JSON.stringify({
        type: "tool_call",
        toolName: "file",
        input: { action: "read_file", path: "README.md" },
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("openai chat stream recovers write_file calls that use `code` instead of `content`", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const service = createRelaxedFileService(root);
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"action\\":\\"write_file\\",\\"path\\":\\"src/main.cpp\\",\\"code\\":\\"#include <iostream>\\\\nint main() { return 0; }\\\\n\\"}"}}]}}]}',
              "",
              'data: {"choices":[{"finish_reason":"tool_calls"}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    const parsedEvents = await collectParsedStreamEvents(transport, "write a small cpp file");
    const toolEvent = parsedEvents.find(event => event.type === "tool_call");

    expect(toolEvent).toEqual({
      type: "tool_call",
      toolName: "file",
      input: {
        action: "write_file",
        path: "src/main.cpp",
        code: "#include <iostream>\nint main() { return 0; }\n",
      },
    });

    const result = await service.handleToolCall(toolEvent!.toolName, toolEvent!.input);
    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(await readFile(join(root, "src", "main.cpp"), "utf8")).toContain(
      "int main() { return 0; }"
    );
  });

  test("openai responses stream recovers write_file calls that use `body` instead of `content`", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const service = createRelaxedFileService(root);
    await writeFile(
      modelFile,
      [
        "default_model: gpt-test",
        "last_used_model: gpt-test",
        "provider_base_url: https://example.test/v1",
        "models:",
        "  - gpt-test",
        "",
      ].join("\n"),
      "utf8"
    );
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"type":"response.output_item.added","item_id":"fc_1","item":{"type":"function_call","name":"file"}}',
              "",
              'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"action\\":\\"write_file\\",\\"path\\":\\"notes.txt\\",\\"body\\":\\"hello from responses\\\\n\\"}"}',
              "",
              'data: {"type":"response.completed","response":{"status":"completed"}}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://example.test/v1",
        CYRENE_API_KEY: "test-key",
        CYRENE_MODEL: "gpt-test",
      },
    });

    const formatResult = await transport.setProviderFormat?.(
      "https://example.test/v1",
      "openai_responses"
    );
    expect(formatResult?.ok).toBe(true);

    const parsedEvents = await collectParsedStreamEvents(transport, "write a note");
    const toolEvent = parsedEvents.find(event => event.type === "tool_call");

    expect(toolEvent).toEqual({
      type: "tool_call",
      toolName: "file",
      input: {
        action: "write_file",
        path: "notes.txt",
        body: "hello from responses\n",
      },
    });

    const result = await service.handleToolCall(toolEvent!.toolName, toolEvent!.input);
    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe(
      "hello from responses\n"
    );
  });

  test("anthropic stream recovers edit_file calls that use oldText/newText aliases", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const service = createRelaxedFileService(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "lib.rs"), "fn greet() {}\n", "utf8");
    await writeFile(
      modelFile,
      [
        "default_model: claude-3-7-sonnet-latest",
        "last_used_model: claude-3-7-sonnet-latest",
        "provider_base_url: https://api.anthropic.com",
        "models:",
        "  - claude-3-7-sonnet-latest",
        "",
      ].join("\n"),
      "utf8"
    );

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: content_block_start',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"file","input":{}}}',
              "",
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"action\\":\\"edit_file\\",\\"path\\":\\"src/lib.rs\\",\\"oldText\\":\\"greet\\","}}',
              "",
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"newText\\":\\"welcome\\"}"}}',
              "",
              'event: content_block_stop',
              'data: {"type":"content_block_stop","index":0}',
              "",
              'event: message_stop',
              'data: {"type":"message_stop"}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://api.anthropic.com",
        CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
        CYRENE_MODEL: "claude-3-7-sonnet-latest",
      },
    });

    const parsedEvents = await collectParsedStreamEvents(transport, "rename greet to welcome");
    const toolEvent = parsedEvents.find(event => event.type === "tool_call");

    expect(toolEvent).toEqual({
      type: "tool_call",
      toolName: "file",
      input: {
        action: "edit_file",
        path: "src/lib.rs",
        oldText: "greet",
        newText: "welcome",
      },
    });

    const result = await service.handleToolCall(toolEvent!.toolName, toolEvent!.input);
    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(await readFile(join(root, "src", "lib.rs"), "utf8")).toBe(
      "fn welcome() {}\n"
    );
  });

  test("gemini stream recovers create_file calls that use `contents` instead of `content`", async () => {
    const { root, cyreneHome, modelFile } = await createWorkspace();
    const service = createRelaxedFileService(root);
    await writeFile(
      modelFile,
      [
        "default_model: gemini-2.5-flash",
        "last_used_model: gemini-2.5-flash",
        "provider_base_url: https://generativelanguage.googleapis.com/v1beta",
        "models:",
        "  - gemini-2.5-flash",
        "",
      ].join("\n"),
      "utf8"
    );
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"file","args":{"action":"create_file","path":"src/app.py","contents":"print(\\"gemini\\")\\n"}}}]}}]}',
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = mock(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createTransport({
      appRoot: root,
      cyreneHome,
      env: {
        CYRENE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
        CYRENE_GEMINI_API_KEY: "gemini-key",
        CYRENE_MODEL: "gemini-2.5-flash",
      },
    });

    const parsedEvents = await collectParsedStreamEvents(transport, "create a small python file");
    const toolEvent = parsedEvents.find(event => event.type === "tool_call");

    expect(toolEvent).toEqual({
      type: "tool_call",
      toolName: "file",
      input: {
        action: "create_file",
        path: "src/app.py",
        contents: 'print("gemini")\n',
      },
    });

    const result = await service.handleToolCall(toolEvent!.toolName, toolEvent!.input);
    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(await readFile(join(root, "src", "app.py"), "utf8")).toBe(
      'print("gemini")\n'
    );
  });

});
