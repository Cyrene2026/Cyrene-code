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
});
