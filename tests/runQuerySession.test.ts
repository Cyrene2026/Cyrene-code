import { describe, expect, mock, test } from "bun:test";
import { runQuerySession } from "../src/core/query/runQuerySession";
import type { QueryTransport } from "../src/core/query/transport";

const createTransport = (): QueryTransport => {
  const prompts: string[] = [];

  return {
    getModel: () => "gpt-test",
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
  };
};

const createToolLoopTransport = (toolCallsPerStream: number[]): QueryTransport => {
  let streamCount = 0;
  return {
    getModel: () => "gpt-test",
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

describe("runQuerySession", () => {
  test("suspends on pending review and resumes same task with approval result", async () => {
    const transport = createTransport();
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
});
