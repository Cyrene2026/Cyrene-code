import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_TOOL,
  TOOL_USAGE_SYSTEM_PROMPT,
} from "../src/infra/http/createHttpQueryTransport";

const originalEnv = {
  CYRENE_BASE_URL: process.env.CYRENE_BASE_URL,
  CYRENE_API_KEY: process.env.CYRENE_API_KEY,
  CYRENE_MODEL: process.env.CYRENE_MODEL,
};
const originalFetch = globalThis.fetch;
const originalCwd = process.cwd();
const tempRoots: string[] = [];

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-http-transport-test-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  process.chdir(root);
  return {
    root,
    modelFile: join(root, ".cyrene", "model.yaml"),
  };
};

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
  process.env.CYRENE_BASE_URL = originalEnv.CYRENE_BASE_URL;
  process.env.CYRENE_API_KEY = originalEnv.CYRENE_API_KEY;
  process.env.CYRENE_MODEL = originalEnv.CYRENE_MODEL;
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("createHttpQueryTransport tool exposure", () => {
  test("exports expanded file tool schema", () => {
    const actionEnum = FILE_TOOL.function.parameters.properties.action.enum;

    expect(actionEnum).toContain("run_command");
    expect(actionEnum).toContain("run_shell");
    expect(actionEnum).toContain("stat_path");
    expect(actionEnum).toContain("find_files");
    expect(actionEnum).toContain("search_text");
    expect(actionEnum).toContain("copy_path");
    expect(actionEnum).toContain("move_path");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("pattern");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("query");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("destination");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("command");
  });

  test("system prompt teaches model about search and command actions", () => {
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("find_files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("search_text");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("stat_path");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("run_command");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("run_shell");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not put shell syntax");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Avoid repetitive list_dir/read_file probing");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("confirmed directory state");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Do not repeat the same tool call with the same input");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Choose the narrowest action");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("If the user asked to create files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Stop exploring once you have enough information to act");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("If read_file returns `(empty file)`");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain('set `path` to `"."`');
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Omit every optional field you do not need");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("`args` is only for run_command");
  });
});

describe("createHttpQueryTransport streaming usage", () => {
  test("requests include_usage and emits normalized usage events", async () => {
    const { modelFile } = await createWorkspace();
    process.env.CYRENE_BASE_URL = "https://example.test/v1";
    process.env.CYRENE_API_KEY = "test-key";
    process.env.CYRENE_MODEL = "gpt-test";

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

    const { createHttpQueryTransport } = await import(
      "../src/infra/http/createHttpQueryTransport"
    );
    const transport = createHttpQueryTransport();
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

  test("setModel persists the most recently used model for next startup", async () => {
    const { modelFile } = await createWorkspace();
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

    const { createHttpQueryTransport } = await import(
      "../src/infra/http/createHttpQueryTransport"
    );
    const transport = createHttpQueryTransport();

    expect(await transport.listModels()).toEqual(["gpt-test", "gpt-next"]);
    expect(await transport.setModel("gpt-next")).toEqual({
      ok: true,
      message: "Model switched to: gpt-next",
    });
    expect(transport.getModel()).toBe("gpt-next");

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("default_model: gpt-next");
    expect(persisted).toContain("last_used_model: gpt-next");

    const restartedTransport = createHttpQueryTransport();
    expect(await restartedTransport.listModels()).toEqual(["gpt-test", "gpt-next"]);
    expect(restartedTransport.getModel()).toBe("gpt-next");
  });

  test("provider change refreshes catalog before restoring current model", async () => {
    const { modelFile } = await createWorkspace();
    process.env.CYRENE_BASE_URL = "https://provider-b.test/v1";
    process.env.CYRENE_API_KEY = "test-key";
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

    const { createHttpQueryTransport } = await import(
      "../src/infra/http/createHttpQueryTransport"
    );
    const transport = createHttpQueryTransport();

    expect(await transport.listModels()).toEqual(["new-main", "new-fast"]);
    expect(fetchCalls).toEqual(["https://provider-b.test/v1/models"]);
    expect(transport.getModel()).toBe("new-main");

    const persisted = await readFile(modelFile, "utf8");
    expect(persisted).toContain("provider_base_url: https://provider-b.test/v1");
    expect(persisted).toContain("default_model: new-main");
    expect(persisted).toContain("last_used_model: new-main");
  });

  test("summarizeText uses a plain completion request without tools and returns usage", async () => {
    const { modelFile } = await createWorkspace();
    process.env.CYRENE_BASE_URL = "https://example.test/v1";
    process.env.CYRENE_API_KEY = "test-key";
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
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "- task: keep markdown\n- fact: summary succeeded",
              },
            },
          ],
          usage: {
            prompt_tokens: 13,
            completion_tokens: 7,
            total_tokens: 20,
          },
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

    const { createHttpQueryTransport } = await import(
      "../src/infra/http/createHttpQueryTransport"
    );
    const transport = createHttpQueryTransport();
    const result = await transport.summarizeText?.("Summarize this session.");

    expect(fetchCalls).toHaveLength(1);
    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body));
    expect(requestBody.tools).toBeUndefined();
    expect(requestBody.tool_choice).toBeUndefined();
    expect(requestBody.stream).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      text: "- task: keep markdown\n- fact: summary succeeded",
      usage: {
        promptTokens: 13,
        completionTokens: 7,
        totalTokens: 20,
      },
    });
  });
});
