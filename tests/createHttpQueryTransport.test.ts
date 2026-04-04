import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_TOOL,
  TOOL_USAGE_SYSTEM_PROMPT,
  createHttpQueryTransport,
} from "../src/infra/http/createHttpQueryTransport";
import { resetConfiguredAppRoot, setConfiguredAppRoot } from "../src/infra/config/appRoot";

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];

const createTransport = (
  options: {
    appRoot: string;
    cwd?: string;
    env?: Partial<NodeJS.ProcessEnv>;
  }
) => {
  const env: NodeJS.ProcessEnv = {
    CYRENE_BASE_URL: undefined,
    CYRENE_API_KEY: undefined,
    CYRENE_MODEL: undefined,
    CYRENE_ROOT: options.appRoot,
    ...options.env,
  };
  return createHttpQueryTransport({
    appRoot: options.appRoot,
    cwd: options.cwd ?? options.appRoot,
    env,
  });
};

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-http-transport-test-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  return {
    root,
    modelFile: join(root, ".cyrene", "model.yaml"),
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
    expect(actionEnum).toContain("apply_patch");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("paths");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("startLine");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("endLine");
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
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_range when you need a specific line window");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_json for JSON configuration files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use read_yaml for YAML configuration files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use stat_paths when you need existence or metadata for several exact paths");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use outline_file before full reads on large source files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use find_symbol when you need to locate symbol definitions");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use find_references when you need cross-file symbol usages");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use search_text_context when surrounding lines around each match matter");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use git_log to inspect recent commits");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use git_show to inspect one revision in detail");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use git_blame to inspect who last changed specific lines");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_files, set `path` to the first file");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For stat_paths, set `path` to the first target");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_range, provide 1-based inclusive `startLine` and `endLine`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_json, provide `jsonPath` only when you want one nested field");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For read_yaml, provide `yamlPath` only when you want one nested field");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For find_symbol, provide the exact symbol name in `symbol`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For find_references, provide the exact symbol name in `symbol`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For git_log, use `maxResults` to limit how many commits");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For git_show, use `revision`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("For git_blame, provide a file path");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Use apply_patch for reviewed targeted patches");
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
    const { root, modelFile } = await createWorkspace();

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
              'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16}}',
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
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    expect(events).toEqual([
      JSON.stringify({ type: "text_delta", text: "hello" }),
      JSON.stringify({
        type: "usage",
        promptTokens: 11,
        completionTokens: 5,
        totalTokens: 16,
      }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("emits text deltas from structured content array chunks", async () => {
    const { root, modelFile } = await createWorkspace();
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
      JSON.stringify({ type: "text_delta", text: "thinking visible" }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("emits text deltas from reasoning_content and thinking fields", async () => {
    const { root, modelFile } = await createWorkspace();
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
      JSON.stringify({ type: "text_delta", text: "plan: inspect " }),
      JSON.stringify({ type: "text_delta", text: "then patch" }),
      JSON.stringify({ type: "text_delta", text: " now" }),
      JSON.stringify({ type: "done" }),
    ]);
  });

  test("setModel persists the most recently used model for next startup", async () => {
    const { root, modelFile } = await createWorkspace();
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

    const transport = createTransport({ appRoot: root });

    expect(await transport.listModels()).toEqual(["gpt-test", "gpt-next"]);
    expect(await transport.setModel("gpt-next")).toEqual({
      ok: true,
      message: "Model switched to: gpt-next",
    });
    expect(transport.getModel()).toBe("gpt-next");

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("default_model: gpt-next");
    expect(persisted).toContain("last_used_model: gpt-next");

    const restartedTransport = createTransport({ appRoot: root });
    expect(await restartedTransport.listModels()).toEqual(["gpt-test", "gpt-next"]);
    expect(restartedTransport.getModel()).toBe("gpt-next");
  });

  test("model catalog follows CYRENE_ROOT instead of current cwd", async () => {
    const { root, modelFile } = await createWorkspace();
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
        CYRENE_ROOT: root,
      },
    });

    expect(await transport.listModels()).toEqual(["gpt-root", "gpt-alt"]);
    expect(transport.getModel()).toBe("gpt-root");
  });

  test("explicit appRoot ignores an unrelated configured app root", async () => {
    const { root, modelFile } = await createWorkspace();
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

    const transport = createTransport({ appRoot: root });

    expect(await transport.listModels()).toEqual(["right-model", "right-fast"]);
    expect(transport.getModel()).toBe("right-model");
  });

  test("provider change refreshes catalog before restoring current model", async () => {
    const { root, modelFile } = await createWorkspace();
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
    const { root, modelFile } = await createWorkspace();
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

});
