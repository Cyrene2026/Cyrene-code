import { describe, expect, mock, test } from "bun:test";
import {
  McpManager,
  type McpServerAdapter,
  type PendingReviewItem,
} from "../src/core/mcp";

const createPending = (id: string): PendingReviewItem => ({
  id,
  request: {
    action: "write_file",
    path: "src/example.ts",
    content: "hello",
  },
  preview: "preview",
  previewSummary: "summary",
  previewFull: "full",
  createdAt: "2026-04-06T00:00:00.000Z",
});

const createAdapter = (
  overrides: Partial<McpServerAdapter> = {}
): McpServerAdapter => ({
  descriptor: {
    id: "filesystem",
    label: "Filesystem",
    enabled: true,
    source: "built_in",
    health: "online",
    tools: [],
  },
  handleToolCall: mock(async () => ({
    ok: true,
    message: "[tool result] read_file src/example.ts\nok",
  })),
  listPending: mock(() => []),
  approve: mock(async id => ({
    ok: true,
    message: `[approved] ${id}`,
  })),
  reject: mock(id => ({
    ok: true,
    message: `[rejected] ${id}`,
  })),
  undoLastMutation: mock(async () => ({
    ok: true,
    message: "[undo] reverted",
  })),
  dispose: mock(() => {}),
  ...overrides,
});

describe("McpManager", () => {
  test("wraps file MCP service metadata and tool catalog", () => {
    const service = {
      handleToolCall: mock(async () => ({ ok: true, message: "ok" })),
      listPending: mock(() => []),
      approve: mock(async () => ({ ok: true, message: "approved" })),
      reject: mock(() => ({ ok: true, message: "rejected" })),
      undoLastMutation: mock(async () => ({ ok: true, message: "undo" })),
      dispose: mock(() => {}),
    };

    const manager = McpManager.fromFileService(service, {
      workspaceRoot: "D:/Projects/js_projects/Cyrene-code",
      maxReadBytes: 100_000,
      requireReview: ["write_file", "open_shell", "write_shell"],
    });

    expect(manager.listServers()).toHaveLength(1);
    expect(manager.listServers()[0]?.id).toBe("filesystem");
    expect(manager.listTools().some(tool => tool.id === "filesystem.read_file")).toBe(true);
    expect(
      manager.listTools().find(tool => tool.id === "filesystem.write_file")
    ).toEqual(
      expect.objectContaining({
        requiresReview: true,
        risk: "medium",
      })
    );
  });

  test("routes approvals and rejections to the owning adapter", async () => {
    const pending = createPending("pending-1");
    const adapter = createAdapter({
      listPending: mock(() => [pending]),
    });
    const manager = new McpManager([adapter]);

    const approved = await manager.approve("pending-1");
    const rejected = manager.reject("pending-1");

    expect(approved.ok).toBe(true);
    expect(rejected.ok).toBe(true);
    expect(adapter.approve).toHaveBeenCalledWith("pending-1");
    expect(adapter.reject).toHaveBeenCalledWith("pending-1");
  });

  test("falls back to the primary adapter for file aliases", async () => {
    const adapter = createAdapter();
    const manager = new McpManager([adapter], {
      primaryServerId: "filesystem",
      legacyToolServerIds: {
        file: "filesystem",
      },
    });

    await manager.handleToolCall("file", {
      action: "read_file",
      path: "src/example.ts",
    });

    expect(adapter.handleToolCall).toHaveBeenCalledWith("file", {
      action: "read_file",
      path: "src/example.ts",
    });
  });

  test("routes namespaced tool ids to the owning adapter", async () => {
    const adapter = createAdapter({
      descriptor: {
        id: "filesystem",
        label: "Filesystem",
        enabled: true,
        source: "built_in",
        health: "online",
        tools: [
          {
            id: "filesystem.read_file",
            serverId: "filesystem",
            name: "read_file",
            label: "read file",
            capabilities: ["read"],
            risk: "low",
            requiresReview: false,
            enabled: true,
          },
        ],
      },
    });
    const manager = new McpManager([adapter], {
      primaryServerId: "filesystem",
    });

    await manager.handleToolCall("filesystem.read_file", {
      path: "src/example.ts",
    });

    expect(adapter.handleToolCall).toHaveBeenCalledWith("read_file", {
      path: "src/example.ts",
    });
  });

  test("fromFileService adapts namespaced actions back to the file tool backend", async () => {
    const service = {
      handleToolCall: mock(async () => ({ ok: true, message: "ok" })),
      listPending: mock(() => []),
      approve: mock(async () => ({ ok: true, message: "approved" })),
      reject: mock(() => ({ ok: true, message: "rejected" })),
      undoLastMutation: mock(async () => ({ ok: true, message: "undo" })),
      dispose: mock(() => {}),
    };

    const manager = McpManager.fromFileService(service, {
      workspaceRoot: "D:/Projects/js_projects/Cyrene-code",
      maxReadBytes: 100_000,
      requireReview: [],
    });

    await manager.handleToolCall("filesystem.read_file", {
      path: "src/example.ts",
    });

    expect(service.handleToolCall).toHaveBeenCalledWith("file", {
      action: "read_file",
      path: "src/example.ts",
    });
  });
});
