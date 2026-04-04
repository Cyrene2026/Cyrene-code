import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react-test-renderer";
import type { FileAction, PendingReviewItem, ToolRequest } from "../src/core/tools/mcp/types";
import type { QueryTransport } from "../src/core/query/transport";
import { useChatApp } from "../src/application/chat/useChatApp";
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

const useChatAppWithTestInput = (
  params: Parameters<typeof useChatApp>[0]
) =>
  useChatApp({
    ...params,
    inputAdapterHook: handler => {
      inputHandler = handler as typeof inputHandler;
    },
  });

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
      : action === "apply_patch"
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
          : action === "find_symbol"
            ? {
                action,
                path,
                symbol: "Demo",
              }
          : action === "find_references"
            ? {
                action,
                path,
                symbol: "Demo",
              }
          : action === "search_text_context"
            ? {
                action,
                path,
                query: "needle",
                before: 1,
                after: 1,
              }
            : action === "read_files" || action === "stat_paths"
              ? {
                  action,
                  path,
                  paths: ["other.py"],
                }
              : action === "read_range"
                ? {
                    action,
                    path,
                    startLine: 1,
                    endLine: 3,
                  }
                : action === "read_json"
                  ? {
                      action,
                      path,
                      jsonPath: "scripts.test",
                    }
                  : action === "read_yaml"
                    ? {
                        action,
                        path,
                        yamlPath: "services.api",
                      }
                  : action === "outline_file" || action === "stat_path" || action === "git_status" || action === "git_diff"
                  ? {
                      action,
                      path,
                    }
                  : action === "git_log"
                    ? {
                        action,
                        path,
                        maxResults: 5,
                      }
                    : action === "git_show"
                      ? {
                          action,
                          path,
                          revision: "abc1234",
                        }
                      : action === "git_blame"
                        ? {
                            action,
                            path,
                            startLine: 1,
                            endLine: 3,
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

  test("/help appends help text", async () => {
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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

  test("/undo calls mcp undo and appends returned message", async () => {
    const undoLastMutation = mock(async () => ({
      ok: true,
      message: "[undo] reverted write_file: restored notes.txt",
    }));
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
          undoLastMutation,
        } as any,
      })
    );

    await runCommand(app, "/undo");

    expect(undoLastMutation).toHaveBeenCalledTimes(1);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("[undo] reverted write_file: restored notes.txt")
      )
    ).toBe(true);
    app.cleanup();
  });

  test("/tag add|list|remove manages current session tags", async () => {
    const sessionStore = createTestSessionStore();
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
          undoLastMutation: async () => ({ ok: false, message: "Nothing to undo." }),
        } as any,
      })
    );

    await runCommand(app, "/tag add urgent");
    await runCommand(app, "/tag list");
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("#urgent"))
    ).toBe(true);

    await runCommand(app, "/tag remove urgent");
    await runCommand(app, "/tag list");
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("No tags yet. Use /tag add <tag>."))
    ).toBe(true);

    app.cleanup();
  });

  test("/search-session finds sessions by query and tag", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-1", {
        title: "alpha feature rollout",
        tags: ["feature"],
        messages: [
          {
            role: "user",
            text: "investigate flaky feature tests",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      createSessionRecord("session-2", {
        title: "ops cleanup",
        tags: ["maintenance"],
      }),
    ]);
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
          undoLastMutation: async () => ({ ok: false, message: "Nothing to undo." }),
        } as any,
      })
    );

    await runCommand(app, "/search-session feature");
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("session-1 | alpha feature rollout"))
    ).toBe(true);

    await runCommand(app, "/search-session #maintenance");
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("session-2 | ops cleanup"))
    ).toBe(true);

    app.cleanup();
  });

  test("free input supports terminal-style history with up/down arrows", async () => {
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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

  test("/provider opens picker and /provider <url> switches provider", async () => {
    const transport = createTestTransport({
      initialProvider: "https://provider-a.test/v1",
      providers: ["https://provider-a.test/v1", "https://provider-b.test/v1"],
    });
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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

    await runCommand(app, "/provider");

    expect(app.getLatest().providerPicker.active).toBe(true);
    expect(app.getLatest().providerPicker.providers).toEqual([
      "https://provider-a.test/v1",
      "https://provider-b.test/v1",
    ]);

    await act(async () => {
      app.getLatest().setInput("");
      inputHandler?.("", { escape: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    await runCommand(app, "/provider https://provider-b.test/v1");

    expect(app.getLatest().currentProvider).toBe("https://provider-b.test/v1");
    app.cleanup();
  });

  test("exitSummary tracks the current model after /model switch", async () => {
    const transport = createTestTransport();
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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

    await runCommand(app, "/model gpt-next");

    expect(app.getLatest().currentModel).toBe("gpt-next");
    expect(app.getLatest().exitSummary.currentModel).toBe("gpt-next");
    app.cleanup();
  });

  test("startup sync prefers initialized transport model over initial placeholder", async () => {
    let currentModel = "gpt-placeholder";
    const transport: QueryTransport = {
      getModel: () => currentModel,
      getProvider: () => "https://provider.test/v1",
      setModel: async model => {
        currentModel = model;
        return { ok: true, message: `Model switched to ${model}` };
      },
      listModels: async () => {
        currentModel = "gpt-from-yaml";
        return ["gpt-from-yaml", "gpt-next"];
      },
      listProviders: async () => ["https://provider.test/v1"],
      setProvider: async provider => ({
        ok: true,
        message: `Provider switched to: ${provider}`,
        currentProvider: provider,
        providers: [provider],
        models: ["gpt-from-yaml", "gpt-next"],
      }),
      refreshModels: async () => ({
        ok: true,
        message: "Models refreshed",
        models: ["gpt-from-yaml", "gpt-next"],
      }),
      summarizeText: async () => ({ ok: false, message: "summary unavailable" }),
      requestStreamUrl: async query => `stream://${query}`,
      stream: async function* () {},
    };

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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

    expect(app.getLatest().currentModel).toBe("gpt-placeholder");
    await flushMicrotasks();
    expect(app.getLatest().currentModel).toBe("gpt-from-yaml");
    app.cleanup();
  });

  test("multiline paste is preserved for submission while showing a stable display token", async () => {
    const submitted: string[] = [];
    const runQuerySessionImpl = mock(async ({ originalTask, onState }: any) => {
      submitted.push(originalTask);
      onState({ status: "idle" });
      return { status: "completed" as const };
    });
    const sessionStore = createTestSessionStore();

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await act(async () => {
      inputHandler?.("first line\nsecond line", {} as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().input).toContain("↩");

    await act(async () => {
      app.getLatest().submit();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(submitted).toEqual(["first line\nsecond line"]);
    const record = sessionStore.__listRecords()[0];
    expect(record?.messages[0]?.text).toBe("first line\nsecond line");
    app.cleanup();
  });

  test("/sessions and /resume handle empty and populated session lists", async () => {
    const markdownReply = [
      "## Heading",
      "",
      "- item 1",
      "- `Token` item",
      "",
      "```py",
      "print('ok')",
      "```",
    ].join("\n");
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        title: "A",
        messages: [
          { role: "user", text: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
          {
            role: "assistant",
            text: markdownReply,
            createdAt: "2026-01-01T00:01:00.000Z",
          },
        ],
      }),
    ]);

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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
    expect(getTexts(app.getLatest().items)).toContain(markdownReply);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("some Markdown structure may not fully recover")
      )
    ).toBe(false);

    await runCommand(app, "/resume missing");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Session not found: missing"))).toBe(true);
    app.cleanup();
  });

  test("/resume shows a light hint for likely legacy-compressed markdown", async () => {
    const legacyCompressed = "## Heading - item 1 **bold** --- ```ts const value = 1 ```";
    const sessionStore = createTestSessionStore([
      createSessionRecord("legacy-a", {
        messages: [
          {
            role: "assistant",
            text: legacyCompressed,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ]);

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(app, "/resume legacy-a");

    expect(getTexts(app.getLatest().items)).toContain(legacyCompressed);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("some Markdown structure may not fully recover")
      )
    ).toBe(true);
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
      useChatAppWithTestInput({
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
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("risk: high"))
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("batch: /approve low | /approve all | /reject all"))
    ).toBe(true);

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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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

  test("keeps streaming assistant text outside committed transcript until completion", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>(resolve => {
      releaseStream = resolve;
    });

    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("draft reply");
      await streamGate;
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await act(async () => {
      app.getLatest().setInput("stream this");
      await Promise.resolve();
    });
    await flushMicrotasks();
    await act(async () => {
      app.getLatest().submit();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().liveAssistantText).toBe("draft reply");
    expect(getTexts(app.getLatest().items).includes("draft reply")).toBe(false);

    await act(async () => {
      releaseStream();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().liveAssistantText).toBe("");
    expect(getTexts(app.getLatest().items)).toContain("draft reply");
    app.cleanup();
  });

  test("pins enforce upper limit and unpin validates index", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        focus: ["a", "b"],
      }),
    ]);

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
    expect(getTexts(app.getLatest().items).some(text => text.includes("use: /reject <id>"))).toBe(true);

    await runCommand(app, "/reject r1");
    expect(pending.map(item => item.id)).toEqual(["r2"]);
    expect(getTexts(app.getLatest().items).some(text => text.includes("Rejected"))).toBe(true);
    app.cleanup();
  });

  test("/approve low bulk-approves non-high-risk operations only", async () => {
    let pending = [
      createPending("b1", "create_file", "safe.txt"),
      createPending("b2", "edit_file", "risky.ts"),
    ];
    const approvedIds: string[] = [];
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        approvedIds.push(id);
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/approve low");
    await flushMicrotasks();
    expect(approvedIds).toEqual(["b1"]);
    expect(pending.map(item => item.id)).toEqual(["b2"]);
    expect(getTexts(app.getLatest().items).some(text => text.includes("Batch approved"))).toBe(true);
    app.cleanup();
  });

  test("/approve all bulk-approves every pending operation", async () => {
    let pending = [createPending("a1"), createPending("a2", "edit_file", "x.ts")];
    const approvedIds: string[] = [];
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        approvedIds.push(id);
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/approve all");
    await flushMicrotasks();
    expect(approvedIds).toEqual(["a1", "a2"]);
    expect(pending).toHaveLength(0);
    app.cleanup();
  });

  test("/reject all rejects all pending operations in one batch", async () => {
    let pending = [createPending("ra"), createPending("rb")];
    const rejectedIds: string[] = [];
    const mcpService = {
      listPending: () => [...pending],
      approve: mock(async (id: string) => {
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[approved] ${id}\nok` };
      }),
      reject: mock((id: string) => {
        rejectedIds.push(id);
        pending = pending.filter(item => item.id !== id);
        return { ok: true, message: `[rejected] ${id}` };
      }),
    };

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: mcpService as any,
      })
    );

    await runCommand(app, "/reject all");
    expect(rejectedIds).toEqual(["ra", "rb"]);
    expect(pending).toHaveLength(0);
    expect(getTexts(app.getLatest().items).some(text => text.includes("Batch rejected"))).toBe(true);
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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

  test("assistant markdown output is stored verbatim instead of being condensed", async () => {
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const markdownOutput = [
      "## Build Plan",
      "",
      "- keep markdown",
      "- keep `code`",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");

    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta(markdownOutput);
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
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

    const activeSessionId = app.getLatest().activeSessionId;
    expect(activeSessionId).toBeTruthy();
    const stored = sessionStore.__getRecord(activeSessionId!);
    const assistantMessage = stored?.messages.findLast(message => message.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.text).toBe(markdownOutput);
    app.cleanup();
  });

  test("refreshes AI summary lazily for long sessions, shows token hint, and invalidates stored summary after new turns", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        summary: "",
        messages: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `message ${index + 1} about oauth and api behavior`,
          createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        })),
      }),
    ]) as TestSessionStore;
    const summarizeImpl = mock(async () => ({
      ok: true as const,
      text: "- task: continue oauth work\n- fact: api behavior confirmed",
      usage: {
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
      },
    }));
    const baseUpdateSummary = sessionStore.updateSummary;
    const updateSummary = mock((id: string, summary: string) =>
      baseUpdateSummary(id, summary)
    );
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("reply\n- keeps markdown");
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({ summarizeImpl }),
        sessionStore: {
          ...sessionStore,
          updateSummary,
        },
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "/resume session-a");
    await runCommand(app, "continue the oauth task");
    await flushMicrotasks();

    expect(summarizeImpl).toHaveBeenCalledTimes(1);
    expect(updateSummary).toHaveBeenCalledTimes(1);
    expect(getTexts(app.getLatest().items).some(text => text.includes("summary updated | prompt 21 | completion 9 | total 30"))).toBe(true);

    const stored = sessionStore.__getRecord("session-a");
    expect(stored?.summary).toBe("");
    expect(stored?.messages.findLast(message => message.role === "assistant")?.text).toBe(
      "reply\n- keeps markdown"
    );
    app.cleanup();
  });

  test("existing persisted summary skips AI refresh and summary failure does not block the turn", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        summary: "- existing summary",
        messages: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `message ${index + 1}`,
          createdAt: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        })),
      }),
      createSessionRecord("session-b", {
        summary: "",
        messages: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `other message ${index + 1}`,
          createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        })),
      }),
    ]);
    const summarizeExisting = mock(async () => ({
      ok: true as const,
      text: "- should not run",
    }));
    const runExisting = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("done existing");
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const existingApp = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({ summarizeImpl: summarizeExisting }),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl: runExisting,
      })
    );

    await runCommand(existingApp, "/resume session-a");
    await runCommand(existingApp, "continue");
    await flushMicrotasks();

    expect(summarizeExisting).toHaveBeenCalledTimes(0);
    expect(getTexts(existingApp.getLatest().items)).toContain("done existing");
    existingApp.cleanup();

    const summarizeFailure = mock(async () => ({
      ok: false as const,
      message: "provider unavailable",
    }));
    const runFailure = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("done after summary failure");
      onState({ status: "idle" });
      return { status: "completed" as const };
    });

    const failureApp = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({ summarizeImpl: summarizeFailure }),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl: runFailure,
      })
    );

    await runCommand(failureApp, "/resume session-b");
    await runCommand(failureApp, "continue despite failure");
    await flushMicrotasks();

    expect(summarizeFailure).toHaveBeenCalledTimes(1);
    expect(runFailure).toHaveBeenCalledTimes(1);
    expect(getTexts(failureApp.getLatest().items)).toContain("done after summary failure");
    expect(
      getTexts(failureApp.getLatest().items).some(text => text.includes("summary updated"))
    ).toBe(false);
    failureApp.cleanup();
  });

  test("exitSummary accumulates query and summary usage across resume and new session flows", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        summary: "",
        messages: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `message ${index + 1} about oauth and review state`,
          createdAt: `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        })),
      }),
    ]) as TestSessionStore;
    const summarizeImpl = mock(async () => ({
      ok: true as const,
      text: "- task: continue oauth work\n- fact: previous steps confirmed",
      usage: {
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
      },
    }));
    let turn = 0;
    const runQuerySessionImpl = mock(
      async ({ onState, onTextDelta, onUsage }: any) => {
        const usageByTurn = [
          {
            promptTokens: 10,
            completionTokens: 4,
            totalTokens: 14,
            reply: "first reply",
          },
          {
            promptTokens: 8,
            completionTokens: 3,
            totalTokens: 11,
            reply: "second reply",
          },
        ];
        const current = usageByTurn[turn] ?? usageByTurn[usageByTurn.length - 1]!;
        turn += 1;
        onState({ status: "streaming" });
        onUsage?.({
          promptTokens: current.promptTokens,
          completionTokens: current.completionTokens,
          totalTokens: current.totalTokens,
        });
        onTextDelta(current.reply);
        onState({ status: "idle" });
        return { status: "completed" as const };
      }
    );

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({
          initialModel: "gpt-test",
          models: ["gpt-test", "gpt-next"],
          summarizeImpl,
        }),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "/resume session-a");
    await runCommand(app, "continue the oauth task");
    await flushMicrotasks();

    expect(app.getLatest().exitSummary).toMatchObject({
      activeSessionId: "session-a",
      currentModel: "gpt-test",
      requestCount: 1,
      summaryRequestCount: 1,
      promptTokens: 31,
      completionTokens: 13,
      totalTokens: 44,
    });

    await runCommand(app, "/new");
    await runCommand(app, "fresh turn");
    await flushMicrotasks();

    expect(app.getLatest().exitSummary).toMatchObject({
      activeSessionId: "session-2",
      currentModel: "gpt-test",
      requestCount: 2,
      summaryRequestCount: 1,
      promptTokens: 39,
      completionTokens: 16,
      totalTokens: 55,
    });
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
    expect(app.getLatest().pendingReviews).toHaveLength(0);
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(app.getLatest().approvalPanel.inFlightId).toBeNull();
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
      useChatAppWithTestInput({
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
