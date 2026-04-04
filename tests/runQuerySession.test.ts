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
    expect(states).toContainEqual({ status: "streaming", totalTokens: 19 });
    expect(states.at(-1)).toEqual({ status: "idle", totalTokens: 19 });
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
});
