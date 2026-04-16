import { describe, expect, mock, test } from "bun:test";
import { runQuerySession } from "../src/core/query/runQuerySession";
import type { QueryTransport } from "../src/core/query/transport";

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
      prompts.push(prompt);
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
        prompts.push(prompt);
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
        prompts.push(prompt);
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
        prompts.push(prompt);
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
        prompts.push(prompt);
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
        prompts.push(prompt);
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
    let toolCallCount = 0;

    const result = await runQuerySession({
      query: "session prompt",
      originalTask: "scan files",
      queryMaxToolSteps: 5,
      transport,
      onState: () => {},
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
    expect(states).toEqual(["requesting", "idle"]);
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
    const transport = createSameEmptyReadTransport(2);
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
    expect(toolCallCount).toBe(2);
    expect(textDeltas.join("")).toContain("file was already confirmed empty");
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

  test("single-file tasks do not get the simple multi-file execution memo", async () => {
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
    expect(prompts[0]).not.toContain("Execution memo:");
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
    expect(prompts[2]).toContain("remaining files are already known");
  });

  test("short non-progress chatter auto-continues once and drops the chatter from visible output", async () => {
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
    expect(textDeltas.join("")).toBe("已完成剩余文件");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain(
      "The previous reply narrated progress without completing the remaining files."
    );
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
    expect(textDeltas.join("")).toContain("[execution paused]");
    expect(textDeltas.join("")).toContain("Known remaining paths: test_files/b.py, test_files/c.py.");
    expect(textDeltas.join("")).not.toContain("继续补齐剩余文件");
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
