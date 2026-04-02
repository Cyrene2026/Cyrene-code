import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react-test-renderer";
import type { FileAction, PendingReviewItem, ToolRequest } from "../src/core/tools/mcp/types";
import {
  createSessionRecord,
  createTestSessionStore,
  createTestTransport,
  flushMicrotasks,
  renderHookHarness,
  type TestSessionStore,
} from "./helpers/chatAppHarness";

let inputHandler:
  | ((input: string, key: Record<string, boolean>) => void)
  | null = null;

mock.module("../src/application/chat/inputAdapter", () => ({
  useInputAdapter: (handler: typeof inputHandler) => {
    inputHandler = handler;
  },
}));

const { useChatApp } = await import("../src/application/chat/useChatApp");

const createPending = (
  id: string,
  action: FileAction = "create_file",
  path = "test.py"
): PendingReviewItem => {
  const request: ToolRequest =
    action === "edit_file"
      ? {
          action,
          path,
          find: "before",
          replace: "after",
        }
      : action === "find_files"
        ? {
            action,
            path,
            pattern: "*.py",
          }
        : action === "search_text"
          ? {
              action,
              path,
              query: "needle",
            }
          : action === "copy_path" || action === "move_path"
            ? {
                action,
                path,
                destination: "next.py",
              }
      : action === "delete_file" || action === "read_file" || action === "list_dir" || action === "create_dir"
        ? {
            action,
            path,
          }
        : {
            action,
            path,
            content: "print('x')",
          };

  return {
    id,
    request,
    preview: `preview ${id}`,
    previewSummary: `summary ${id}`,
    previewFull: `full ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
};

const getTexts = (items: Array<{ text: string }>) => items.map(item => item.text);

const runCommand = async (
  app: ReturnType<typeof renderHookHarness<ReturnType<typeof useChatApp>>>,
  command: string
) => {
  await act(async () => {
    app.getLatest().setInput(command);
    await Promise.resolve();
  });
  await flushMicrotasks();
  await act(async () => {
    app.getLatest().submit();
    await Promise.resolve();
  });
  await flushMicrotasks();
};

const openApprovalPanelForTest = async (
  app: ReturnType<typeof renderHookHarness<ReturnType<typeof useChatApp>>>,
  pending: PendingReviewItem[]
) => {
  await act(async () => {
    app.getLatest().openApprovalPanel(pending, {
      focusLatest: true,
      previewMode: "summary",
    });
    await Promise.resolve();
  });
  await flushMicrotasks();
};

describe("useChatApp", () => {
  beforeEach(() => {
    inputHandler = null;
  });

  afterEach(() => {
    mock.restore();
  });

  test("/help appends help text", async () => {
    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/help");

    expect(getTexts(app.getLatest().items).some(text => text.includes("Commands:"))).toBe(true);
    app.cleanup();
  });

  test("free input supports terminal-style history with up/down arrows", async () => {
    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "first command");
    await runCommand(app, "second command");

    await act(async () => {
      app.getLatest().setInput("draft");
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      inputHandler?.("", { upArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("second command");
    expect(app.getLatest().inputCommandState.historyPosition).toBe(2);

    await act(async () => {
      inputHandler?.("", { upArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("first command");
    expect(app.getLatest().inputCommandState.historyPosition).toBe(1);

    await act(async () => {
      inputHandler?.("", { downArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("second command");

    await act(async () => {
      inputHandler?.("", { downArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("draft");
    expect(app.getLatest().inputCommandState.historyPosition).toBeNull();

    app.cleanup();
  });

  test("slash command suggestions prefer the most specific matching command", async () => {
    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await act(async () => {
      app.getLatest().setInput("/model refresh");
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().inputCommandState.currentCommand).toBe("/model refresh");
    expect(app.getLatest().inputCommandState.suggestions[0]?.command).toBe("/model refresh");

    app.cleanup();
  });

  test("/model opens picker and /model <name> switches model", async () => {
    const transport = createTestTransport();
    const app = renderHookHarness(() =>
      useChatApp({
        transport,
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/model");

    expect(app.getLatest().modelPicker.active).toBe(true);
    expect(app.getLatest().modelPicker.models).toEqual(["gpt-test", "gpt-next"]);

    await act(async () => {
      app.getLatest().setInput("");
      inputHandler?.("", { escape: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    await runCommand(app, "/model gpt-next");

    expect(app.getLatest().currentModel).toBe("gpt-next");
    app.cleanup();
  });

  test("/sessions and /resume handle empty and populated session lists", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        title: "A",
        messages: [{ role: "user", text: "hello", createdAt: "2026-01-01T00:00:00.000Z" }],
      }),
    ]);

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/sessions");
    expect(app.getLatest().sessionsPanel.active).toBe(true);

    await act(async () => {
      app.getLatest().setInput("");
      inputHandler?.("", { escape: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    await runCommand(app, "/resume session-a");
    expect(app.getLatest().activeSessionId).toBe("session-a");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Resumed session: session-a"))).toBe(true);

    await runCommand(app, "/resume missing");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Session not found: missing"))).toBe(true);
    app.cleanup();
  });

  test("/review and /approve handle queue states", async () => {
    let pending = [createPending("a1"), createPending("a2")];
    let approveCalls = 0;

    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        approveCalls += 1;
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nCreated file: ok` };
      }),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/review");
    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(app.getLatest().approvalPanel.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(app.getLatest().approvalPanel.selectedIndex).toBeLessThan(2);

    await act(async () => {
      app.getLatest().closeApprovalPanel();
      await Promise.resolve();
    });
    await flushMicrotasks();

    await runCommand(app, "/approve");
    expect(approveCalls).toBe(0);
    expect(getTexts(app.getLatest().items).some(text => text.includes("use: /approve <id>"))).toBe(true);

    pending = [createPending("single")];
    await runCommand(app, "/approve");
    await flushMicrotasks();
    expect(approveCalls).toBe(1);
    app.cleanup();
  });

  test("approval lock allows only one in-flight current approval", async () => {
    let pending = [createPending("lock-1")];
    let resolver: (() => void) | null = null;
    let calls = 0;

    const mcpService = {
      listPending: () => [...pending],
      approve: mock(
        () =>
          new Promise<{ ok: boolean; message: string }>(resolve => {
            calls += 1;
            resolver = () => {
              pending = [];
              resolve({ ok: true, message: "[approved] lock-1\nok" });
            };
          })
      ),
      reject: mock(() => ({ ok: true, message: "[rejected] lock-1" })),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await openApprovalPanelForTest(app, pending);
    await act(async () => {
      app.getLatest().approveCurrentPendingReview();
      app.getLatest().approveCurrentPendingReview();
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(calls).toBe(1);

    (resolver as (() => void) | null)?.();
    await flushMicrotasks();
    expect(app.getLatest().pendingReviews).toHaveLength(0);
    app.cleanup();
  });

  test("closing approval panel during in-flight approval keeps it closed after completion", async () => {
    let pending = [createPending("stay-closed")];
    let resolver: (() => void) | null = null;

    const mcpService = {
      listPending: () => [...pending],
      approve: mock(
        () =>
          new Promise<{ ok: boolean; message: string }>(resolve => {
            resolver = () => {
              pending = [];
              resolve({ ok: true, message: "[approved] stay-closed\nok" });
            };
          })
      ),
      reject: mock(() => ({ ok: true, message: "[rejected] stay-closed" })),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      app.getLatest().approveCurrentPendingReview();
      app.getLatest().closeApprovalPanel();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.active).toBe(false);

    (resolver as (() => void) | null)?.();
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(app.getLatest().pendingReviews).toHaveLength(0);
    app.cleanup();
  });

  test("tool pending opens approval panel and tool result/error are summarized", async () => {
    let pending = [createPending("p1", "edit_file", "src/a.ts")];
    const mcpService = {
      listPending: () => [...pending],
      handleToolCall: mock(async (_toolName: string, toolInput: unknown) => {
        if (toolInput === "pending") {
          return {
            ok: true,
            pending: pending[0],
            message: "[review required] p1",
          };
        }
        if (toolInput === "error") {
          return {
            ok: false,
            message: "[tool error] write_file src/a.ts\npermission denied",
          };
        }
        return {
          ok: true,
          message: "[tool result] write_file src/a.ts\nWrote file: src/a.ts",
        };
      }),
      approve: mock(async () => ({ ok: true, message: "[approved] p1\nok" })),
      reject: mock(() => ({ ok: true, message: "[rejected] p1" })),
    };

    const runQuerySessionImpl = mock(async ({ onState, onTextDelta, onToolCall, onError }: any) => {
      onState({ status: "streaming" });
      onTextDelta("hello");
      await onToolCall("file", "pending");
      await onToolCall("file", "result");
      await onToolCall("file", "error");
      onError("boom");
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "build this");
    await flushMicrotasks();

    const texts = getTexts(app.getLatest().items);
    expect(texts.some(text => text.includes("Approval required | edit_file src/a.ts | p1 | panel opened"))).toBe(true);
    expect(texts.some(text => text.includes("Tool: write_file src/a.ts | Wrote file: src/a.ts"))).toBe(true);
    expect(texts.some(text => text.includes("Tool error: write_file src/a.ts | permission denied"))).toBe(true);
    expect(texts.some(text => text.includes("Stream error: boom"))).toBe(true);
    expect(app.getLatest().approvalPanel.active).toBe(true);
    app.cleanup();
  });

  test("tool results are indexed into session memory for later retrieval", async () => {
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const mcpService = {
      listPending: () => [],
      handleToolCall: mock(async () => ({
        ok: true,
        message: "[tool result] write_file test_files/u4.py\nWrote file: test_files/u4.py",
      })),
    };

    const runQuerySessionImpl = mock(async ({ onState, onToolCall }: any) => {
      onState({ status: "streaming" });
      await onToolCall("file", { action: "write_file", path: "test_files/u4.py" });
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "write u4");
    await flushMicrotasks();

    const activeSessionId = app.getLatest().activeSessionId!;
    const memoryIndex = sessionStore.__getMemoryIndex(activeSessionId);
    expect(memoryIndex?.entries.some(entry => entry.kind === "tool_result")).toBe(true);
    expect(memoryIndex?.entries.some(entry => entry.text.includes("test_files/u4.py"))).toBe(true);
    app.cleanup();
  });

  test("pins enforce upper limit and unpin validates index", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        focus: ["a", "b"],
      }),
    ]);

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 2,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/resume session-a");

    await runCommand(app, "/pin c");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Pin limit reached (2)"))).toBe(true);

    await runCommand(app, "/unpin 0");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Usage: /unpin <index> (1-based)"))).toBe(true);
    app.cleanup();
  });

  test("/system, /system reset, /new and /pins work across session lifecycle", async () => {
    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "default system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/system");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Current system prompt:\ndefault system"))).toBe(true);

    await runCommand(app, "/system custom runtime");
    expect(getTexts(app.getLatest().items).some(text => text.includes("System prompt updated for current runtime."))).toBe(true);

    await runCommand(app, "/system");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Current system prompt:\ncustom runtime"))).toBe(true);

    await runCommand(app, "/system reset");
    await runCommand(app, "/system");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Current system prompt:\ndefault system"))).toBe(true);

    await runCommand(app, "/new");
    expect(app.getLatest().activeSessionId).toBeTruthy();
    expect(getTexts(app.getLatest().items).some(text => text.includes("Started new session:"))).toBe(true);

    await runCommand(app, "/pins");
    expect(getTexts(app.getLatest().items).some(text => text.includes("No pinned focus yet. Use /pin <note>."))).toBe(true);
    app.cleanup();
  });

  test("/reject handles empty queue, multi queue and direct reject", async () => {
    let pending: PendingReviewItem[] = [];
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async () => ({ ok: true, message: "[approved] x\nok" })),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/reject");
    expect(getTexts(app.getLatest().items).some(text => text.includes("No pending operations to reject."))).toBe(true);

    pending = [createPending("r1"), createPending("r2")];
    await runCommand(app, "/reject");
    expect(getTexts(app.getLatest().items).some(text => text.includes("use: /reject <id> or the approval panel"))).toBe(true);

    await runCommand(app, "/reject r1");
    expect(pending.map(item => item.id)).toEqual(["r2"]);
    expect(getTexts(app.getLatest().items).some(text => text.includes("Rejected"))).toBe(true);
    app.cleanup();
  });

  test("approval panel hotkeys switch preview, scroll, move selection and close", async () => {
    const pending = [
      {
        ...createPending("p1", "edit_file", "src/a.ts"),
        previewSummary: "sum-1",
        previewFull: Array.from({ length: 40 }, (_, index) => `full-1-${index}`).join("\n"),
      },
      {
        ...createPending("p2", "edit_file", "src/b.ts"),
        previewSummary: "sum-2",
        previewFull: Array.from({ length: 12 }, (_, index) => `full-2-${index}`).join("\n"),
      },
    ];

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => pending,
        } as any,
      })
    );

    await openApprovalPanelForTest(app, pending);
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(1);
    expect(app.getLatest().approvalPanel.previewMode).toBe("summary");

    await act(async () => {
      inputHandler?.("", { upArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(0);
    expect(app.getLatest().approvalPanel.previewOffset).toBe(0);

    await act(async () => {
      inputHandler?.("", { tab: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.previewMode).toBe("full");

    await act(async () => {
      inputHandler?.("j", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.previewOffset).toBe(20);

    await act(async () => {
      inputHandler?.("", { downArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(1);
    expect(app.getLatest().approvalPanel.previewOffset).toBe(0);

    await act(async () => {
      inputHandler?.("", { escape: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(getTexts(app.getLatest().items).some(text => text.includes("Approval panel closed."))).toBe(true);
    app.cleanup();
  });

  test("/model refresh reports success and failure", async () => {
    const successTransport = createTestTransport({
      refreshImpl: async () => ({
        ok: true,
        message: "refresh ok",
        models: ["gpt-test", "gpt-next"],
      }),
    });

    const successApp = renderHookHarness(() =>
      useChatApp({
        transport: successTransport,
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(successApp, "/model refresh");
    expect(
      getTexts(successApp.getLatest().items).some(text =>
        text.includes("refresh ok\nCurrent model: gpt-test")
      )
    ).toBe(true);
    successApp.cleanup();

    const failureTransport = createTestTransport({
      refreshImpl: async () => ({
        ok: false,
        message: "backend down",
      }),
    });

    const failureApp = renderHookHarness(() =>
      useChatApp({
        transport: failureTransport,
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(failureApp, "/model refresh");
    expect(
      getTexts(failureApp.getLatest().items).some(text =>
        text.includes("[model refresh failed] backend down")
      )
    ).toBe(true);
    failureApp.cleanup();
  });

  test("/review <id> and /approve <id> handle missing ids", async () => {
    const mcpService = {
      listPending: () => [createPending("known")],
      approve: mock(async (id: string) => ({
        ok: false,
        message: `Pending operation not found: ${id}`,
      })),
      reject: mock((id: string) => ({
        ok: false,
        message: `Pending operation not found: ${id}`,
      })),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/review missing");
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("pending operation not found: missing")
      )
    ).toBe(true);

    await runCommand(app, "/approve missing");
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Pending operation not found: missing")
      )
    ).toBe(true);
    app.cleanup();
  });

  test("long assistant output triggers compression warning and stores condensed assistant text", async () => {
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const longOutput = Array.from({ length: 140 }, (_, index) => `token-${index}`).join(" ");

    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta(longOutput);
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "generate a lot");
    await flushMicrotasks();

    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Long assistant output was compressed in session memory")
      )
    ).toBe(true);

    const activeSessionId = app.getLatest().activeSessionId;
    expect(activeSessionId).toBeTruthy();
    const stored = sessionStore.__getRecord(activeSessionId!);
    const assistantMessage = stored?.messages.findLast(message => message.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect((assistantMessage?.text.length ?? 0) < longOutput.length).toBe(true);
    app.cleanup();
  });

  test("approval input handler keeps enter disabled and a/r active", async () => {
    let pending = [createPending("hotkey-1")];
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        pending = [];
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => ({ ok: true, message: `[rejected] ${id}` })),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await openApprovalPanelForTest(app, pending);
    expect(inputHandler).not.toBeNull();

    await act(async () => {
      inputHandler?.("", { return: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(getTexts(app.getLatest().items).some(text => text.includes("Enter is disabled"))).toBe(true);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(pending).toHaveLength(0);
    app.cleanup();
  });

  test("approval in-flight ignores trailing enter and escape after first approve", async () => {
    let pending = [createPending("trail-1")];
    let resolver: (() => void) | null = null;
    const approve = mock(
      () =>
        new Promise<{ ok: boolean; message: string }>(resolve => {
          resolver = () => {
            pending = [];
            resolve({ ok: true, message: "[approved] trail-1\nok" });
          };
        })
    );

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [...pending],
          approve,
          reject: mock((id: string) => ({ ok: true, message: `[rejected] ${id}` })),
        } as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("a", {});
      inputHandler?.("", { return: true });
      inputHandler?.("", { escape: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(approve).toHaveBeenCalledTimes(1);
    expect(app.getLatest().approvalPanel.inFlightId).toBe("trail-1");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Approval panel closed."))).toBe(
      false
    );
    expect(getTexts(app.getLatest().items).filter(text => text.includes("Enter is disabled")).length).toBe(0);

    expect(resolver).not.toBeNull();
    const runResolve = resolver as unknown as () => void;
    runResolve();
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.active).toBe(false);
    app.cleanup();
  });

  test("approval enter hint is rate-limited", async () => {
    const pending = [createPending("enter-1")];
    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => pending,
        } as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("", { return: true });
      inputHandler?.("", { return: true });
      inputHandler?.("", { return: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(
      getTexts(app.getLatest().items).filter(text => text.includes("Enter is disabled")).length
    ).toBe(1);
    app.cleanup();
  });

  test("approval panel takes keyboard priority over hidden pickers and refreshes queue after approve", async () => {
    let pending = [createPending("prio-1"), createPending("prio-2")];
    const transport = createTestTransport();
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport,
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/model");
    expect(app.getLatest().modelPicker.active).toBe(true);

    await openApprovalPanelForTest(app, pending);
    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(app.getLatest().modelPicker.active).toBe(false);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(app.getLatest().pendingReviews.map(item => item.id)).toEqual(["prio-1"]);
    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(0);
    app.cleanup();
  });

  test("multiple approvals stay in panel until queue is empty", async () => {
    let pending = [
      createPending("multi-1", "write_file", "same.py"),
      createPending("multi-2", "write_file", "same.py"),
      createPending("multi-3", "write_file", "same.py"),
    ];

    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await openApprovalPanelForTest(app, pending);
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(2);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(app.getLatest().pendingReviews.map(item => item.id)).toEqual([
      "multi-1",
      "multi-2",
    ]);
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(1);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(app.getLatest().pendingReviews.map(item => item.id)).toEqual(["multi-1"]);
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(0);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(app.getLatest().pendingReviews).toHaveLength(0);
    app.cleanup();
  });

  test("approval failure keeps panel open and queue intact", async () => {
    let pending = [
      createPending("fail-1", "write_file", "same.py"),
      createPending("fail-2", "write_file", "same.py"),
    ];

    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => ({
        ok: false,
        message: `[approve failed] ${id}\npermission denied`,
      })),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(app.getLatest().approvalPanel.selectedIndex).toBe(1);
    expect(app.getLatest().approvalPanel.blockedItemId).toBe("fail-2");
    expect(app.getLatest().approvalPanel.blockedReason).toContain("permission denied");
    expect(app.getLatest().pendingReviews.map(item => item.id)).toEqual([
      "fail-1",
      "fail-2",
    ]);
    expect(
      getTexts(app.getLatest().items).filter(text => text.includes("Approval error")).length
    ).toBe(1);
    app.cleanup();
  });

  test("approval action is rate-limited after fast repeated failure", async () => {
    const pending = [createPending("retry-1", "create_file", "same.py")];
    const approve = mock(async (id: string) => ({
      ok: false,
      message: `[approve failed] ${id}\nEEXIST`,
    }));

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => pending,
          approve,
          reject: mock((id: string) => ({ ok: true, message: `[rejected] ${id}` })),
        } as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("a", {});
      inputHandler?.("a", {});
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(approve).toHaveBeenCalledTimes(1);
    expect(app.getLatest().approvalPanel.blockedItemId).toBe("retry-1");
    expect(app.getLatest().approvalPanel.blockedReason).toContain("EEXIST");
    expect(
      getTexts(app.getLatest().items).filter(text => text.includes("Approval error")).length
    ).toBe(1);
    app.cleanup();
  });

  test("blocked approval item can be rejected and selection change clears blocked state", async () => {
    let pending = [createPending("block-1", "create_file", "same.py"), createPending("block-2")];
    const approve = mock(async (id: string) => ({
      ok: false,
      message: `[approve failed] ${id}\nEEXIST`,
    }));
    const reject = mock((id: string) => {
      pending = pending.filter(item => item.id !== id);
      return { ok: true, message: `[rejected] ${id}` };
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [...pending],
          approve,
          reject,
        } as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("", { upArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.blockedItemId).toBe("block-1");

    await act(async () => {
      inputHandler?.("", { downArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.selectedIndex).toBe(1);
    expect(app.getLatest().approvalPanel.blockedItemId).toBeNull();

    await act(async () => {
      inputHandler?.("", { upArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.blockedItemId).toBeNull();

    await act(async () => {
      inputHandler?.("r", {});
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(reject).toHaveBeenCalledTimes(1);
    expect(pending.map(item => item.id)).toEqual(["block-2"]);
    expect(app.getLatest().approvalPanel.blockedItemId).toBeNull();
    app.cleanup();
  });

  test("escape closes approval panel immediately and blocks trailing r/a keystrokes", async () => {
    let pending = [createPending("esc-1"), createPending("esc-2"), createPending("esc-3")];
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("", { escape: true });
      inputHandler?.("r", {});
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(app.getLatest().pendingReviews.map(item => item.id)).toEqual([
      "esc-1",
      "esc-2",
      "esc-3",
    ]);
    expect(mcpService.approve).not.toHaveBeenCalled();
    expect(mcpService.reject).not.toHaveBeenCalled();
    app.cleanup();
  });

  test("approval success resumes suspended task automatically", async () => {
    let pending = [createPending("resume-approve")];
    const resume = mock(async (_toolResultMessage: string) => ({ status: "completed" as const }));
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "awaiting_review" });
      onTextDelta("draft ");
      return { status: "suspended" as const, resume };
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [...pending],
          approve: mock(async (id: string) => {
            pending = [];
            return { ok: true, message: `[approved] ${id}\nCreated file: ok` };
          }),
          reject: mock((id: string) => ({ ok: true, message: `[rejected] ${id}` })),
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "create one file");
    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("a", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("[approved] resume-approve\nCreated file: ok");
    expect(app.getLatest().approvalPanel.active).toBe(false);
    app.cleanup();
  });

  test("reject success resumes suspended task automatically", async () => {
    let pending = [createPending("resume-reject")];
    const resume = mock(async (_toolResultMessage: string) => ({ status: "completed" as const }));
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "awaiting_review" });
      onTextDelta("draft ");
      return { status: "suspended" as const, resume };
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [...pending],
          approve: mock(async (id: string) => ({ ok: true, message: `[approved] ${id}\nok` })),
          reject: mock((id: string) => {
            pending = [];
            return { ok: true, message: `[rejected] ${id}` };
          }),
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "reject path");
    await openApprovalPanelForTest(app, pending);

    await act(async () => {
      inputHandler?.("r", {});
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("[rejected] resume-reject");
    expect(app.getLatest().approvalPanel.active).toBe(false);
    app.cleanup();
  });

  test("model picker keyboard wraps, pages, confirms and closes", async () => {
    const transport = createTestTransport({
      initialModel: "m1",
      models: ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"],
    });

    const app = renderHookHarness(() =>
      useChatApp({
        transport,
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(app, "/model");
    expect(app.getLatest().modelPicker.active).toBe(true);
    expect(app.getLatest().modelPicker.selectedIndex).toBe(0);

    await act(async () => {
      inputHandler?.("", { upArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().modelPicker.selectedIndex).toBe(9);

    await act(async () => {
      inputHandler?.("", { rightArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().modelPicker.selectedIndex).toBe(1);

    await act(async () => {
      inputHandler?.("", { return: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().currentModel).toBe("m2");
    expect(app.getLatest().modelPicker.active).toBe(false);
    app.cleanup();
  });

  test("sessions panel keyboard wraps, pages, resumes and closes", async () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      createSessionRecord(`session-${index + 1}`, {
        title: `Session ${index + 1}`,
        updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      })
    );

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(sessions),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(app, "/sessions");
    expect(app.getLatest().sessionsPanel.active).toBe(true);

    await act(async () => {
      inputHandler?.("", { upArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().sessionsPanel.selectedIndex).toBe(9);

    await act(async () => {
      inputHandler?.("", { leftArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().sessionsPanel.selectedIndex).toBe(1);

    await act(async () => {
      inputHandler?.("", { return: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().activeSessionId).toBe("session-9");
    expect(app.getLatest().sessionsPanel.active).toBe(false);
    app.cleanup();
  });

  test("resume picker keyboard pages, wraps and confirms", async () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      createSessionRecord(`resume-${index + 1}`, {
        title: `Resume ${index + 1}`,
        updatedAt: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      })
    );

    const app = renderHookHarness(() =>
      useChatApp({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(sessions),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(app, "/resume");
    expect(app.getLatest().resumePicker.active).toBe(true);

    await act(async () => {
      inputHandler?.("", { rightArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().resumePicker.selectedIndex).toBe(8);

    await act(async () => {
      inputHandler?.("", { downArrow: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().resumePicker.selectedIndex).toBe(9);

    await act(async () => {
      inputHandler?.("", { return: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().activeSessionId).toBe("resume-1");
    expect(app.getLatest().resumePicker.active).toBe(false);
    app.cleanup();
  });
});
