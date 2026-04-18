import { describe, expect, mock, test } from "bun:test";
import type { McpRuntime } from "../src/core/mcp";
import { handleMcpCommand } from "../src/application/chat/chatMcpCommandHandler";

const createMcpService = (
  overrides: Partial<McpRuntime> = {}
): McpRuntime => ({
  handleToolCall: mock(async () => ({
    ok: true,
    message: "ok",
  })),
  listPending: () => [],
  approve: mock(async () => ({
    ok: true,
    message: "approved",
  })),
  reject: mock(() => ({
    ok: true,
    message: "rejected",
  })),
  undoLastMutation: mock(async () => ({
    ok: true,
    message: "undo",
  })),
  listServers: () => [
    {
      id: "ddg-search",
      label: "ddg-search",
      enabled: true,
      source: "remote",
      health: "unknown",
      transport: "stdio",
      aliases: [],
      exposure: "hinted",
      tags: [],
      tools: [],
    },
  ],
  listTools: () => [],
  describeRuntime: () => ({
    primaryServerId: "filesystem",
    serverCount: 1,
    enabledServerCount: 1,
    configPaths: [],
  }),
  ...overrides,
});

describe("handleMcpCommand", () => {
  test("shows current snapshot immediately and refreshes in the background", async () => {
    const refreshServers = mock(
      () => new Promise<void>(() => undefined)
    );
    const messages: string[] = [];
    const pushSystemMessage = mock((text?: string) => {
      if (typeof text === "string") {
        messages.push(text);
      }
    });

    const handled = await Promise.race([
      handleMcpCommand({
        query: "/mcp servers",
        mcpService: createMcpService({
          refreshServers,
        }),
        pushSystemMessage,
        clearInput: () => {},
        getApprovalRisk: () => "low",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("handleMcpCommand blocked on refreshServers"));
        }, 50);
      }),
    ]);

    expect(handled).toBe(true);
    expect(refreshServers).toHaveBeenCalledWith(undefined);
    expect(messages[0]).toContain("MCP servers");
    expect(messages[0]).toContain("refresh: background update started");
  });

  test("background refresh targets one server for detail views", async () => {
    const refreshServers = mock(async () => undefined);
    const messages: string[] = [];
    const pushSystemMessage = mock((text?: string) => {
      if (typeof text === "string") {
        messages.push(text);
      }
    });

    const handled = await handleMcpCommand({
      query: "/mcp server ddg-search",
      mcpService: createMcpService({
        refreshServers,
      }),
      pushSystemMessage,
      clearInput: () => {},
      getApprovalRisk: () => "low",
    });

    expect(handled).toBe(true);
    expect(refreshServers).toHaveBeenCalledWith("ddg-search");
    expect(messages[0]).toContain("refresh: background update started");
  });
});
