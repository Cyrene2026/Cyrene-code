import { describe, expect, mock, test } from "bun:test";
import { runQuerySession } from "../src/core/query/runQuerySession";
import type { QueryTransport } from "../src/core/query/transport";

const promptTextOf = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "object" &&
        value !== null &&
        "text" in value &&
        typeof (value as { text?: unknown }).text === "string"
      ? (value as { text: string }).text
      : String(value ?? "");

const createTransport = (): { transport: QueryTransport; prompts: string[] } => {
  const prompts: string[] = [];

  return {
    prompts,
    transport: {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async prompt => {
      prompts.push(promptTextOf(prompt));
      return `stream://${prompts.length}`;
    },
    stream: async function* (streamUrl: string) {
      if (streamUrl === "stream://1") {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "create_file",
          input: { path: "test_files/u1.py" },
        });
        yield JSON.stringify({
          type: "tool_call",
          toolName: "create_file",
          input: { path: "test_files/u2.py" },
        });
        yield JSON.stringify({ type: "done" });
        return;
      }

      yield JSON.stringify({ type: "text_delta", text: "done" });
      yield JSON.stringify({ type: "done" });
    },
    },
  };
};

const createToolLoopTransport = (toolCallsPerStream: number[]): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* (streamUrl: string) {
      const index = Number(streamUrl.replace("stream://", "")) - 1;
      const count = toolCallsPerStream[index] ?? 0;
      for (let call = 0; call < count; call += 1) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "list_dir",
          input: { path: `test_files/${index}-${call}` },
        });
      }
      if (count === 0) {
        yield JSON.stringify({ type: "text_delta", text: "done" });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createSameProbeTransport = (repeats: number): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* () {
      for (let index = 0; index < repeats; index += 1) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: { action: "list_dir", path: "test_files" },
        });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createSameEmptyReadTransport = (repeats: number): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* () {
      for (let index = 0; index < repeats; index += 1) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: { action: "read_file", path: "test_files/u5.py" },
        });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createPromptCaptureTransport = (
  toolCall: { toolName: string; input: unknown }
): { transport: QueryTransport; prompts: string[] } => {
  const prompts: string[] = [];
  let streamCount = 0;

  return {
    prompts,
    transport: {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async prompt => {
        prompts.push(promptTextOf(prompt));
        return `stream://${++streamCount}`;
      },
      stream: async function* (streamUrl: string) {
        if (streamUrl === "stream://1") {
          yield JSON.stringify({
            type: "tool_call",
            toolName: toolCall.toolName,
            input: toolCall.input,
          });
          yield JSON.stringify({ type: "done" });
          return;
        }

        yield JSON.stringify({ type: "text_delta", text: "done" });
        yield JSON.stringify({ type: "done" });
      },
    },
  };
};

const createRepeatedRunCommandTransport = (repeats: number): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* () {
      for (let index = 0; index < repeats; index += 1) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: {
            action: "run_command",
            command: "node",
            args: ["--version"],
            path: "node --version",
          },
        });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createRepeatedRunShellTransport = (repeats: number): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* () {
      for (let index = 0; index < repeats; index += 1) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: {
            action: "run_shell",
            command: "Get-ChildItem test_files",
            path: ".",
          },
        });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createSameSearchTransport = (repeats: number): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* () {
      for (let index = 0; index < repeats; index += 1) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: {
            action: "search_text",
            path: "src",
            query: "needle",
          },
        });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createRoundSequenceTransport = (
  rounds: Array<{ toolName: string; input: unknown } | null>
): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async () => `stream://${++streamCount}`,
    stream: async function* (streamUrl: string) {
      const index = Number(streamUrl.replace("stream://", "")) - 1;
      const round = rounds[index] ?? null;
      if (round) {
        yield JSON.stringify({
          type: "tool_call",
          toolName: round.toolName,
          input: round.input,
        });
      } else {
        yield JSON.stringify({ type: "text_delta", text: "done" });
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

const createPromptCaptureRoundSequenceTransport = (
  rounds: Array<{ toolName: string; input: unknown } | null>
): { transport: QueryTransport; prompts: string[] } => {
  const prompts: string[] = [];
  let streamCount = 0;

  return {
    prompts,
    transport: {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async prompt => {
        prompts.push(promptTextOf(prompt));
        return `stream://${++streamCount}`;
      },
      stream: async function* (streamUrl: string) {
        const index = Number(streamUrl.replace("stream://", "")) - 1;
        const round = rounds[index] ?? null;
        if (round) {
          yield JSON.stringify({
            type: "tool_call",
            toolName: round.toolName,
            input: round.input,
          });
        } else {
          yield JSON.stringify({ type: "text_delta", text: "done" });
        }
        yield JSON.stringify({ type: "done" });
      },
    },
  };
};

type ScriptedTransportEvent =
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "text_delta"; text: string };

const createPromptCaptureScriptedTransport = (
  rounds: ScriptedTransportEvent[][]
): { transport: QueryTransport; prompts: string[] } => {
  const prompts: string[] = [];
  let streamCount = 0;

  return {
    prompts,
    transport: {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async prompt => {
        prompts.push(promptTextOf(prompt));
        return `stream://${++streamCount}`;
      },
      stream: async function* (streamUrl: string) {
        const index = Number(streamUrl.replace("stream://", "")) - 1;
        const round = rounds[index] ?? [];
        for (const event of round) {
          yield JSON.stringify(event);
        }
        yield JSON.stringify({ type: "done" });
      },
    },
  };
};

const createLateToolCallAfterAnswerTransport = (): {
  transport: QueryTransport;
  prompts: string[];
} => {
  const prompts: string[] = [];
  let streamCount = 0;

  return {
    prompts,
    transport: {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({
        ok: true,
        message: `provider ${provider}`,
        currentProvider: provider,
        providers: [provider],
        models: ["gpt-test"],
      }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async prompt => {
        prompts.push(promptTextOf(prompt));
        return `stream://${++streamCount}`;
      },
      stream: async function* () {
        yield JSON.stringify({
          type: "text_delta",
          text: "This is the final answer. ".repeat(12),
        });
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: { action: "read_file", path: "README.md" },
        });
        yield JSON.stringify({ type: "done" });
      },
    },
  };
};

