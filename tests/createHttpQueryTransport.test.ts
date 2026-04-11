import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_TOOL,
  TOOL_USAGE_SYSTEM_PROMPT,
  createHttpQueryTransport,
  normalizeProviderBaseUrl,
} from "../src/infra/http/createHttpQueryTransport";
import { resetConfiguredAppRoot, setConfiguredAppRoot } from "../src/infra/config/appRoot";

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];

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

afterEach(async () => {
  resetConfiguredAppRoot();
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
    });
    expect(transport.describeProvider?.("gemini")).toEqual({
      provider: "https://generativelanguage.googleapis.com/v1beta/openai",
      vendor: "gemini",
      keySource: "CYRENE_GEMINI_API_KEY",
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

});
