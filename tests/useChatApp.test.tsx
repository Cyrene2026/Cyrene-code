import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react-test-renderer";
import type {
  FileAction,
  PendingReviewItem,
  ToolRequest,
} from "../src/core/mcp";
import type { QueryTransport } from "../src/core/query/transport";
import {
  CYRENE_STATE_UPDATE_END_TAG,
  CYRENE_STATE_UPDATE_START_TAG,
} from "../src/core/session/stateReducer";
import { runQuerySession } from "../src/core/query/runQuerySession";
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

const withStateUpdate = (visible: string, update: Record<string, unknown>) =>
  `${visible}${CYRENE_STATE_UPDATE_START_TAG}${JSON.stringify(update)}${CYRENE_STATE_UPDATE_END_TAG}`;

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

  test("auto onboarding opens once on startup and can be skipped without reopening", async () => {
    const authStatus = {
      mode: "local" as const,
      credentialSource: "none" as const,
      provider: "none",
      model: "gpt-4o-mini",
      persistenceTarget: {
        kind: "shell_rc_block" as const,
        shell: "zsh" as const,
        path: "/Users/test/.zshrc",
        label: "zsh profile",
        managedByCyrene: true as const,
      },
      onboardingAvailable: true,
      httpReady: false,
    };
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({
          initialModel: "local-core",
          initialProvider: "local-core",
          models: ["local-core"],
          providers: ["local-core"],
        }),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        auth: {
          status: authStatus,
          getStatus: async () => authStatus,
          saveLogin: async () => ({
            ok: true,
            message: "saved",
            status: {
              ...authStatus,
              mode: "http",
              credentialSource: "user_env",
              provider: "https://provider.test/v1",
              httpReady: true,
            },
          }),
          logout: async () => ({
            ok: true,
            message: "logged out",
            status: authStatus,
          }),
        },
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await flushMicrotasks();

    expect(app.getLatest().authPanel.active).toBe(true);
    expect(app.getLatest().authPanel.mode).toBe("auto_onboarding");

    await act(async () => {
      inputHandler?.("", { escape: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().authPanel.active).toBe(false);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Login skipped. Continuing in local-core mode.")
      )
    ).toBe(true);

    app.rerender();
    await flushMicrotasks();
    expect(app.getLatest().authPanel.active).toBe(false);
    app.cleanup();
  });

  test("/login opens the auth wizard without creating a session", async () => {
    const authStatus = {
      mode: "local" as const,
      credentialSource: "none" as const,
      provider: "none",
      model: "gpt-4o-mini",
      persistenceTarget: null,
      onboardingAvailable: false,
      httpReady: false,
    };
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({
          initialModel: "local-core",
          initialProvider: "local-core",
          models: ["local-core"],
          providers: ["local-core"],
        }),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        auth: {
          status: authStatus,
          getStatus: async () => authStatus,
          saveLogin: async () => ({
            ok: true,
            message: "saved",
            status: authStatus,
          }),
          logout: async () => ({
            ok: true,
            message: "logged out",
            status: authStatus,
          }),
        },
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/login");

    expect(app.getLatest().authPanel.active).toBe(true);
    expect(app.getLatest().authPanel.mode).toBe("manual_login");
    expect(app.getLatest().activeSessionId).toBeNull();
    app.cleanup();
  });

  test("/login provider step supports 1/2/3 preset shortcuts", async () => {
    const authStatus = {
      mode: "local" as const,
      credentialSource: "none" as const,
      provider: "none",
      model: "gpt-4o-mini",
      persistenceTarget: null,
      onboardingAvailable: false,
      httpReady: false,
    };
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({
          initialModel: "local-core",
          initialProvider: "local-core",
          models: ["local-core"],
          providers: ["local-core"],
        }),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        auth: {
          status: authStatus,
          getStatus: async () => authStatus,
          saveLogin: async () => ({
            ok: true,
            message: "saved",
            status: authStatus,
          }),
          logout: async () => ({
            ok: true,
            message: "logged out",
            status: authStatus,
          }),
        },
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/login");
    expect(app.getLatest().authPanel.step).toBe("provider");

    await act(async () => {
      inputHandler?.("2", {} as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().authPanel.step).toBe("api_key");
    expect(app.getLatest().authPanel.providerBaseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    expect(app.getLatest().authPanel.info).toContain("Preset selected: Gemini");

    app.cleanup();
  });

  test("successful login stays out of transcript/session storage and masks the API key", async () => {
    const sessionStore = createTestSessionStore();
    const saveLogin = mock(async (input: {
      providerBaseUrl: string;
      apiKey: string;
      model?: string;
    }) => ({
      ok: true,
      message: `Saved login to zsh profile (${input.providerBaseUrl}). Switched to HTTP mode.`,
      status: {
        mode: "http" as const,
        credentialSource: "user_env" as const,
        provider: input.providerBaseUrl,
        model: input.model ?? "gpt-4o-mini",
        persistenceTarget: {
          kind: "shell_rc_block" as const,
          shell: "zsh" as const,
          path: "/Users/test/.zshrc",
          label: "zsh profile",
          managedByCyrene: true as const,
        },
        onboardingAvailable: true,
        httpReady: true,
      },
    }));

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport({
          initialModel: "local-core",
          initialProvider: "local-core",
          models: ["local-core"],
          providers: ["local-core"],
        }),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        auth: {
          status: {
            mode: "local" as const,
            credentialSource: "none" as const,
            provider: "none",
            model: "gpt-4o-mini",
            persistenceTarget: {
              kind: "shell_rc_block" as const,
              shell: "zsh" as const,
              path: "/Users/test/.zshrc",
              label: "zsh profile",
              managedByCyrene: true as const,
            },
            onboardingAvailable: false,
            httpReady: false,
          },
          getStatus: async () => ({
            mode: "local" as const,
            credentialSource: "none" as const,
            provider: "none",
            model: "gpt-4o-mini",
            persistenceTarget: null,
            onboardingAvailable: false,
            httpReady: false,
          }),
          saveLogin,
          logout: async () => ({
            ok: true,
            message: "logged out",
            status: {
              mode: "local" as const,
              credentialSource: "none" as const,
              provider: "none",
              model: "gpt-4o-mini",
              persistenceTarget: null,
              onboardingAvailable: true,
              httpReady: false,
            },
          }),
        },
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/login");

    await act(async () => {
      inputHandler?.("https://provider.test/v1", {} as any);
      await Promise.resolve();
    });
    await flushMicrotasks();
    await act(async () => {
      inputHandler?.("", { return: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      inputHandler?.("sk-secret-login", {} as any);
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(app.getLatest().authPanel.apiKey).toBe("sk-secret-login");

    await act(async () => {
      inputHandler?.("", { return: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();
    await act(async () => {
      inputHandler?.("", { return: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();
    await act(async () => {
      inputHandler?.("", { return: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(saveLogin).toHaveBeenCalledWith({
      providerBaseUrl: "https://provider.test/v1",
      apiKey: "sk-secret-login",
      model: "gpt-4o-mini",
    });
    expect(app.getLatest().authPanel.active).toBe(false);
    expect(getTexts(app.getLatest().items).join("\n")).not.toContain("sk-secret-login");
    expect(sessionStore.__listRecords()).toHaveLength(0);
    app.cleanup();
  });

type ScriptedTransportEvent =
  | { type: "tool_call"; toolName: string; input: unknown }
  | { type: "text_delta"; text: string };

const createScriptedTransport = (
  rounds: ScriptedTransportEvent[][]
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
      const round = rounds[index] ?? [];
      for (const event of round) {
        yield JSON.stringify(event);
      }
      yield JSON.stringify({ type: "done" });
    },
  };
};

  test("/state shows reducer diagnostics without creating a session", async () => {
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        autoSummaryRefresh: true,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/state");

    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Reducer state:\nauto summary refresh: enabled")
      )
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("note: no active session loaded yet.")
      )
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("pending choice: (none)")
      )
    ).toBe(true);
    expect(app.getLatest().activeSessionId).toBeNull();
    app.cleanup();
  });

  test("/state reports summary and pendingDigest diagnostics for the active session", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        summary: "OBJECTIVE:\n- ship reducer wiring",
        pendingDigest: "COMPLETED:\n- added digest tracking",
        pendingChoice: {
          capturedAt: "2026-01-01T00:00:01.000Z",
          sourcePreview: "你回复一个数字，我就继续。",
          options: [
            { index: 1, label: "补 README" },
            { index: 2, label: "补 requests 示例" },
          ],
        },
        lastStateUpdate: {
          code: "applied",
          message: "State update applied in merge_and_digest.",
          updatedAt: "2026-01-01T00:00:00.000Z",
          reducerMode: "merge_and_digest",
          summaryLength: 33,
          pendingDigestLength: 35,
        },
        messages: [
          {
            role: "user",
            text: "resume this",
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
        autoSummaryRefresh: true,
        mcpService: {
          listPending: () => [],
        } as any,
      })
    );

    await runCommand(app, "/resume session-a");
    await runCommand(app, "/state");

    expect(
      getTexts(app.getLatest().items).some(text => text.includes("session: session-a"))
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("last state update: applied / merge_and_digest")
      )
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("pending digest chars:")
      )
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("pending choice: 2 options")
      )
    ).toBe(true);
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

  test("/mcp commands expose runtime summary, servers, tools and pending queue", async () => {
    const pending = [
      {
        ...createPending("m1", "create_file", "safe.txt"),
        serverId: "filesystem",
      },
    ];
    const mcpService = {
      listPending: () => pending,
      listServers: () => [
        {
          id: "filesystem",
          label: "Filesystem",
          enabled: true,
          source: "built_in" as const,
          health: "online" as const,
          transport: "filesystem" as const,
          aliases: ["file", "fs", "mcp.file"],
          tools: [
            {
              id: "filesystem.read_file",
              serverId: "filesystem",
              name: "read_file",
              label: "read file",
              capabilities: ["read"] as const,
              risk: "low" as const,
              requiresReview: false,
              enabled: true,
            },
          ],
        },
        {
          id: "docs",
          label: "Docs",
          enabled: true,
          source: "local" as const,
          health: "error" as const,
          transport: "stdio" as const,
          aliases: ["docs"],
          tools: [
            {
              id: "docs.search_docs",
              serverId: "docs",
              name: "search_docs",
              label: "search docs",
              capabilities: ["read", "search"] as const,
              risk: "low" as const,
              requiresReview: false,
              enabled: true,
            },
          ],
        },
      ],
      listTools: (serverId?: string) =>
        serverId === "docs"
          ? [
              {
                id: "docs.search_docs",
                serverId: "docs",
                name: "search_docs",
                label: "search docs",
                capabilities: ["read", "search"] as const,
                risk: "low" as const,
                requiresReview: false,
                enabled: true,
              },
            ]
          : serverId === "filesystem"
            ? [
                {
                  id: "filesystem.read_file",
                  serverId: "filesystem",
                  name: "read_file",
                  label: "read file",
                  capabilities: ["read"] as const,
                  risk: "low" as const,
                  requiresReview: false,
                  enabled: true,
                },
              ]
            : [],
      describeRuntime: () => ({
        primaryServerId: "filesystem",
        serverCount: 2,
        enabledServerCount: 2,
        configPaths: ["D:/Projects/js_projects/Cyrene-code/.cyrene/mcp.yaml"],
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

    await runCommand(app, "/mcp");
    await runCommand(app, "/mcp servers");
    await runCommand(app, "/mcp tools docs");
    await runCommand(app, "/mcp pending");

    const texts = getTexts(app.getLatest().items);
    expect(texts.some(text => text.includes("MCP runtime"))).toBe(true);
    expect(texts.some(text => text.includes("config:"))).toBe(true);
    expect(texts.some(text => text.includes("- filesystem |"))).toBe(true);
    expect(texts.some(text => text.includes("MCP tools for docs"))).toBe(true);
    expect(texts.some(text => text.includes("search_docs"))).toBe(true);
    expect(texts.some(text => text.includes("server filesystem"))).toBe(true);

    app.cleanup();
  });

  test("/mcp management commands call runtime mutation hooks", async () => {
    const addServer = mock(async () => ({
      ok: true,
      message: "MCP server added: docs\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/mcp.yaml",
    }));
    const removeServer = mock(async (id: string) => ({
      ok: true,
      message: `MCP server removed: ${id}\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/mcp.yaml`,
    }));
    const setServerEnabled = mock(async (id: string, enabled: boolean) => ({
      ok: true,
      message: `${enabled ? "MCP server enabled" : "MCP server disabled"}: ${id}\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/mcp.yaml`,
    }));
    const reloadConfig = mock(async () => ({
      ok: true,
      message: "MCP config reloaded\nservers: 3\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/mcp.yaml",
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
          addServer,
          removeServer,
          setServerEnabled,
          reloadConfig,
        } as any,
      })
    );

    await runCommand(app, '/mcp add stdio docs "node" "scripts/mcp-server.mjs" "--watch"');
    await runCommand(app, "/mcp disable docs");
    await runCommand(app, "/mcp enable docs");
    await runCommand(app, "/mcp remove docs");
    await runCommand(app, "/mcp reload");

    expect(addServer).toHaveBeenCalledWith({
      id: "docs",
      transport: "stdio",
      command: "node",
      args: ["scripts/mcp-server.mjs", "--watch"],
    });
    expect(setServerEnabled).toHaveBeenCalledWith("docs", false);
    expect(setServerEnabled).toHaveBeenCalledWith("docs", true);
    expect(removeServer).toHaveBeenCalledWith("docs");
    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("MCP config reloaded"))
    ).toBe(true);

    app.cleanup();
  });

  test("/skills commands expose runtime summary, list and enable/disable/remove/use flow", async () => {
    const setSkillEnabled = mock(async (skillId: string, enabled: boolean) => ({
      ok: true,
      message: `${enabled ? "Skill enabled" : "Skill disabled"}: ${skillId}\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/skills.yaml`,
    }));
    const removeSkill = mock(async (skillId: string) => ({
      ok: true,
      message: `Skill removed: ${skillId}\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/skills.yaml`,
    }));
    const reloadConfig = mock(async () => ({
      ok: true,
      message: "Skills config reloaded\nskills: 3 total | 2 enabled\nconfig: D:/Projects/js_projects/Cyrene-code/.cyrene/skills.yaml",
    }));
    const skillsService = {
      listSkills: () => [
        {
          id: "code-review",
          label: "Code Review",
          description: "review findings first",
          prompt: "focus on concrete findings",
          triggers: ["review", "审查"],
          enabled: true,
          source: "built_in" as const,
          configPath: "D:/Projects/js_projects/Cyrene-code/.cyrene/skills.yaml",
        },
      ],
      describeRuntime: () => ({
        skillCount: 1,
        enabledSkillCount: 1,
        configPaths: ["D:/Projects/js_projects/Cyrene-code/.cyrene/skills.yaml"],
        editableConfigPath: "D:/Projects/js_projects/Cyrene-code/.cyrene/skills.yaml",
      }),
      setSkillEnabled,
      removeSkill,
      reloadConfig,
      resolveForQuery: () => [],
    };

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
        skillsService: skillsService as any,
      })
    );

    await runCommand(app, "/skills");
    await runCommand(app, "/skills list");
    await runCommand(app, "/skills show code-review");
    await runCommand(app, "/skills disable code-review");
    await runCommand(app, "/skills enable code-review");
    await runCommand(app, "/skills use code-review");
    await runCommand(app, "/skills remove code-review");
    await runCommand(app, "/skills reload");

    expect(setSkillEnabled).toHaveBeenCalledWith("code-review", false);
    expect(setSkillEnabled).toHaveBeenCalledWith("code-review", true);
    expect(removeSkill).toHaveBeenCalledWith("code-review");
    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("Skills runtime"))
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("Skill enabled: code-review"))
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text => text.includes("Skill code-review"))
    ).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Session skill activated: code-review")
      )
    ).toBe(true);

    app.cleanup();
  });

  test("active skills include session-level /skills use overrides before query run", async () => {
    const runQuerySessionImpl = mock(async (params: any) => {
      expect(String(params.query)).toContain("ACTIVE SKILLS");
      expect(String(params.query)).toContain("[code-review] Code Review");
      expect(String(params.query)).toContain("focus on concrete findings");
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
          handleToolCall: async () => ({ ok: true, message: "[tool result] noop" }),
        } as any,
        skillsService: {
          listSkills: () => [
            {
              id: "code-review",
              label: "Code Review",
              description: "review findings first",
              prompt: "focus on concrete findings",
              triggers: ["review"],
              enabled: true,
              source: "built_in" as const,
            },
          ],
          resolveForQuery: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "/skills use code-review");
    await runCommand(app, "please review this patch");
    expect(runQuerySessionImpl).toHaveBeenCalledTimes(1);

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

  test("empty composer up arrow recalls the latest history entry", async () => {
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
      inputHandler?.("", { upArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("second command");
    expect(app.getLatest().inputCommandState.historyPosition).toBe(2);

    app.cleanup();
  });

  test("up/down move the multiline cursor instead of recalling history when input is not empty", async () => {
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
      app.getLatest().setInput("alpha\nbeta\ngamma");
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().inputCursorOffset).toBe("alpha\nbeta\ngamma".length);

    await act(async () => {
      inputHandler?.("", { upArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("alpha\nbeta\ngamma");
    expect(app.getLatest().inputCursorOffset).toBe(10);
    expect(app.getLatest().inputCommandState.historyPosition).toBeNull();

    await act(async () => {
      inputHandler?.("", { downArrow: true } as any);
      await Promise.resolve();
    });
    expect(app.getLatest().input).toBe("alpha\nbeta\ngamma");
    expect(app.getLatest().inputCursorOffset).toBe("alpha\nbeta\ngamma".length);
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

  test("slash palette supports arrow navigation and tab autocomplete", async () => {
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
      app.getLatest().setInput("/mo");
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().inputCommandState.mode).toBe("command");
    expect(app.getLatest().inputCommandState.currentCommand).toBe("/model refresh");

    await act(async () => {
      inputHandler?.("", { downArrow: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().inputCommandState.selectedIndex).toBe(1);
    expect(app.getLatest().inputCommandState.currentCommand).toBe("/model <name>");

    await act(async () => {
      inputHandler?.("", { tab: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().input).toBe("/model ");
    app.cleanup();
  });

  test("slash suggestions expose palette groups and highlight ranges", async () => {
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
      app.getLatest().setInput("/mod ref");
      await Promise.resolve();
    });
    await flushMicrotasks();

    const refreshSuggestion = app
      .getLatest()
      .inputCommandState.suggestions.find(
        suggestion => suggestion.command === "/model refresh"
      );

    expect(refreshSuggestion?.group).toBe("Model & provider");
    expect(refreshSuggestion?.matchRanges).toEqual([
      { start: 0, end: 4 },
      { start: 7, end: 10 },
    ]);
    expect(refreshSuggestion?.baseCommand).toBe("/model");
    expect(refreshSuggestion?.template).toBe("refresh");
    expect(refreshSuggestion?.argumentHints).toEqual([]);

    const modelSuggestion = app
      .getLatest()
      .inputCommandState.suggestions.find(
        suggestion => suggestion.command === "/model <name>"
      );

    expect(modelSuggestion?.baseCommand).toBe("/model");
    expect(modelSuggestion?.template).toBe("<name>");
    expect(modelSuggestion?.argumentHints).toEqual([
      {
        label: "name",
        optional: false,
      },
    ]);
    expect(modelSuggestion?.insertValue).toBe("/model ");

    app.cleanup();
  });

  test("!shell submits direct shell requests without starting a query session", async () => {
    const pending: PendingReviewItem = {
      id: "shell-1",
      request: {
        action: "run_shell",
        path: ".",
        command: "bun test",
      },
      preview: "preview",
      previewSummary: "summary",
      previewFull: "full",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const handleToolCall = mock(async (_toolName: string, request: unknown) => ({
      ok: true,
      pending,
      message: "[review required] shell-1",
    }));
    const runQuerySessionImpl = mock(async () => ({ status: "completed" as const }));
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [pending],
          handleToolCall,
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "!shell bun test");
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handleToolCall).toHaveBeenCalledWith("file", {
      action: "run_shell",
      path: ".",
      command: "bun test",
    });
    expect(runQuerySessionImpl).not.toHaveBeenCalled();
    expect(app.getLatest().approvalPanel.active).toBe(true);
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Approval required | run_shell . | shell-1 | panel opened")
      )
    ).toBe(true);
    app.cleanup();
  });

  test("!shell session actions keep shell session state in sync", async () => {
    const realDateNow = Date.now;
    let now = 1_710_000_000_000;
    Date.now = () => now;

    const handleToolCall = mock(async (_toolName: string, request: any) => {
      if (request.action === "open_shell") {
        return {
          ok: true,
          message: [
            "[tool result] open_shell .",
            "status: opened",
            "program: pwsh",
            "status: idle",
            "shell: pwsh",
            "cwd: workspace/subdir",
            "busy: false",
            "alive: true",
            "pending_output: false",
            "last_exit: unknown",
            "output_truncated: false",
            "output:",
            "(no new output)",
          ].join("\n"),
        };
      }

      if (request.action === "shell_status") {
        return {
          ok: true,
          message: [
            "[tool result] shell_status .",
            "status: running",
            "shell: pwsh",
            "cwd: workspace/subdir",
            "busy: true",
            "alive: true",
            "pending_output: true",
            "last_exit: 0",
            "output_truncated: false",
            "output:",
            "Compiling chat renderer",
            "Done in 0.48s",
          ].join("\n"),
        };
      }

      throw new Error(`Unexpected action: ${String(request.action)}`);
    });
    const runQuerySessionImpl = mock(async () => ({ status: "completed" as const }));
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
          handleToolCall,
        } as any,
        runQuerySessionImpl,
      })
    );

    try {
      await runCommand(app, "!shell open workspace/subdir");
      await flushMicrotasks();
      await flushMicrotasks();

      expect(runQuerySessionImpl).not.toHaveBeenCalled();
      expect(app.getLatest().shellSession).toEqual(
        expect.objectContaining({
          visible: true,
          status: "idle",
          shell: "pwsh",
          cwd: "workspace/subdir",
          alive: true,
          pendingOutput: false,
          lastEvent: "opened",
          openedAt: now,
          runningSince: null,
          lastOutputSummary: null,
          lastOutputAt: null,
        })
      );

      now += 9_000;
      await runCommand(app, "!shell status");
      await flushMicrotasks();
      await flushMicrotasks();

      expect(app.getLatest().shellSession).toEqual(
        expect.objectContaining({
          visible: true,
          status: "running",
          shell: "pwsh",
          cwd: "workspace/subdir",
          busy: true,
          alive: true,
          pendingOutput: true,
          lastExit: "0",
          openedAt: 1_710_000_000_000,
          runningSince: now,
          lastOutputSummary: "Compiling chat renderer  ·  Done in 0.48s",
          lastOutputAt: now,
        })
      );
    } finally {
      Date.now = realDateNow;
      app.cleanup();
    }
  });

  test("@file suggestions resolve via find_files and tab inserts the selected mention", async () => {
    const handleToolCall = mock(async (_toolName: string, request: unknown) => ({
      ok: true,
      message: [
        "[tool result] find_files .",
        "Found 2 file(s):",
        "src/frontend/components/ChatScreen.tsx",
        "tests/ChatScreen.test.tsx",
      ].join("\n"),
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
          handleToolCall,
        } as any,
      })
    );

    await act(async () => {
      app.getLatest().setInput("@chat");
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(app.getLatest().inputCommandState.mode).toBe("file");
    expect(app.getLatest().inputCommandState.fileMentions.activeQuery).toBe("chat");
    expect(app.getLatest().inputCommandState.fileMentions.suggestions[0]?.path).toBe(
      "src/frontend/components/ChatScreen.tsx"
    );
    expect(handleToolCall).toHaveBeenCalledWith("file", {
      action: "find_files",
      path: ".",
      pattern: "*chat*",
      maxResults: 6,
    });

    await act(async () => {
      inputHandler?.("", { downArrow: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().inputCommandState.selectedIndex).toBe(1);

    await act(async () => {
      inputHandler?.("", { tab: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().input).toBe("@tests/ChatScreen.test.tsx ");
    app.cleanup();
  });

  test("@file preview prefers contextual snippets when the query matches file contents", async () => {
    const handleToolCall = mock(async (_toolName: string, request: any) => {
      if (request.action === "find_files") {
        return {
          ok: true,
          message: [
            "[tool result] find_files .",
            "Found 1 file(s):",
            "src/frontend/components/ChatScreen.tsx",
          ].join("\n"),
        };
      }

      if (request.action === "search_text_context") {
        return {
          ok: true,
          message: [
            `[tool result] search_text_context ${request.path}`,
            "Found 1 contextual match(es):",
            `[match] ${request.path}:44`,
            "42 | const before = true;",
            "43 | const around = true;",
            "> 44 | const modelName = currentModel;",
            "45 | const after = false;",
          ].join("\n"),
        };
      }

      throw new Error(`Unexpected action: ${String(request.action)}`);
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
          handleToolCall,
        } as any,
      })
    );

    await act(async () => {
      app.getLatest().setInput("@model");
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handleToolCall).toHaveBeenCalledWith("file", {
      action: "search_text_context",
      path: "src/frontend/components/ChatScreen.tsx",
      query: "model",
      before: 2,
      after: 3,
      maxResults: 1,
    });
    expect(app.getLatest().inputCommandState.fileMentions.preview).toEqual(
      expect.objectContaining({
        path: "src/frontend/components/ChatScreen.tsx",
        meta: "context hit  |  lines 42-45",
        loading: false,
      })
    );
    expect(app.getLatest().inputCommandState.fileMentions.preview.text).toContain(
      "› const modelName = currentModel;"
    );

    app.cleanup();
  });

  test("@file preview falls back to syntax-aware symbol snippets for code files", async () => {
    const handleToolCall = mock(async (_toolName: string, request: any) => {
      if (request.action === "find_files") {
        return {
          ok: true,
          message: [
            "[tool result] find_files .",
            "Found 1 file(s):",
            "src/frontend/components/ChatScreen.tsx",
          ].join("\n"),
        };
      }

      if (request.action === "search_text_context") {
        return {
          ok: true,
          message: [
            `[tool result] search_text_context ${request.path}`,
            "Found 0 contextual match(es):",
          ].join("\n"),
        };
      }

      if (request.action === "outline_file") {
        return {
          ok: true,
          message: [
            `[tool result] outline_file ${request.path}`,
            `Outline for ${request.path}`,
            "10 | function renderComposerPalette(",
            "40 | function renderCommandPaletteRow(",
          ].join("\n"),
        };
      }

      if (request.action === "search_text_context") {
        return {
          ok: true,
          message: [
            `[tool result] search_text_context ${request.path}`,
            "Found 0 contextual match(es):",
          ].join("\n"),
        };
      }

      if (request.action === "outline_file") {
        return {
          ok: true,
          message: [
            `[tool result] outline_file ${request.path}`,
            `Outline for ${request.path}`,
          ].join("\n"),
        };
      }

      if (request.action === "read_range") {
        return {
          ok: true,
          message: [
            `[tool result] read_range ${request.path}`,
            `path: ${request.path}`,
            "lines: 39-44",
            " 39 |",
            " 40 | function renderCommandPaletteRow() {",
            " 41 |   return null;",
            " 42 | }",
          ].join("\n"),
        };
      }

      throw new Error(`Unexpected action: ${String(request.action)}`);
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
          handleToolCall,
        } as any,
      })
    );

    await act(async () => {
      app.getLatest().setInput("@command");
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handleToolCall).toHaveBeenCalledWith("file", {
      action: "outline_file",
      path: "src/frontend/components/ChatScreen.tsx",
    });
    expect(handleToolCall).toHaveBeenCalledWith("file", {
      action: "read_range",
      path: "src/frontend/components/ChatScreen.tsx",
      startLine: 39,
      endLine: 44,
    });
    expect(app.getLatest().inputCommandState.fileMentions.preview).toEqual(
      expect.objectContaining({
        path: "src/frontend/components/ChatScreen.tsx",
        meta: "symbol function renderCommandPaletteRow(  |  lines 39-44",
        loading: false,
      })
    );
    expect(app.getLatest().inputCommandState.fileMentions.preview.text).toContain(
      "function renderCommandPaletteRow() {"
    );

    app.cleanup();
  });

  test("@file preview loads a compact selected-file excerpt", async () => {
    const handleToolCall = mock(async (_toolName: string, request: any) => {
      if (request.action === "find_files") {
        return {
          ok: true,
          message: [
            "[tool result] find_files .",
            "Found 2 file(s):",
            "src/frontend/components/ChatScreen.tsx",
            "tests/ChatScreen.test.tsx",
          ].join("\n"),
        };
      }

      if (request.action === "read_range") {
        return {
          ok: true,
          message: [
            `[tool result] read_range ${request.path}`,
            `path: ${request.path}`,
            "lines: 1-8",
            '  1 | import React from "react";',
            '  2 | import { Box, Text } from "ink";',
            "  3 | const preview = true;",
          ].join("\n"),
        };
      }

      throw new Error(`Unexpected action: ${String(request.action)}`);
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
          handleToolCall,
        } as any,
      })
    );

    await act(async () => {
      app.getLatest().setInput("@chat");
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handleToolCall).toHaveBeenCalledWith("file", {
      action: "read_range",
      path: "src/frontend/components/ChatScreen.tsx",
      startLine: 1,
      endLine: 8,
    });
    expect(app.getLatest().inputCommandState.fileMentions.preview).toEqual(
      expect.objectContaining({
        path: "src/frontend/components/ChatScreen.tsx",
        meta: "lines 1-8",
        loading: false,
      })
    );
    expect(app.getLatest().inputCommandState.fileMentions.preview.text).toContain(
      'import React from "react";'
    );

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

  test("/model <name> ignores duplicate immediate submit", async () => {
    const setModelImpl = mock(async (model: string) => ({
      ok: true,
      message: `Model switched to: ${model}`,
    }));
    const transport = createTestTransport({ setModelImpl });
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

    await act(async () => {
      app.getLatest().setInput("/model gpt-next");
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      app.getLatest().submit();
      app.getLatest().submit();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(setModelImpl).toHaveBeenCalledTimes(1);
    expect(
      getTexts(app.getLatest().items).filter(
        text => text === "Model switched to: gpt-next"
      )
    ).toHaveLength(1);
    app.cleanup();
  });

  test("/provider opens picker and /provider <url> switches provider", async () => {
    const transport = createTestTransport({
      initialProvider: "https://provider-a.test/v1",
      providers: ["https://provider-a.test/v1", "https://provider-b.test/v1"],
      describeProviderImpl: provider => ({
        provider: provider?.trim() || "https://provider-a.test/v1",
        vendor: "openai",
        keySource:
          provider?.includes("provider-a") ?? false
            ? "CYRENE_OPENAI_API_KEY"
            : "CYRENE_API_KEY",
      }),
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
    expect(app.getLatest().providerPicker.currentKeySource).toBe(
      "CYRENE_OPENAI_API_KEY"
    );
    expect(app.getLatest().providerPicker.providerProfiles).toEqual({
      "https://provider-a.test/v1": "openai",
      "https://provider-b.test/v1": "openai",
    });
    expect(app.getLatest().providerPicker.providerProfileSources).toEqual({
      "https://provider-a.test/v1": "inferred",
      "https://provider-b.test/v1": "inferred",
    });

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

  test("/provider profile commands list and set manual overrides", async () => {
    const setProviderProfileImpl = mock(
      async (provider: string, profile: "openai" | "gemini" | "anthropic" | "custom") => ({
        ok: true,
        message:
          profile === "custom"
            ? `Provider profile override cleared: ${provider}`
            : `Provider profile override set: ${provider} => ${profile}`,
        provider,
        profile,
      })
    );
    const transport = createTestTransport({
      initialProvider: "https://relay.test/openai",
      providers: ["https://relay.test/openai"],
      providerProfileOverrides: {
        "https://relay.test/openai": "anthropic",
      },
      describeProviderImpl: provider => ({
        provider: provider?.trim() || "https://relay.test/openai",
        vendor: "anthropic",
        keySource: "CYRENE_ANTHROPIC_API_KEY",
      }),
      setProviderProfileImpl,
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

    await runCommand(app, "/provider profile list");
    expect(getTexts(app.getLatest().items)).toContain(
      "Manual provider profile overrides:\n- https://relay.test/openai => anthropic"
    );

    await runCommand(app, "/provider profile openai");
    expect(setProviderProfileImpl).toHaveBeenCalledWith(
      "https://relay.test/openai",
      "openai"
    );
    expect(getTexts(app.getLatest().items)).toContain(
      "Provider profile override set: https://relay.test/openai => openai"
    );

    await runCommand(app, "/provider profile clear");
    expect(setProviderProfileImpl).toHaveBeenLastCalledWith(
      "https://relay.test/openai",
      "custom"
    );
    expect(getTexts(app.getLatest().items)).toContain(
      "Provider profile override cleared: https://relay.test/openai"
    );
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

  test("normal query submit ignores duplicate immediate submit", async () => {
    const runQuerySessionImpl = mock(async ({ onState }: any) => {
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
      app.getLatest().setInput("same request");
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      app.getLatest().submit();
      app.getLatest().submit();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(1);
    expect(
      getTexts(app.getLatest().items).filter(text => text === "same request")
    ).toHaveLength(1);
    app.cleanup();
  });

  test("slash-prefixed unknown input is intercepted as a command error", async () => {
    const runQuerySessionImpl = mock(async () => ({ status: "completed" as const }));
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

    await runCommand(app, "/你好");
    await flushMicrotasks();

    expect(runQuerySessionImpl).not.toHaveBeenCalled();
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Unknown command: /你好")
      )
    ).toBe(true);
    expect(sessionStore.__listRecords()).toHaveLength(0);
    app.cleanup();
  });

  test("number-only follow-up resolves against the latest assistant numbered options", async () => {
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const submitted: string[] = [];
    let callCount = 0;
    const runQuerySessionImpl = mock(async ({ originalTask, onState, onTextDelta }: any) => {
      submitted.push(originalTask);
      callCount += 1;
      onState({ status: "streaming" });
      if (callCount === 1) {
        onTextDelta(
          [
            "如果你愿意，我下一步可以继续帮你：",
            "1. 补 README.md 的 curl 示例",
            "2. 补 Python requests 调用示例",
            "3. 补启动说明",
            "你回复一个数字，我就继续写进去。",
          ].join("\n")
        );
      } else {
        onTextDelta("已继续第 1 项。");
      }
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
        mcpService: {
          listPending: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "先给我几个选项");
    await flushMicrotasks();

    const firstSessionId = sessionStore.__listRecords()[0]?.id;
    expect(firstSessionId).toBeTruthy();
    expect(sessionStore.__getRecord(firstSessionId!)?.pendingChoice?.options.map(item => item.label)).toEqual([
      "补 README.md 的 curl 示例",
      "补 Python requests 调用示例",
      "补启动说明",
    ]);

    await runCommand(app, "1");
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(2);
    expect(submitted[1]).toContain("编号选项 1");
    expect(submitted[1]).toContain("补 README.md 的 curl 示例");
    expect(submitted[1]).not.toBe("1");
    expect(
      sessionStore
        .__getRecord(firstSessionId!)!
        .messages.map(message => message.text)
        .some(text => text.includes("1 → 补 README.md 的 curl 示例"))
    ).toBe(true);
    app.cleanup();
  });

  test("number-only follow-up without an active numbered menu is blocked locally", async () => {
    const runQuerySessionImpl = mock(async () => ({ status: "completed" as const }));
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

    await runCommand(app, "1");
    await flushMicrotasks();

    expect(runQuerySessionImpl).not.toHaveBeenCalled();
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("No active numbered options to resolve")
      )
    ).toBe(true);
    expect(sessionStore.__listRecords()).toHaveLength(0);
    app.cleanup();
  });

  test("resumed sessions restore pending numbered choices for a later numeric reply", async () => {
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        messages: [
          {
            role: "assistant",
            text: [
              "我可以继续：",
              "1. 补 README.md 的 curl 示例",
              "2. 补 Python requests 调用示例",
            ].join("\n"),
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        pendingChoice: {
          capturedAt: "2026-01-01T00:00:01.000Z",
          sourcePreview: "我可以继续：1. 补 README.md 的 curl 示例 2. 补 Python requests 调用示例",
          options: [
            { index: 1, label: "补 README.md 的 curl 示例" },
            { index: 2, label: "补 Python requests 调用示例" },
          ],
        },
      }),
    ]) as TestSessionStore;
    const submitted: string[] = [];
    const runQuerySessionImpl = mock(async ({ originalTask, onState, onTextDelta }: any) => {
      submitted.push(originalTask);
      onState({ status: "streaming" });
      onTextDelta("继续写第 1 项。");
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
        mcpService: {
          listPending: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "/resume session-a");
    await runCommand(app, "1");
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(1);
    expect(submitted[0]).toContain("补 README.md 的 curl 示例");
    expect(submitted[0]).not.toBe("1");
    expect(
      sessionStore
        .__getRecord("session-a")!
        .messages.map(message => message.text)
        .some(text => text.includes("1 → 补 README.md 的 curl 示例"))
    ).toBe(true);
    app.cleanup();
  });

  test("plain numbered assistant list without an explicit menu cue does not latch choices", async () => {
    const sessionStore = createTestSessionStore() as TestSessionStore;
    let callCount = 0;
    const submitted: string[] = [];
    const runQuerySessionImpl = mock(async ({ originalTask, onState, onTextDelta }: any) => {
      callCount += 1;
      submitted.push(originalTask);
      onState({ status: "streaming" });
      if (callCount === 1) {
        onTextDelta([
          "项目结构如下：",
          "1. API 层",
          "2. 服务层",
          "3. 测试层",
        ].join("\n"));
      } else {
        onTextDelta("第二轮不该发生");
      }
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
        mcpService: {
          listPending: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "先概括一下");
    await runCommand(app, "1");
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual(["先概括一下"]);
    expect(sessionStore.__listRecords()[0]?.pendingChoice).toBeNull();
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("No active numbered options to resolve")
      )
    ).toBe(true);
    app.cleanup();
  });

  test("enter inserts a newline and ctrl+d submits the full multiline input", async () => {
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
      inputHandler?.("first line", {} as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      inputHandler?.("", { return: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(submitted).toEqual([]);
    expect(app.getLatest().input).toBe("first line\n");
    expect(app.getLatest().inputCursorOffset).toBe("first line\n".length);

    await act(async () => {
      inputHandler?.("second line", {} as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().input).toBe("first line\nsecond line");

    await act(async () => {
      inputHandler?.("d", { ctrl: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(submitted).toEqual(["first line\nsecond line"]);
    const record = sessionStore.__listRecords()[0];
    expect(record?.messages[0]?.text).toBe("first line\nsecond line");
    app.cleanup();
  });

  test("ctrl+d with empty composer does not submit or exit", async () => {
    const runQuerySessionImpl = mock(async () => ({ status: "completed" as const }));
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
      inputHandler?.("d", { ctrl: true } as any);
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(runQuerySessionImpl).not.toHaveBeenCalled();
    expect(app.getLatest().input).toBe("");
    expect(app.getLatest().status).toBe("idle");
    app.cleanup();
  });

  test("submit moves through preparing, requesting, then streaming without extra transcript noise", async () => {
    let releasePromptContext!: () => void;
    const promptContextReady = new Promise<void>(resolve => {
      releasePromptContext = resolve;
    });
    let releaseStreaming!: () => void;
    const allowStreaming = new Promise<void>(resolve => {
      releaseStreaming = resolve;
    });
    let finishRun!: () => void;
    const finishStreaming = new Promise<void>(resolve => {
      finishRun = resolve;
    });

    const sessionStore = createTestSessionStore();
    const getPromptContext = sessionStore.getPromptContext.bind(sessionStore);
    sessionStore.getPromptContext = mock(async (sessionId, query) => {
      await promptContextReady;
      return getPromptContext(sessionId, query);
    });

    const runQuerySessionImpl = mock(async ({ onState }: any) => {
      await allowStreaming;
      onState({ status: "streaming" });
      await finishStreaming;
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
        mcpService: {
          listPending: () => [],
        } as any,
        runQuerySessionImpl,
      })
    );

    await act(async () => {
      app.getLatest().setInput("hello");
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      app.getLatest().submit();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().status).toBe("preparing");
    expect(
      getTexts(app.getLatest().items).filter(text => text.includes("Preparing context"))
    ).toHaveLength(0);

    await act(async () => {
      releasePromptContext();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(1);
    expect(app.getLatest().status).toBe("requesting");

    await act(async () => {
      releaseStreaming();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().status).toBe("streaming");

    await act(async () => {
      finishRun();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().status).toBe("idle");
    expect(
      getTexts(app.getLatest().items).filter(text => text.includes("Requesting model"))
    ).toHaveLength(0);
    expect(getTexts(app.getLatest().items).filter(text => text.includes("Thinking"))).toHaveLength(0);
    app.cleanup();
  });

  test("autoSummaryRefresh=false ignores hidden reducer updates and keeps state updates at zero", async () => {
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta(
        withStateUpdate("single reply", {
          version: 1,
          mode: "digest_only",
          nextPendingDigest: {
            OBJECTIVE: ["should stay hidden"],
          },
        })
      );
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
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "hello once");
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(1);
    expect(app.getLatest().exitSummary.stateUpdateCount).toBe(0);
    const stored = sessionStore.__getRecord("session-1");
    expect(stored?.pendingDigest).toBe("");
    expect(stored?.summary).toBe("");
    expect(stored?.lastStateUpdate?.code).toBe("disabled");
    expect(
      stored?.messages.findLast(message => message.role === "assistant")?.text
    ).toBe("single reply");
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

  test("runQuerySession auto-continue does not commit intermediate non-progress chatter to transcript", async () => {
    const sessionStore = createTestSessionStore();
    const transport = createScriptedTransport([
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

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport,
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [],
          handleToolCall: async () => ({
            ok: true,
            message:
              "[tool result] create_file test_files/a.py\nCreated file: test_files/a.py\n[confirmed file mutation] create_file test_files/a.py",
          }),
        } as any,
        runQuerySessionImpl: runQuerySession,
      })
    );

    await act(async () => {
      app.getLatest().setInput(
        "创建 test_files/a.py、test_files/b.py、test_files/c.py，并全部写入内容"
      );
      await Promise.resolve();
    });
    await flushMicrotasks();
    await act(async () => {
      app.getLatest().submit();
      await Promise.resolve();
    });
    await flushMicrotasks();

    const stored = sessionStore.__getRecord("session-1");
    expect(stored?.messages.findLast(message => message.role === "assistant")?.text).toBe(
      "已完成剩余文件"
    );
    expect(getTexts(app.getLatest().items)).not.toContain("继续拆分剩余模块");
    expect(getTexts(app.getLatest().items)).toContain("已完成剩余文件");
    app.cleanup();
  });

  test("batches rapid streaming deltas before repainting the live assistant text", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>(resolve => {
      releaseStream = resolve;
    });

    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("draft ");
      onTextDelta("reply");
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

    expect(app.getLatest().liveAssistantText).toBe("draft ");

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 70));
    });
    await flushMicrotasks();

    expect(app.getLatest().liveAssistantText).toBe("draft reply");

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

  test("first reducer-enabled turn stores pendingDigest only and strips the hidden tail from transcript", async () => {
    const sessionStore = createTestSessionStore();
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta(
        withStateUpdate("reply\n- keeps markdown", {
          version: 1,
          mode: "digest_only",
          nextPendingDigest: {
            OBJECTIVE: ["continue oauth work"],
            "CONFIRMED FACTS": ["api behavior confirmed"],
            REMAINING: ["verify approval flow"],
          },
        })
      );
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
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "continue the oauth task");
    await flushMicrotasks();

    const stored = sessionStore.__getRecord("session-1");
    expect(stored?.summary).toBe("");
    expect(stored?.pendingDigest).toContain("OBJECTIVE:");
    expect(stored?.pendingDigest).toContain("- continue oauth work");
    expect(stored?.pendingDigest).toContain("REMAINING:");
    expect(stored?.pendingDigest).toContain("- verify approval flow");
    expect(stored?.lastStateUpdate?.code).toBe("applied");
    expect(stored?.lastStateUpdate?.summaryLength).toBe(0);
    expect((stored?.lastStateUpdate?.pendingDigestLength ?? 0) > 0).toBe(true);
    expect(stored?.messages.findLast(message => message.role === "assistant")?.text).toBe(
      "reply\n- keeps markdown"
    );
    expect(app.getLatest().exitSummary.stateUpdateCount).toBe(1);
    expect(getTexts(app.getLatest().items).some(text => text.includes("summary updated"))).toBe(
      false
    );
    app.cleanup();
  });

  test("records missing_tag and stores a local fallback pendingDigest when a completed reply has no hidden reducer block", async () => {
    const sessionStore = createTestSessionStore();
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("plain visible answer only");
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
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "inspect the project");
    await flushMicrotasks();

    const stored = sessionStore.__getRecord("session-1");
    expect(stored?.summary).toBe("");
    expect(stored?.pendingDigest).toContain("OBJECTIVE:");
    expect(stored?.pendingDigest).toContain("- inspect the project");
    expect(stored?.pendingDigest).toContain("CONFIRMED FACTS:");
    expect(stored?.pendingDigest).toContain("- (none)");
    expect(stored?.pendingDigest).not.toContain("plain visible answer only");
    expect(stored?.lastStateUpdate?.code).toBe("missing_tag");
    expect(stored?.lastStateUpdate?.message).toContain(
      "without a <cyrene_state_update> block"
    );
    expect(stored?.lastStateUpdate?.message).toContain(
      "Applied local fallback pending digest"
    );
    expect(app.getLatest().exitSummary.stateUpdateCount).toBe(0);
    app.cleanup();
  });

  test("missing_tag with a prior pending digest locally advances summary and replaces pendingDigest", async () => {
    const previousPendingDigest = [
      "OBJECTIVE:",
      "- continue oauth work",
      "",
      "CONFIRMED FACTS:",
      "- api behavior confirmed",
      "",
      "REMAINING:",
      "- verify approval flow",
    ].join("\n");
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        pendingDigest: previousPendingDigest,
      }),
    ]);
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("current turn answer only");
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
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "/resume session-a");
    await runCommand(app, "finish the oauth task");
    await flushMicrotasks();

    const stored = sessionStore.__getRecord("session-a");
    expect(stored?.summary).toContain("OBJECTIVE:");
    expect(stored?.summary).toContain("- continue oauth work");
    expect(stored?.summary).toContain("CONFIRMED FACTS:");
    expect(stored?.summary).toContain("- api behavior confirmed");
    expect(stored?.summary).toContain("REMAINING:");
    expect(stored?.summary).toContain("- verify approval flow");
    expect(stored?.pendingDigest).toContain("OBJECTIVE:");
    expect(stored?.pendingDigest).toContain("- finish the oauth task");
    expect(stored?.pendingDigest).toContain("CONFIRMED FACTS:");
    expect(stored?.pendingDigest).toContain("- (none)");
    expect(stored?.pendingDigest).not.toContain("current turn answer only");
    expect(stored?.pendingDigest).not.toBe(previousPendingDigest);
    expect(stored?.lastStateUpdate?.code).toBe("missing_tag");
    expect(stored?.lastStateUpdate?.message).toContain(
      "Locally advanced durable summary"
    );
    expect(app.getLatest().exitSummary.stateUpdateCount).toBe(0);
    app.cleanup();
  });

  test("later reducer-enabled turns merge the prior pending digest into durable summary and replace pendingDigest", async () => {
    const sessionStore = createTestSessionStore();
    let turn = 0;
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      if (turn === 0) {
        onTextDelta(
          withStateUpdate("first visible reply", {
            version: 1,
            mode: "digest_only",
            nextPendingDigest: {
              OBJECTIVE: ["continue oauth work"],
              "CONFIRMED FACTS": ["api behavior confirmed"],
              REMAINING: ["verify approval flow"],
            },
          })
        );
      } else {
        onTextDelta(
          withStateUpdate("second visible reply", {
            version: 1,
            mode: "merge_and_digest",
            summaryPatch: {
              OBJECTIVE: {
                op: "replace",
                set: ["continue oauth work"],
              },
              "CONFIRMED FACTS": {
                op: "merge",
                add: ["api behavior confirmed"],
              },
              REMAINING: {
                op: "merge",
                add: ["verify approval flow"],
              },
              COMPLETED: {
                op: "merge",
                add: ["answered the oauth follow-up"],
              },
              "KNOWN PATHS": {
                op: "merge",
                add: ["src/auth/oauth.ts"],
              },
            },
            nextPendingDigest: {
              COMPLETED: ["answered the latest user request"],
              "NEXT BEST ACTIONS": ["wait for the next user instruction"],
            },
          })
        );
      }
      turn += 1;
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
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "continue the oauth task");
    await runCommand(app, "finish it");
    await flushMicrotasks();

    const stored = sessionStore.__getRecord("session-1");
    expect(stored?.summary).toContain("OBJECTIVE:");
    expect(stored?.summary).toContain("- continue oauth work");
    expect(stored?.summary).toContain("CONFIRMED FACTS:");
    expect(stored?.summary).toContain("- api behavior confirmed");
    expect(stored?.summary).toContain("COMPLETED:");
    expect(stored?.summary).toContain("- answered the oauth follow-up");
    expect(stored?.summary).toContain("KNOWN PATHS:");
    expect(stored?.summary).toContain("- src/auth/oauth.ts");
    expect(stored?.pendingDigest).toContain("COMPLETED:");
    expect(stored?.pendingDigest).toContain("- answered the latest user request");
    expect(stored?.pendingDigest).not.toContain("verify approval flow");
    expect(
      stored?.messages.filter(message => message.role === "assistant").map(message => message.text)
    ).toEqual(["first visible reply", "second visible reply"]);
    expect(app.getLatest().exitSummary.stateUpdateCount).toBe(2);
    app.cleanup();
  });

  test("invalid reducer tails keep the visible answer and preserve the prior pending digest", async () => {
    const previousPendingDigest = [
      "OBJECTIVE:",
      "- existing pending work",
      "",
      "REMAINING:",
      "- verify approval flow",
    ].join("\n");
    const sessionStore = createTestSessionStore([
      createSessionRecord("session-a", {
        pendingDigest: previousPendingDigest,
      }),
    ]);
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta(
        `visible answer${CYRENE_STATE_UPDATE_START_TAG}{"version":1,"mode":"digest_only",`
      );
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
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "/resume session-a");
    await runCommand(app, "continue despite reducer issue");
    await flushMicrotasks();

    const stored = sessionStore.__getRecord("session-a");
    expect(stored?.pendingDigest).toBe(previousPendingDigest);
    expect(stored?.summary).toBe("");
    expect(stored?.lastStateUpdate?.code).toBe("incomplete_tag");
    expect(stored?.messages.findLast(message => message.role === "assistant")?.text).toBe(
      "visible answer"
    );
    expect(app.getLatest().exitSummary.stateUpdateCount).toBe(0);
    app.cleanup();
  });

  test("failed turns keep an inFlightTurn snapshot and the next completed turn clears it", async () => {
    const sessionStore = createTestSessionStore();
    let turn = 0;
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta, onError }: any) => {
      onState({ status: "streaming" });
      if (turn === 0) {
        turn += 1;
        onTextDelta("partial reply before failure");
        await onError?.("stream exploded");
        throw new Error("stream exploded");
      }

      turn += 1;
      onTextDelta(
        withStateUpdate("recovered reply", {
          version: 1,
          mode: "digest_only",
          nextPendingDigest: {
            COMPLETED: ["recovered after interrupted turn"],
          },
        })
      );
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
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "first task");
    await flushMicrotasks();

    let stored = sessionStore.__getRecord("session-1");
    expect(stored?.inFlightTurn?.userText).toBe("first task");
    expect(stored?.inFlightTurn?.assistantText).toBe("partial reply before failure");
    expect(getTexts(app.getLatest().items).some(text => text.includes("Queued action failed"))).toBe(
      true
    );

    await runCommand(app, "retry after failure");
    await flushMicrotasks();

    stored = sessionStore.__getRecord("session-1");
    expect(stored?.inFlightTurn).toBeNull();
    expect(stored?.pendingDigest).toContain("- recovered after interrupted turn");
    app.cleanup();
  });

  test("terminated queued actions are treated as benign interruptions instead of red errors", async () => {
    const sessionStore = createTestSessionStore();
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "streaming" });
      onTextDelta("partial reply before termination");
      throw new Error("terminated");
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        autoSummaryRefresh: true,
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "task that gets interrupted");
    await flushMicrotasks();

    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Queued action failed: terminated")
      )
    ).toBe(false);
    expect(sessionStore.__getRecord("session-1")?.inFlightTurn?.assistantText).toBe(
      "partial reply before termination"
    );

    app.cleanup();
  });

  test("exitSummary accumulates query usage and reducer state updates across resume and new session flows", async () => {
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
    let turn = 0;
    const runQuerySessionImpl = mock(
      async ({ onState, onTextDelta, onUsage }: any) => {
        const usageByTurn = [
          {
            promptTokens: 10,
            completionTokens: 4,
            totalTokens: 14,
            reply: withStateUpdate("first reply", {
              version: 1,
              mode: "full_rebuild_and_digest",
              summaryPatch: {
                OBJECTIVE: {
                  op: "replace",
                  set: ["continue oauth work"],
                },
                "CONFIRMED FACTS": {
                  op: "merge",
                  add: ["previous steps confirmed"],
                },
              },
              nextPendingDigest: {
                REMAINING: ["finish the oauth response"],
              },
            }),
          },
          {
            promptTokens: 8,
            completionTokens: 3,
            totalTokens: 11,
            reply: withStateUpdate("second reply", {
              version: 1,
              mode: "digest_only",
              nextPendingDigest: {
                COMPLETED: ["fresh turn completed"],
              },
            }),
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
        }),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        autoSummaryRefresh: true,
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
      stateUpdateCount: 1,
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });

    await runCommand(app, "/new");
    await runCommand(app, "fresh turn");
    await flushMicrotasks();

    expect(app.getLatest().exitSummary).toMatchObject({
      activeSessionId: "session-2",
      currentModel: "gpt-test",
      requestCount: 2,
      stateUpdateCount: 2,
      promptTokens: 18,
      completionTokens: 7,
      totalTokens: 25,
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

  test("approval success keeps resumed callbacks active and does not force-stop the turn", async () => {
    let pending = [createPending("resume-approve")];
    const sessionStore = createTestSessionStore() as TestSessionStore;
    let capturedHandlers: { onState?: (state: any) => void; onTextDelta?: (text: string) => void } | null = null;
    const resume = mock(async (_toolResultMessage: string) => {
      capturedHandlers?.onState?.({ status: "streaming" });
      capturedHandlers?.onTextDelta?.("after approval");
      capturedHandlers?.onState?.({ status: "idle" });
      return { status: "completed" as const };
    });
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      capturedHandlers = { onState, onTextDelta };
      onState({ status: "awaiting_review" });
      onTextDelta("draft ");
      return { status: "suspended" as const, resume };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
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
    expect(app.getLatest().status).toBe("idle");
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(app.getLatest().pendingReviews).toHaveLength(0);
    expect(app.getLatest().liveAssistantText).toBe("");
    expect(getTexts(app.getLatest().items).some(text => text.trim() === "draft after approval")).toBe(true);
    expect(sessionStore.__listRecords()[0]?.messages.map(message => message.text)).toEqual([
      "create one file",
      "draft after approval",
    ]);
    app.cleanup();
  });

  test("/cancel reports when there is no running turn", async () => {
    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore: createTestSessionStore(),
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: { listPending: () => [] } as any,
      })
    );

    await runCommand(app, "/cancel");

    expect(getTexts(app.getLatest().items)).toContain("No running turn to cancel.");
    expect(app.getLatest().status).toBe("idle");
    app.cleanup();
  });

  test("/cancel during streaming drops stale output and allows immediate resubmit", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });

    let callCount = 0;
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      callCount += 1;
      if (callCount === 1) {
        onState({ status: "streaming" });
        onTextDelta("first draft");
        await firstGate;
        onTextDelta(" stale tail");
        onState({ status: "idle" });
        return { status: "completed" as const };
      }

      onState({ status: "streaming" });
      onTextDelta("second draft");
      await secondGate;
      onTextDelta(" second final");
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
        mcpService: { listPending: () => [] } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "first task");
    expect(app.getLatest().status).toBe("streaming");
    expect(app.getLatest().liveAssistantText).toBe("first draft");

    await runCommand(app, "/cancel");
    await flushMicrotasks();

    expect(app.getLatest().status).toBe("idle");
    expect(app.getLatest().liveAssistantText).toBe("");
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Current turn cancelled. Add requirements and send a new prompt when ready.")
      )
    ).toBe(true);
    expect(getTexts(app.getLatest().items)).not.toContain("first draft");

    await runCommand(app, "second task");
    expect(callCount).toBe(2);
    expect(app.getLatest().status).toBe("streaming");
    expect(app.getLatest().liveAssistantText).toBe("second draft");

    await act(async () => {
      releaseFirst();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().status).toBe("streaming");
    expect(app.getLatest().liveAssistantText).toBe("second draft");
    expect(getTexts(app.getLatest().items).join("\n")).not.toContain("stale tail");
    expect(getTexts(app.getLatest().items).join("\n")).not.toContain("first draft");

    await act(async () => {
      releaseSecond();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(app.getLatest().status).toBe("idle");
    expect(app.getLatest().liveAssistantText).toBe("");
    expect(getTexts(app.getLatest().items)).toContain("second draft second final");
    app.cleanup();
  });

  test("reject success cancels suspended task instead of resuming", async () => {
    let pending = [createPending("resume-reject")];
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const resume = mock(async (_toolResultMessage: string) => ({ status: "completed" as const }));
    let callCount = 0;
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      callCount += 1;
      if (callCount === 1) {
        onState({ status: "awaiting_review" });
        onTextDelta("draft ");
        return { status: "suspended" as const, resume };
      }
      onState({ status: "streaming" });
      onTextDelta("updated answer");
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
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

    expect(resume).not.toHaveBeenCalled();
    expect(app.getLatest().status).toBe("idle");
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(getTexts(app.getLatest().items).some(text => text.includes("current suspended task cancelled"))).toBe(true);
    expect(getTexts(app.getLatest().items)).toContain("draft");

    await runCommand(app, "add one more requirement");
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(2);
    const record = sessionStore.__listRecords()[0];
    expect(record?.messages.map(message => message.text)).toEqual([
      "reject path",
      "draft",
      "add one more requirement",
      "updated answer",
    ]);
    app.cleanup();
  });

  test("/cancel clears a suspended approval turn without resuming it", async () => {
    let pending = [createPending("cancel-suspended")];
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const resume = mock(async (_toolResultMessage: string) => ({ status: "completed" as const }));
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      onState({ status: "awaiting_review" });
      onTextDelta("draft ");
      return { status: "suspended" as const, resume };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [...pending],
          reject: mock((id: string) => {
            pending = pending.filter(item => item.id !== id);
            return { ok: true, message: `[rejected] ${id}` };
          }),
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "needs approval");
    await openApprovalPanelForTest(app, pending);

    await runCommand(app, "/cancel");
    await flushMicrotasks();
    await flushMicrotasks();

    expect(resume).not.toHaveBeenCalled();
    expect(app.getLatest().status).toBe("idle");
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(app.getLatest().pendingReviews).toHaveLength(0);
    expect(getTexts(app.getLatest().items).join("\n")).not.toContain("draft");
    expect(
      getTexts(app.getLatest().items).some(text =>
        text.includes("Current turn cancelled. Add requirements and send a new prompt when ready.")
      )
    ).toBe(true);

    const record = sessionStore.__listRecords()[0];
    expect(record?.messages.map(message => message.text)).toEqual(["needs approval"]);
    app.cleanup();
  });

  test("/reject all cancels the suspended task instead of resuming it", async () => {
    let pending = [createPending("batch-ra"), createPending("batch-rb")];
    const sessionStore = createTestSessionStore() as TestSessionStore;
    const resume = mock(async (_toolResultMessage: string) => ({ status: "completed" as const }));
    let callCount = 0;
    const runQuerySessionImpl = mock(async ({ onState, onTextDelta }: any) => {
      callCount += 1;
      if (callCount === 1) {
        onState({ status: "awaiting_review" });
        onTextDelta("draft batch ");
        return { status: "suspended" as const, resume };
      }
      onTextDelta("after batch cancel");
      return { status: "completed" as const };
    });

    const app = renderHookHarness(() =>
      useChatAppWithTestInput({
        transport: createTestTransport(),
        sessionStore,
        defaultSystemPrompt: "system",
        projectPrompt: "project",
        pinMaxCount: 3,
        mcpService: {
          listPending: () => [...pending],
          approve: mock(async (id: string) => ({ ok: true, message: `[approved] ${id}\nok` })),
          reject: mock((id: string) => {
            pending = pending.filter(item => item.id !== id);
            return { ok: true, message: `[rejected] ${id}` };
          }),
        } as any,
        runQuerySessionImpl,
      })
    );

    await runCommand(app, "reject every pending write");
    await runCommand(app, "/reject all");
    await flushMicrotasks();
    await flushMicrotasks();

    expect(resume).not.toHaveBeenCalled();
    expect(app.getLatest().status).toBe("idle");
    expect(app.getLatest().approvalPanel.active).toBe(false);
    expect(getTexts(app.getLatest().items).some(text => text.includes("suspended task: cancelled"))).toBe(true);

    await runCommand(app, "fresh requirements now");
    await flushMicrotasks();

    expect(runQuerySessionImpl).toHaveBeenCalledTimes(2);
    app.cleanup();
  });

  test("model picker keyboard wraps, pages, confirms once, and closes", async () => {
    const setModelImpl = mock(async (model: string) => ({
      ok: true,
      message: `Model switched to: ${model}`,
    }));
    const transport = createTestTransport({
      initialModel: "m1",
      models: ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"],
      setModelImpl,
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
      inputHandler?.("", { return: true });
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(setModelImpl).toHaveBeenCalledTimes(1);
    expect(app.getLatest().currentModel).toBe("m2");
    expect(app.getLatest().modelPicker.active).toBe(false);
    expect(
      getTexts(app.getLatest().items).filter(text => text === "Model switched to: m2")
    ).toHaveLength(1);
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