describe("runQuerySession", () => {
  test("suspends on pending review and resumes same task with approval result", async () => {
    const { transport, prompts } = createTransport();
    const states: string[] = [];
    const textDeltas: string[] = [];
    const toolCalls: string[] = [];
    const onToolCall = mock(async (toolName: string) => {
      toolCalls.push(toolName);
      return {
        message: "Approval required review-1",
        reviewMode: "queue" as const,
      };
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "create u1 and u2",
      transport,
      onState: state => {
        states.push(state.status);
      },
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall,
      onError: () => {},
    });

    expect(result.status).toBe("suspended");
    if (result.status !== "suspended") {
      throw new Error("expected suspended result");
    }
    expect(toolCalls).toEqual(["create_file"]);
    expect(states).toContain("awaiting_review");

    const resumed = await result.resume(
      "[approved] review-1\nCreated file: test_files/u1.py"
    );

    expect(resumed.status).toBe("completed");
    expect(toolCalls).toEqual(["create_file"]);
    expect(textDeltas).toEqual(["done"]);
    expect(prompts[1]).toContain("[approved] review-1");
    expect(prompts[1]).toContain("Continue from the confirmed facts");
  });

  test("approval resume retries once when the immediate continuation completes silently", async () => {
    const prompts: string[] = [];
    let streamCount = 0;
    const transport: QueryTransport = {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({
        ok: true,
        message: `provider ${provider}`,
        currentProvider: provider,
        providers: [provider],
        models: ["gpt-test"],
      }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async prompt => {
        prompts.push(promptTextOf(prompt));
        return `stream://${++streamCount}`;
      },
      stream: async function* (streamUrl: string) {
        if (streamUrl === "stream://1") {
          yield JSON.stringify({
            type: "tool_call",
            toolName: "create_file",
            input: { path: "test_files/main.py" },
          });
          yield JSON.stringify({ type: "done" });
          return;
        }

        if (streamUrl === "stream://2") {
          yield JSON.stringify({ type: "done" });
          return;
        }

        yield JSON.stringify({ type: "text_delta", text: "continued after approval" });
        yield JSON.stringify({ type: "done" });
      },
    };

    const textDeltas: string[] = [];
    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "create main.py then continue wiring",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => ({
        message: "Approval required review-1",
        reviewMode: "queue" as const,
      }),
      onError: () => {},
    });

    expect(result.status).toBe("suspended");
    if (result.status !== "suspended") {
      throw new Error("expected suspended result");
    }

    const resumed = await result.resume(
      "[approved] review-1\nCreated file: main.py\n[confirmed file mutation] create_file main.py"
    );

    expect(resumed.status).toBe("completed");
    expect(textDeltas).toEqual(["continued after approval"]);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("do not end silently");
    expect(prompts[2]).toContain("[approved] review-1");
    expect(prompts[2]).toContain(
      "After an approval resumes, continue from those runtime facts."
    );
  });

  test("approval resume uses structured metadata for mutation side effects", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "write_file", path: "src/app.ts", content: "patched\n" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/app.ts" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "update src/app.ts and continue editing other files",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        if (action === "write_file") {
          return {
            message: "Approval required review-1",
            reviewMode: "queue" as const,
          };
        }
        return {
          message: "[tool result] read_file src/app.ts\nshould not run",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("suspended");
    if (result.status !== "suspended") {
      throw new Error("expected suspended result");
    }

    const resumed = await result.resume({
      message: "[approved] review-1\nopaque approval payload",
      metadata: {
        kind: "file",
        action: "write_file",
        workspacePath: "src/app.ts",
        resolvedPath: "/repo/src/app.ts",
        pathKind: "file",
        mutation: {
          applied: true,
        },
        fileRevision: {
          sizeBytes: 8,
          mtimeMs: 1234,
          revisionKey: "8:1234",
        },
      },
    });

    expect(resumed.status).toBe("completed");
    expect(toolCalls).toEqual(["write_file"]);
    expect(prompts[1]).toContain("Recent confirmed file mutations:");
    expect(prompts[1]).toContain("write_file src/app.ts");
    expect(prompts[1]).toContain(
      "Runtime fact sections below may be synthesized from structured tool metadata"
    );
    expect(prompts[2]).toContain("[tool skipped] read_file src/app.ts");
    expect(prompts[2]).toContain("Skipped redundant read_file for src/app.ts");
  });

  test("allows more than 6 tool steps before completion", async () => {
    const transport = createToolLoopTransport([7, 0]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "scan files",
      queryMaxToolSteps: 24,
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (toolName: string) => {
        toolCalls.push(toolName);
        return { message: "ok" };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toHaveLength(7);
  });

  test("stops with explicit message when tool budget is exhausted", async () => {
    const transport = createToolLoopTransport([3, 3, 0]);
    const textDeltas: string[] = [];
    const completionReasons: Array<string | null> = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "scan files",
      queryMaxToolSteps: 5,
      transport,
      onState: state => {
        completionReasons.push(state.completion?.reason ?? null);
      },
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return { message: "ok" };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(5);
    expect(textDeltas.join("")).toContain("[tool budget exhausted]");
    expect(textDeltas.join("")).toContain("5/5");
    expect(completionReasons).toContain("tool_budget_exhausted");
  });

  test("preserves tool budget across suspend and resume", async () => {
    const transport = createToolLoopTransport([1, 4, 1, 0]);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "review then continue",
      queryMaxToolSteps: 5,
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        if (toolCallCount === 1) {
          return {
            message: "review me",
            reviewMode: "queue" as const,
          };
        }
        return { message: "ok" };
      },
      onError: () => {},
    });

    expect(result.status).toBe("suspended");
    if (result.status !== "suspended") {
      throw new Error("expected suspended result");
    }

    const resumed = await result.resume("[approved] review-1");
    expect(resumed.status).toBe("completed");
    expect(toolCallCount).toBe(5);
    expect(textDeltas.join("")).toContain("[tool budget exhausted]");
  });

  test("stores structured provider completion reasons in session state", async () => {
    const transport: QueryTransport = {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async () => "stream://1",
      stream: async function* () {
        yield JSON.stringify({ type: "text_delta", text: "partial answer" });
        yield JSON.stringify({
          type: "completion",
          source: "provider",
          reason: "finish_reason:length",
          detail: "The provider ended the response with finish_reason=length.",
          expected: false,
        });
        yield JSON.stringify({ type: "done" });
      },
    };

    const completions: Array<{
      reason: string | null;
      detail: string | null;
      expected: boolean | null;
    }> = [];

    const result = await runQuerySession({
      query: "session prompt",
      transport,
      onState: state => {
        completions.push({
          reason: state.completion?.reason ?? null,
          detail: state.completion?.detail ?? null,
          expected:
            typeof state.completion?.expected === "boolean"
              ? state.completion.expected
              : null,
        });
      },
      onTextDelta: () => {},
      onToolCall: async () => ({ message: "ok" }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(completions).toContainEqual({
      reason: "finish_reason:length",
      detail: "The provider ended the response with finish_reason=length.",
      expected: false,
    });
  });

  test("surfaces silent done as an explicit provider completion diagnostic", async () => {
    const transport: QueryTransport = {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async () => "stream://1",
      stream: async function* () {
        yield JSON.stringify({ type: "done" });
      },
    };

    const textDeltas: string[] = [];
    const completionReasons: Array<string | null> = [];

    const result = await runQuerySession({
      query: "session prompt",
      transport,
      onState: state => {
        completionReasons.push(state.completion?.reason ?? null);
      },
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => ({ message: "ok" }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(completionReasons).toContain("done_without_reason");
    expect(textDeltas.join("")).toContain(
      "[model stream interrupted] The stream ended without a structured provider completion reason."
    );
  });

  test("stores usage events from the stream in session state", async () => {
    const transport: QueryTransport = {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({ ok: true, message: `provider ${provider}`, currentProvider: provider, providers: [provider], models: ["gpt-test"] }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async () => "stream://1",
      stream: async function* () {
        yield JSON.stringify({ type: "text_delta", text: "hello" });
        yield JSON.stringify({
          type: "usage",
          promptTokens: 12,
          cachedTokens: 9,
          completionTokens: 7,
          totalTokens: 19,
        });
        yield JSON.stringify({ type: "done" });
      },
    };

    const states: Array<{ status: string; totalTokens: number | null }> = [];

    const result = await runQuerySession({
      query: "session prompt",
      transport,
      onState: state => {
        states.push({
          status: state.status,
          totalTokens: state.usage?.totalTokens ?? null,
        });
      },
      onTextDelta: () => {},
      onToolCall: async () => ({ message: "ok" }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(states[0]).toEqual({ status: "requesting", totalTokens: null });
    expect(states).toContainEqual({ status: "streaming", totalTokens: 19 });
    expect(states.at(-1)).toEqual({ status: "idle", totalTokens: 19 });
  });

  test("reports usage once per request using the latest streamed snapshot", async () => {
    let requestCount = 0;
    const transport: QueryTransport = {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({
        ok: true,
        message: `provider ${provider}`,
        currentProvider: provider,
        providers: [provider],
        models: ["gpt-test"],
      }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async () => `stream://${++requestCount}`,
      stream: async function* (streamUrl: string) {
        if (streamUrl === "stream://1") {
          yield JSON.stringify({
            type: "usage",
            promptTokens: 5000,
            cachedTokens: 4800,
            completionTokens: 0,
            totalTokens: 5000,
          });
          yield JSON.stringify({
            type: "usage",
            promptTokens: 5000,
            cachedTokens: 4800,
            completionTokens: 20,
            totalTokens: 5020,
          });
          yield JSON.stringify({
            type: "tool_call",
            toolName: "file",
            input: { action: "read_file", path: "README.md" },
          });
          yield JSON.stringify({ type: "done" });
          return;
        }

        yield JSON.stringify({
          type: "usage",
          promptTokens: 120,
          cachedTokens: 80,
          completionTokens: 0,
          totalTokens: 120,
        });
        yield JSON.stringify({
          type: "usage",
          promptTokens: 120,
          cachedTokens: 80,
          completionTokens: 30,
          totalTokens: 150,
        });
        yield JSON.stringify({ type: "text_delta", text: "done" });
        yield JSON.stringify({ type: "done" });
      },
    };

    const usages: Array<{
      promptTokens: number;
      cachedTokens?: number;
      completionTokens: number;
      totalTokens: number;
    }> = [];

    const result = await runQuerySession({
      query: "session prompt",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onUsage: usage => {
        usages.push(usage);
      },
      onToolCall: async () => ({ message: "ok" }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(usages).toEqual([
      {
        promptTokens: 5000,
        cachedTokens: 4800,
        completionTokens: 20,
        totalTokens: 5020,
      },
      {
        promptTokens: 120,
        cachedTokens: 80,
        completionTokens: 30,
        totalTokens: 150,
      },
    ]);
  });

  test("returns from requesting to idle when the stream completes without content chunks", async () => {
    const transport: QueryTransport = {
      getModel: () => "gpt-test",
      getProvider: () => "https://provider.test/v1",
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({
        ok: true,
        message: `provider ${provider}`,
        currentProvider: provider,
        providers: [provider],
        models: ["gpt-test"],
      }),
      setModel: async model => ({ ok: true, message: `set ${model}` }),
      listModels: async () => ["gpt-test"],
      refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
      requestStreamUrl: async () => "stream://1",
      stream: async function* () {
        yield JSON.stringify({ type: "done" });
      },
    };

    const states: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      transport,
      onState: state => {
        states.push(state.status);
      },
      onTextDelta: () => {},
      onToolCall: async () => ({ message: "ok" }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(states[0]).toBe("requesting");
    expect(states.at(-1)).toBe("idle");
  });

  test("ignores late tool calls after a substantial final answer and does not re-enter another round", async () => {
    const { transport, prompts } = createLateToolCallAfterAnswerTransport();
    const textDeltas: string[] = [];
    const onToolCall = mock(async () => ({ message: "should not run" }));

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "summarize only",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall,
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(onToolCall).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(1);
    expect(textDeltas.join("")).toContain("This is the final answer.");
  });

test("suspended resume is one-shot and does not re-enter rounds twice", async () => {
    const { transport, prompts } = createTransport();
    const onToolCall = mock(async () => ({
      message: "Approval required review-1",
      reviewMode: "queue" as const,
    }));

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "create u1 and u2",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall,
      onError: () => {},
    });

    expect(result.status).toBe("suspended");
    if (result.status !== "suspended") {
      throw new Error("expected suspended result");
    }

    const [first, second] = await Promise.all([
      result.resume("[approved] review-1\nCreated file: test_files/u1.py"),
      result.resume("[approved] review-1\nCreated file: test_files/u1.py"),
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });

  test("emits a visible tool status before awaiting tool execution", async () => {
    const transport = createRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "needle" },
      },
      null,
    ]);
    const order: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "find the target text",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolStatus: message => {
        order.push(`status:${message}`);
      },
      onToolCall: async () => {
        order.push("tool:search_text");
        return {
          message:
            "[tool result] search_text src\nFound 1 match(es):\nsrc/app.ts:12 | needle found here",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(order[0]).toContain("status:Running search_text");
    expect(order[0]).toContain("src");
    expect(order[0]).toContain('query "needle"');
    expect(order[1]).toBe("tool:search_text");
  });

  test("stops repeated same list_dir probe earlier than generic loop guard", async () => {
    const transport = createSameProbeTransport(3);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "inspect and then create files",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return { message: "[tool result] list_dir test_files\n[confirmed directory state] test_files\n(empty directory)" };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(2);
    expect(textDeltas.join("")).toContain("directory state was already confirmed");
  });

  test("stops repeated empty-file read earlier", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_file", path: "test_files/u5.py" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "test_files/u5.py" },
      },
      null,
    ]);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "fix empty file",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return {
          message: "[tool result] read_file test_files/u5.py\n(empty file)",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(1);
    expect(prompts[2]).toContain("[tool skipped] read_file test_files/u5.py");
    expect(prompts[2]).toContain("already read completely");
    expect(textDeltas.join("")).not.toContain("file was already confirmed empty");
  });

  test("injects write nudge after confirmed directory state for create task", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "list_dir", path: "test_files" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "请创建几个文件并写入内容",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message:
          "[tool result] list_dir test_files\n[confirmed directory state] test_files\n(empty directory)",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("Heuristic nudges:");
    expect(prompts[1]).toContain("Stop exploring and start writing");
    expect(prompts[1]).toContain("Execution style rules:");
    expect(prompts[1]).toContain("Keep assistant wording in the same language as the user request");
  });

  test("injects write-not-read nudge after empty file is confirmed", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "read_file", path: "test_files/u5.py" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "u5.py内容是空的，补上内容",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: "[tool result] read_file test_files/u5.py\n(empty file)",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain(
      "The next action should be write_file/create_file/edit_file, not read_file again"
    );
  });

  test("injects discovered-path nudge after search results", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "search_text", path: "src", query: "needle" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "find the target file and patch it",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message:
          "[tool result] search_text src\nFound 1 match(es):\nsrc/app.ts:12 | needle found here",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("Use the discovered path or search hit directly");
  });

  test("injects confirmed file mutation facts after a successful write", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "write_file", path: "src/app.ts", content: "export const updated = true;\n" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "update src/app.ts and continue the task",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: [
          "[tool result] write_file src/app.ts",
          "Wrote file: src/app.ts",
          "[confirmed file mutation] write_file src/app.ts",
          "postcondition: file content was updated successfully",
        ].join("\n"),
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("Recent confirmed file mutations:");
    expect(prompts[1]).toContain("write_file src/app.ts");
    expect(prompts[1]).toContain(
      "Treat successful create_file/write_file/edit_file/apply_patch results as confirmed file mutations"
    );
  });

  test("injects completed and remaining paths into the multi-file progress ledger", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask:
        "请创建 test_files/a.py、test_files/b.py、test_files/c.py，并分别写入演示内容",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: [
          "[tool result] create_file test_files/a.py",
          "Created file: test_files/a.py",
          "[confirmed file mutation] create_file test_files/a.py",
          "postcondition: file now exists and content was written successfully",
        ].join("\n"),
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("Multi-file progress ledger:");
    expect(prompts[1]).toContain("expected files: 3");
    expect(prompts[1]).toContain("completed (1/3): test_files/a.py");
    expect(prompts[1]).toContain(
      "remaining known paths (2): test_files/b.py, test_files/c.py"
    );
  });

  test("falls back to count-based ledger when target filenames are unknown", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "create_file", path: "test_files/u1.py", content: "print('1')\n" },
      },
      {
        toolName: "file",
        input: { action: "create_file", path: "test_files/u2.py", content: "print('2')\n" },
      },
      null,
    ]);

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "请在 test_files 里创建 5 个 py 文件并写入示例内容",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const path =
          input && typeof input === "object" && "path" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).path)
            : "unknown.py";
        return {
          message: [
            `[tool result] create_file ${path}`,
            `Created file: ${path}`,
            `[confirmed file mutation] create_file ${path}`,
            "postcondition: file now exists and content was written successfully",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("expected files: 5");
    expect(prompts[1]).toContain("completed (1/5): test_files/u1.py");
    expect(prompts[1]).toContain("remaining count: 4");
    expect(prompts[2]).toContain("completed (2/5): test_files/u1.py, test_files/u2.py");
    expect(prompts[2]).toContain("remaining count: 3");
  });

  test("nudges the model to continue remaining files instead of rereading completed ones", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask:
        "创建 test_files/a.py、test_files/b.py、test_files/c.py，并把三个文件都写好",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: [
          "[tool result] create_file test_files/a.py",
          "Created file: test_files/a.py",
          "[confirmed file mutation] create_file test_files/a.py",
          "postcondition: file now exists and content was written successfully",
        ].join("\n"),
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("This is a multi-file task. Continue with the remaining target files directly");
    expect(prompts[1]).toContain(
      "Do not reread completed files or relist directories just to confirm progress"
    );
  });

  test("does not double-count repeated writes to the same path in the ledger", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "write_file", path: "test_files/a.py", content: "v1\n" },
      },
      {
        toolName: "file",
        input: { action: "write_file", path: "test_files/a.py", content: "v2\n" },
      },
      null,
    ]);

    const result = await runQuerySession({
      query: "session prompt",
      originalTask:
        "创建 test_files/a.py、test_files/b.py、test_files/c.py，并全部写入内容",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const path =
          input && typeof input === "object" && "path" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).path)
            : "unknown.py";
        return {
          message: [
            `[tool result] write_file ${path}`,
            `Wrote file: ${path}`,
            `[confirmed file mutation] write_file ${path}`,
            "postcondition: file content was updated successfully",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[2]).toContain("completed (1/3): test_files/a.py");
    expect(prompts[2]).not.toContain("completed (2/3)");
  });

  test("skips immediate read_file on the same path after a confirmed write", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "write_file", path: "src/app.ts", content: "patched\n" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/app.ts" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "update src/app.ts and continue editing other files",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: [
            "[tool result] write_file src/app.ts",
            "Wrote file: src/app.ts",
            "[confirmed file mutation] write_file src/app.ts",
            "postcondition: file content was updated successfully",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["write_file"]);
    expect(prompts[2]).toContain("[tool skipped] read_file src/app.ts");
    expect(prompts[2]).toContain("Skipped redundant read_file for src/app.ts");
  });

  test("allows immediate read_file after write when the task explicitly asks to verify", async () => {
    const transport = createRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "write_file", path: "src/app.ts", content: "patched\n" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/app.ts" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "写完 src/app.ts 之后检查内容是否正确",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        if (action === "read_file") {
          return {
            message: "[tool result] read_file src/app.ts\nexport const updated = true;",
          };
        }
        return {
          message: [
            "[tool result] write_file src/app.ts",
            "Wrote file: src/app.ts",
            "[confirmed file mutation] write_file src/app.ts",
            "postcondition: file content was updated successfully",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["write_file", "read_file"]);
  });

  test("allows verification-oriented rereads in a multi-file task", async () => {
    const transport = createRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "test_files/a.py" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask:
        "创建 test_files/a.py、test_files/b.py，然后检查每个文件的内容是否正确",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        if (action === "read_file") {
          return {
            message: "[tool result] read_file test_files/a.py\nprint('a')",
          };
        }
        return {
          message: [
            "[tool result] create_file test_files/a.py",
            "Created file: test_files/a.py",
            "[confirmed file mutation] create_file test_files/a.py",
            "postcondition: file now exists and content was written successfully",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["create_file", "read_file"]);
  });

  test("skips repeated full-file reads once the current revision is already fully read", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_file", path: "src/entrypoints/cli.tsx" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/entrypoints/cli.tsx" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "trace the cli startup flow",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: [
            "[tool result] read_file src/entrypoints/cli.tsx",
            "export async function main() {",
            "  return startCli();",
            "}",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["read_file"]);
    expect(prompts[1]).toContain("File read ledger:");
    expect(prompts[1]).toContain(
      "src/entrypoints/cli.tsx: fully_read=true; next read only if the file changes"
    );
    expect(prompts[2]).toContain("[tool skipped] read_file src/entrypoints/cli.tsx");
    expect(prompts[2]).toContain("already read completely");
  });

  test("read ledger uses structured metadata even when tool text is not parseable", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_file", path: "src/output.ts" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/output.ts" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "use src/output.ts as context and continue",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: "[tool result] read_file src/output.ts\ncontent hidden",
          metadata: {
            kind: "file",
            action: "read_file",
            workspacePath: "src/output.ts",
            resolvedPath: "/repo/src/output.ts",
            fileRevision: {
              sizeBytes: 321,
              mtimeMs: 1234,
              revisionKey: "321:1234",
            },
            read: {
              mode: "full",
              startLine: 1,
              endLine: 120,
              fullyRead: true,
              truncated: false,
              nextSuggestedStartLine: null,
              empty: false,
              lineCount: 120,
            },
          },
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["read_file"]);
    expect(prompts[1]).toContain(
      "src/output.ts: fully_read=true; next read only if the file changes"
    );
    expect(prompts[2]).toContain("[tool skipped] read_file src/output.ts");
  });

  test("blocks whole-file rereads after partial range coverage and suggests the next range", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: {
          action: "read_range",
          path: "src/output.ts",
          startLine: 1,
          endLine: 40,
        },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/output.ts" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "understand how output.ts formats terminal output",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: [
            "[tool result] read_range src/output.ts",
            "path: src/output.ts",
            "lines: 1-40",
            "1 | export function output() {",
            "2 |   return renderTerminal();",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["read_range"]);
    expect(prompts[1]).toContain("File read ledger:");
    expect(prompts[1]).toContain(
      "src/output.ts: fully_read=false; read_ranges=1-40; next_suggested_start_line=41"
    );
    expect(prompts[2]).toContain("[tool skipped] read_file src/output.ts");
    expect(prompts[2]).toContain("Use read_range with startLine 41");
  });

  test("skips repeated read_range coverage that is already in the ledger", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: {
          action: "read_range",
          path: "src/output.ts",
          startLine: 1,
          endLine: 20,
        },
      },
      {
        toolName: "file",
        input: {
          action: "read_range",
          path: "src/output.ts",
          startLine: 1,
          endLine: 20,
        },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "walk through output.ts incrementally",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: [
            "[tool result] read_range src/output.ts",
            "path: src/output.ts",
            "lines: 1-20",
            "1 | export function output() {",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["read_range"]);
    expect(prompts[2]).toContain("[tool skipped] read_range src/output.ts");
    expect(prompts[2]).toContain("already covered");
    expect(prompts[2]).toContain("read_range starting at line 21");
  });

  test("stops repeated failed run_command earlier than generic loop guard", async () => {
    const transport = createRepeatedRunCommandTransport(2);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "run the same command again if needed",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return {
          message:
            "[tool result] run_command node --version\nstatus: failed\ncommand: node\nargs: --version\ncwd: .\nexit: 1\noutput_truncated: false\noutput:\nboom",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(2);
    expect(textDeltas.join("")).toContain("run_command was retried after the same command already failed");
  });

  test("stops repeated failed run_shell earlier than generic loop guard", async () => {
    const transport = createRepeatedRunShellTransport(2);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "run the same shell command again if needed",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return {
          message:
            "[tool result] run_shell .\nstatus: failed\nshell: pwsh\ncommand: Get-ChildItem test_files\ncwd: .\nexit: 1\noutput_truncated: false\noutput:\nboom",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(2);
    expect(textDeltas.join("")).toContain("run_shell was retried after the same command already failed");
  });

  test("generic repeated file-loop message names the concrete action", async () => {
    const transport = createSameSearchTransport(4);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "search for the same thing repeatedly",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return {
          message:
            "[tool result] search_text src\nFound 1 match(es):\nsrc/app.ts:12 | needle found here",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(3);
    expect(textDeltas.join("")).toContain(
      "[tool loop detected] search_text was called repeatedly with same input"
    );
    expect(textDeltas.join("")).not.toContain(
      "[tool loop detected] file was called repeatedly with same input"
    );
  });

  test("repeating the same search after each successful write does not trip the loop guard", async () => {
    const transport = createRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "needle" },
      },
      {
        toolName: "file",
        input: { action: "write_file", path: "src/app.ts", content: "patched-1" },
      },
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "needle" },
      },
      {
        toolName: "file",
        input: { action: "write_file", path: "src/app.ts", content: "patched-2" },
      },
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "needle" },
      },
      {
        toolName: "file",
        input: { action: "write_file", path: "src/app.ts", content: "patched-3" },
      },
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "needle" },
      },
      null,
    ]);
    const textDeltas: string[] = [];
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "patch the file and verify the same match after each change",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        if (action === "search_text") {
          return {
            message:
              "[tool result] search_text src\nFound 1 match(es):\nsrc/app.ts:12 | needle found here",
          };
        }
        return {
          message: "[tool result] write_file src/app.ts\nWrote file: src/app.ts",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual([
      "search_text",
      "write_file",
      "search_text",
      "write_file",
      "search_text",
      "write_file",
      "search_text",
    ]);
    expect(textDeltas.join("")).toContain("done");
    expect(textDeltas.join("")).not.toContain("[tool loop detected]");
  });

  test("shared broad discovery budget collapses mixed search tools in the same scope", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "list_dir", path: "src" },
      },
      {
        toolName: "file",
        input: { action: "find_files", path: "src", pattern: "output.ts" },
      },
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "output(" },
      },
      {
        toolName: "file",
        input: { action: "search_text_context", path: "src", query: "output(" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "find the output implementation and continue from the concrete file",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        switch (action) {
          case "list_dir":
            return {
              message: "[tool result] list_dir src\n[confirmed directory state] src\n[F] src/index.ts",
            };
          case "find_files":
            return {
              message: "[tool result] find_files src\nFound 1 match(es):\nsrc/output.ts",
            };
          default:
            return {
              message:
                "[tool result] search_text src\nFound 1 match(es):\nsrc/output.ts:12 | export function output()",
            };
        }
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["list_dir", "find_files", "search_text"]);
    expect(prompts[3]).toContain("Search memory:");
    expect(prompts[3]).toContain("searched scopes: src");
    expect(prompts[3]).toContain("known hit paths: src/index.ts, src/output.ts");
    expect(prompts[4]).toContain("[tool skipped] search_text_context src");
    expect(prompts[4]).toContain("Broad discovery budget exhausted:");
  });

  test("does not auto-pause after consecutive search rounds without new evidence", async () => {
    const transport = createRoundSequenceTransport([
      { toolName: "file", input: { action: "list_dir", path: "pkg-a" } },
      { toolName: "file", input: { action: "list_dir", path: "pkg-b" } },
      { toolName: "file", input: { action: "list_dir", path: "pkg-c" } },
      { toolName: "file", input: { action: "list_dir", path: "pkg-d" } },
      null,
    ]);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "keep searching until the right package is obvious",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return {
          message: "[tool result] list_dir\n(no useful findings)",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(4);
    expect(textDeltas.join("")).not.toContain("[execution paused]");
    expect(textDeltas.join("")).not.toContain(
      "No new file mutation, high-value evidence, or phase progression"
    );
  });

  test("targeted read_range continuation does not trip the no-progress breaker", async () => {
    const transport = createRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_range", path: "src/main.ts", startLine: 1, endLine: 40 },
      },
      {
        toolName: "file",
        input: { action: "read_range", path: "src/main.ts", startLine: 41, endLine: 80 },
      },
      {
        toolName: "file",
        input: { action: "read_range", path: "src/main.ts", startLine: 81, endLine: 120 },
      },
      null,
    ]);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "inspect src/main.ts in detail and continue reading as needed",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async (_toolName, input) => {
        toolCallCount += 1;
        const record =
          input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const startLine = Number(record.startLine ?? 1);
        const endLine = Number(record.endLine ?? startLine);
        return {
          message: `[tool result] read_range src/main.ts\nlines: ${startLine}-${endLine}`,
          metadata: {
            kind: "file",
            action: "read_range",
            workspacePath: "src/main.ts",
            resolvedPath: "/workspace/src/main.ts",
            pathKind: "file",
            fileRevision: {
              sizeBytes: 4096,
              mtimeMs: 1,
              revisionKey: "4096:1",
            },
            read: {
              mode: "range",
              startLine,
              endLine,
              fullyRead: false,
              truncated: true,
              nextSuggestedStartLine: endLine + 1,
              empty: false,
              lineCount: endLine - startLine + 1,
            },
          },
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(3);
    expect(textDeltas.join("")).not.toContain("[execution paused]");
  });

  test("injects a simple multi-file execution memo into the first round only for matching tasks", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "创建 test_files/a.py、test_files/b.py，并分别写入内容",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: "[tool result] create_file test_files/a.py\nCreated file: test_files/a.py",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[0]).toContain("Execution memo:");
    expect(prompts[0]).toContain("simple multi-file task");
    expect(prompts[0]).toContain("Original user task:");
  });

  test("single-file write tasks get a write-focused execution memo without multi-file wording", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "write_file", path: "src/app.ts", content: "patched\n" },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "update src/app.ts only",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: "[tool result] write_file src/app.ts\nWrote file: src/app.ts",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[0]).toContain("Execution memo:");
    expect(prompts[0]).toContain("explicit code-change task");
    expect(prompts[0]).toContain("focused write/edit task");
    expect(prompts[0]).toContain("explicit task paths: src/app.ts");
    expect(prompts[0]).not.toContain("simple multi-file task");
  });

  test("injects a project analysis memo into the first round for repo analysis tasks", async () => {
    const { transport, prompts } = createPromptCaptureTransport({
      toolName: "file",
      input: { action: "list_dir", path: "." },
    });

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "explain this repo architecture and main runtime chain",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: [
          "[tool result] list_dir .",
          "[confirmed directory state] .",
          "[F] README.md",
          "[F] package.json",
          "[D] src",
        ].join("\n"),
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[0]).toContain("Project analysis memo:");
    expect(prompts[0]).toContain("Start with one minimal repo snapshot");
    expect(prompts[0]).toContain("Trace one main execution/call path through 2-4 core files");
    expect(prompts[0]).toContain("Prefer semantic navigation when available");
    expect(prompts[0]).toContain(
      "Once a concrete source anchor is known, try one semantic navigation step through the matching provider before spending more broad discovery budget."
    );
    expect(prompts[0]).toContain(
      "Use search_text/find_files mainly for literals, config keys, filenames"
    );
    expect(prompts[0]).toContain(
      "Final summary shape: overall architecture, main execution chain, key modules, and open questions."
    );
  });

  test("project analysis mode collapses repeated broad exploration after a targeted anchor read", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "list_dir", path: "." },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "package.json" },
      },
      {
        toolName: "file",
        input: { action: "list_dir", path: "src" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "看看这个项目架构和主链路",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        if (action === "read_file") {
          return {
            message: [
              "[tool result] read_file package.json",
              "{",
              '  "main": "src/index.ts",',
              '  "scripts": { "start": "node src/index.ts" }',
              "}",
            ].join("\n"),
          };
        }
        return {
          message: [
            "[tool result] list_dir .",
            "[confirmed directory state] .",
            "[F] README.md",
            "[F] package.json",
            "[D] src",
          ].join("\n"),
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["list_dir", "read_file"]);
    expect(prompts[1]).toContain(
      "For symbol lookup, definition lookup, references, call chains, and file structure, prefer lsp_/ts_ semantic tools"
    );
    expect(prompts[1]).toContain(
      "Use search_text/find_files mainly for literals, filenames, config keys"
    );
    expect(prompts[2]).toContain("semantic navigation steps: 0");
    expect(prompts[3]).toContain("[tool skipped] list_dir src");
    expect(prompts[3]).toContain("Project analysis semantic navigation preferred:");
    expect(prompts[3]).toContain("Known source anchors: src/index.ts.");
    expect(prompts[3]).toContain("Project analysis rules:");
  });

  test("explicit source reads are allowed once and do not count against broad discovery budget", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_file", path: "main.py" },
      },
      null,
    ]);

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "先看 main.py，再拆分模块结构",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: "[tool result] read_file main.py\nfrom fastapi import FastAPI\napp = FastAPI()",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts[1]).toContain("Execution state:");
    expect(prompts[1]).toContain("broad discovery budget: 0/4");
  });

  test("single-file write focus blocks a second targeted read before any mutation", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_file", path: "src/app.ts" },
      },
      {
        toolName: "file",
        input: { action: "read_file", path: "src/app.ts" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "update src/app.ts only",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: "[tool result] read_file src/app.ts\nexport const current = true;\n",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["read_file"]);
    expect(prompts[1]).toContain("write focus: pre_mutation");
    expect(prompts[1]).toContain(
      "use at most one targeted source read, then move directly to the next write/edit step"
    );
    expect(prompts[2]).toContain("[tool skipped] read_file src/app.ts");
    expect(prompts[2]).toContain("Reuse the previous read result or move to the next concrete file");
  });

  test("repeated broad discovery collapses early and blocks when a split task still lacks concrete facts", async () => {
    const { transport } = createPromptCaptureRoundSequenceTransport([
      { toolName: "file", input: { action: "list_dir", path: "." } },
      { toolName: "file", input: { action: "list_dir", path: "." } },
      { toolName: "file", input: { action: "list_dir", path: "." } },
      { toolName: "file", input: { action: "list_dir", path: "." } },
      { toolName: "file", input: { action: "list_dir", path: "." } },
    ]);
    const textDeltas: string[] = [];
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "请拆分成模块结构",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => {
        toolCallCount += 1;
        return {
          message: "[tool result] list_dir .\n[confirmed directory state] (workspace root inspected)",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCallCount).toBe(2);
    expect(textDeltas.join("")).toContain("still lacks a concrete source file or target file count");
  });

  test("execute phase skips renewed broad discovery and pushes a more specific continue-directly correction", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
      },
      {
        toolName: "file",
        input: { action: "search_text", path: "src", query: "needle" },
      },
      null,
    ]);
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "创建 test_files/a.py、test_files/b.py、test_files/c.py，并把三个文件都写好",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message:
            "[tool result] create_file test_files/a.py\nCreated file: test_files/a.py\n[confirmed file mutation] create_file test_files/a.py",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["create_file"]);
    expect(prompts[1]).toContain("phase: execute");
    expect(prompts[1]).toContain(
      "write remaining files directly; do not reread completed files or re-open broad discovery"
    );
    expect(prompts[2]).toContain("[tool skipped] search_text src");
    expect(prompts[2]).toContain("a confirmed code mutation already exists");
  });

  test("short non-progress chatter auto-continues once and preserves the chatter in visible output", async () => {
    const { transport, prompts } = createPromptCaptureScriptedTransport([
      [
        {
          type: "tool_call",
          toolName: "file",
          input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
        },
      ],
      [{ type: "text_delta", text: "继续拆分剩余模块" }],
      [{ type: "text_delta", text: "已完成剩余文件" }],
    ]);
    const textDeltas: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "创建 test_files/a.py、test_files/b.py、test_files/c.py，并全部写入内容",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => ({
        message:
          "[tool result] create_file test_files/a.py\nCreated file: test_files/a.py\n[confirmed file mutation] create_file test_files/a.py",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(textDeltas.join("")).toBe("继续拆分剩余模块已完成剩余文件");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain(
      "The previous reply narrated progress without completing the remaining files."
    );
  });

  test("single-file write focus auto-continues one short narration before any mutation", async () => {
    const { transport, prompts } = createPromptCaptureScriptedTransport([
      [{ type: "text_delta", text: "我来继续修改这个文件" }],
      [
        {
          type: "tool_call",
          toolName: "file",
          input: { action: "write_file", path: "src/app.ts", content: "patched\n" },
        },
      ],
      [{ type: "text_delta", text: "done" }],
    ]);
    const toolCalls: string[] = [];
    const textDeltas: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "update src/app.ts only",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message: "[tool result] write_file src/app.ts\nWrote file: src/app.ts\n[confirmed file mutation] write_file src/app.ts",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["write_file"]);
    expect(textDeltas.join("")).toBe("我来继续修改这个文件done");
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(
      "The previous reply narrated progress before taking a concrete code step."
    );
    expect(prompts[1]).toContain("Do not narrate. Use the next concrete read/edit/write action now.");
  });

  test("a second short non-progress chatter stops with an explicit remaining-files pause message", async () => {
    const { transport } = createPromptCaptureScriptedTransport([
      [
        {
          type: "tool_call",
          toolName: "file",
          input: { action: "create_file", path: "test_files/a.py", content: "print('a')\n" },
        },
      ],
      [{ type: "text_delta", text: "继续拆分剩余模块" }],
      [{ type: "text_delta", text: "继续补齐剩余文件" }],
    ]);
    const textDeltas: string[] = [];

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "创建 test_files/a.py、test_files/b.py、test_files/c.py，并全部写入内容",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async () => ({
        message:
          "[tool result] create_file test_files/a.py\nCreated file: test_files/a.py\n[confirmed file mutation] create_file test_files/a.py",
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(textDeltas.join("")).toContain("继续拆分剩余模块");
    expect(textDeltas.join("")).toContain("继续补齐剩余文件");
    expect(textDeltas.join("")).toContain("[execution paused]");
    expect(textDeltas.join("")).toContain("Known remaining paths: test_files/b.py, test_files/c.py.");
  });

  test("plan execution auto-continues when the model only updates the plan without any tool call", async () => {
    const { transport, prompts } = createPromptCaptureScriptedTransport([
      [
        {
          type: "text_delta",
          text: [
            "Plan updated.",
            '<cyrene_plan>{"version":1,"projectRoot":"/workspace/demo","summary":"Finish the task","objective":"finish the task","acceptedAt":"","acceptedSummary":"","steps":[{"id":"step-1","title":"Patch reducer","details":"Implement the reducer change","status":"in_progress","evidence":[],"filePaths":["src/reducer.ts"],"recentToolResult":""},{"id":"step-2","title":"Run tests","details":"Verify the change","status":"pending","evidence":[],"filePaths":[],"recentToolResult":""}]}</cyrene_plan>',
          ].join("\n"),
        },
      ],
      [
        {
          type: "tool_call",
          toolName: "file",
          input: {
            action: "write_file",
            path: "src/reducer.ts",
            content: "patched\n",
          },
        },
      ],
      [
        {
          type: "text_delta",
          text: [
            "Patched the reducer step.",
            '<cyrene_plan>{"version":1,"projectRoot":"/workspace/demo","summary":"Finish the task","objective":"finish the task","acceptedAt":"","acceptedSummary":"","steps":[{"id":"step-1","title":"Patch reducer","details":"Implement the reducer change","status":"completed","evidence":["Wrote src/reducer.ts"],"filePaths":["src/reducer.ts"],"recentToolResult":"Wrote file: src/reducer.ts"},{"id":"step-2","title":"Run tests","details":"Verify the change","status":"pending","evidence":[],"filePaths":[],"recentToolResult":""}]}</cyrene_plan>',
          ].join("\n"),
        },
      ],
    ]);
    const textDeltas: string[] = [];
    const toolCalls: string[] = [];

    const result = await runQuerySession({
      query: [
        "Continue by executing the active execution plan.",
        "Focus on step step-1: Patch reducer",
        "Do the work instead of only restating the plan.",
        "If the step is finished, mark it completed yourself in an updated <cyrene_plan> JSON block.",
      ].join("\n\n"),
      originalTask: "finish the task",
      transport,
      onState: () => {},
      onTextDelta: text => {
        textDeltas.push(text);
      },
      onToolCall: async (_toolName, input) => {
        const action =
          input && typeof input === "object" && "action" in (input as Record<string, unknown>)
            ? String((input as Record<string, unknown>).action)
            : "unknown";
        toolCalls.push(action);
        return {
          message:
            "[tool result] write_file src/reducer.ts\nWrote file: src/reducer.ts\n[confirmed file mutation] write_file src/reducer.ts",
        };
      },
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual(["write_file"]);
    expect(textDeltas.join("")).toContain("Plan updated.");
    expect(textDeltas.join("")).toContain("Patched the reducer step.");
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(
      "The previous reply updated the execution plan but did not actually execute the focused step."
    );
    expect(prompts[1]).toContain("Continue executing step-1 now.");
  });

  test("round prompts truncate oversized accumulated tool results", async () => {
    const { transport, prompts } = createPromptCaptureRoundSequenceTransport([
      {
        toolName: "file",
        input: { action: "read_file", path: "big.txt" },
      },
      null,
    ]);

    const hugeToolBody = "line\n".repeat(12000);
    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "inspect big.txt and continue",
      transport,
      onState: () => {},
      onTextDelta: () => {},
      onToolCall: async () => ({
        message: `[tool result] read_file big.txt\n${hugeToolBody}`,
      }),
      onError: () => {},
    });

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("...[truncated for round prompt budget]...");
    expect(prompts[1]?.length ?? 0).toBeLessThan(30000);
  });
});

test("replays image attachments on follow-up rounds", async () => {
  const prompts: Array<unknown> = [];
  let streamCount = 0;
  const attachments = [
    {
      id: "img-1",
      kind: "image" as const,
      path: "/tmp/mock.png",
      name: "mock.png",
      mimeType: "image/png",
    },
  ];
  const transport: QueryTransport = {
    getModel: () => "gpt-test",
    getProvider: () => "https://provider.test/v1",
    listProviders: async () => ["https://provider.test/v1"],
    setProvider: async provider => ({
      ok: true,
      message: `provider ${provider}`,
      currentProvider: provider,
      providers: [provider],
      models: ["gpt-test"],
    }),
    setModel: async model => ({ ok: true, message: `set ${model}` }),
    listModels: async () => ["gpt-test"],
    refreshModels: async () => ({ ok: true, message: "ok", models: ["gpt-test"] }),
    requestStreamUrl: async prompt => {
      prompts.push(prompt);
      return `stream://${++streamCount}`;
    },
    stream: async function* (streamUrl: string) {
      if (streamUrl === "stream://1") {
        yield JSON.stringify({
          type: "tool_call",
          toolName: "file",
          input: { action: "read_file", path: "README.md" },
        });
        yield JSON.stringify({ type: "done" });
        return;
      }
      yield JSON.stringify({ type: "text_delta", text: "done" });
      yield JSON.stringify({ type: "done" });
    },
  };

  const result = await runQuerySession({
    query: {
      text: "describe this screenshot",
      attachments,
    },
    transport,
    onState: () => {},
    onTextDelta: () => {},
    onToolCall: async () => ({ message: "ok" }),
    onError: () => {},
  });

  expect(result.status).toBe("completed");
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toEqual({
    text: expect.any(String),
    attachments,
  });
  expect(prompts[1]).toEqual({
    text: expect.any(String),
    attachments,
  });
});
