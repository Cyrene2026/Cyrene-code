import { describe, expect, test } from "bun:test";
import {
  McpServerRegistry,
  McpToolRouter,
  type McpServerAdapter,
  type ToolRequest,
} from "../src/core/mcp";

const createAdapter = (
  id: string,
  toolNames: ToolRequest["action"][]
): McpServerAdapter => ({
  descriptor: {
    id,
    label: id,
    enabled: true,
    source: "built_in",
    health: "online",
    exposure: "full",
    tags: [],
    tools: toolNames.map(name => ({
      id: `${id}.${name}`,
      serverId: id,
      name,
      label: name,
      capabilities: [],
      risk: "low",
      requiresReview: false,
      enabled: true,
      exposure: "full",
      tags: [],
    })),
  },
  handleToolCall: async () => ({ ok: true, message: "ok" }),
  listPending: () => [],
  approve: async idValue => ({ ok: true, message: `[approved] ${idValue}` }),
  reject: idValue => ({ ok: true, message: `[rejected] ${idValue}` }),
  undoLastMutation: async () => ({ ok: true, message: "[undo] reverted" }),
});

describe("McpToolRouter", () => {
  test("routes legacy aliases to the configured server", () => {
    const registry = new McpServerRegistry([createAdapter("filesystem", ["read_file"])], {
      serverAliases: {
        file: "filesystem",
      },
    });
    const router = new McpToolRouter(registry, {
      legacyToolServerIds: {
        file: "filesystem",
      },
    });

    expect(router.route("file")).toEqual(
      expect.objectContaining({
        kind: "legacy_tool",
        forwardedToolName: "file",
      })
    );
  });

  test("routes namespaced tools through server ids and dotted aliases", () => {
    const registry = new McpServerRegistry([createAdapter("filesystem", ["read_file"])], {
      serverAliases: {
        "mcp.file": "filesystem",
      },
    });
    const router = new McpToolRouter(registry);

    expect(router.route("filesystem.read_file")).toEqual(
      expect.objectContaining({
        kind: "server_namespace",
        forwardedToolName: "read_file",
      })
    );

    expect(router.route("mcp.file.read_file")).toEqual(
      expect.objectContaining({
        kind: "server_namespace",
        forwardedToolName: "read_file",
      })
    );
  });

  test("routes a unique bare tool name to its owning server", () => {
    const filesystem = createAdapter("filesystem", ["read_file"]);
    const git = createAdapter("git", ["git_status"]);
    const registry = new McpServerRegistry([filesystem, git]);
    const router = new McpToolRouter(registry);

    expect(router.route("git_status")).toEqual(
      expect.objectContaining({
        kind: "tool_name",
        server: git,
        forwardedToolName: "git_status",
      })
    );
  });

  test("throws when a bare tool name is ambiguous", () => {
    const primary = createAdapter("filesystem", ["read_file"]);
    const secondary = createAdapter("archive", ["read_file"]);
    const registry = new McpServerRegistry([primary, secondary]);
    const router = new McpToolRouter(registry);

    expect(() => router.route("read_file")).toThrow("Ambiguous MCP tool name");
  });

  test("routes provider-safe transport aliases to the target server", () => {
    const filesystem = createAdapter("filesystem", ["read_file"]);
    const archive = createAdapter("archive", ["read_file"]);
    const registry = new McpServerRegistry([filesystem, archive]);
    const router = new McpToolRouter(registry, {
      transportToolAliases: {
        archive__read_file: {
          serverId: "archive",
          toolName: "read_file",
        },
      },
    });

    expect(router.route("archive__read_file")).toEqual(
      expect.objectContaining({
        kind: "transport_alias",
        server: archive,
        forwardedToolName: "read_file",
      })
    );
  });
});
