import type { PendingReviewItem, RuleConfig, ToolRequest } from "../tools/mcp/types";
import { buildMcpPolicyDecision, getMcpToolCapabilities } from "./McpPolicy";
import type {
  McpHandleResult,
  McpRuntime,
  McpServerAdapter,
  McpServerDescriptor,
  McpToolDescriptor,
} from "./types";

const FILE_TOOL_NAMES = new Set(["file", "fs", "mcp.file"]);

const getNamespacedToolId = (serverId: string, action: ToolRequest["action"]) =>
  `${serverId}.${action}`;

const getToolLabel = (action: ToolRequest["action"]) => action.replace(/_/g, " ");

const buildBuiltinToolDescriptors = (
  serverId: string,
  ruleConfig: Pick<RuleConfig, "requireReview">
): McpToolDescriptor[] => {
  const actions: ToolRequest["action"][] = [
    "read_file",
    "read_files",
    "read_range",
    "read_json",
    "read_yaml",
    "list_dir",
    "create_dir",
    "create_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "delete_file",
    "stat_path",
    "stat_paths",
    "outline_file",
    "find_files",
    "find_symbol",
    "find_references",
    "search_text",
    "search_text_context",
    "copy_path",
    "move_path",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_blame",
    "run_command",
    "run_shell",
    "open_shell",
    "write_shell",
    "read_shell",
    "shell_status",
    "interrupt_shell",
    "close_shell",
  ];

  return actions.map(action => {
    const requiresReview =
      action === "run_command" ||
      action === "run_shell" ||
      ruleConfig.requireReview.includes(action);
    const policy = buildMcpPolicyDecision(
      { action, path: "." } as ToolRequest,
      requiresReview
    );

    return {
      id: getNamespacedToolId(serverId, action),
      serverId,
      name: action,
      label: getToolLabel(action),
      capabilities: getMcpToolCapabilities(action),
      risk: policy.risk,
      requiresReview: policy.requiresReview,
      enabled: true,
    };
  });
};

export class McpManager implements McpRuntime {
  private readonly servers = new Map<string, McpServerAdapter>();

  constructor(servers: McpServerAdapter[]) {
    for (const server of servers) {
      this.servers.set(server.descriptor.id, server);
    }
  }

  static fromFileService(
    service: Pick<
      McpServerAdapter,
      "handleToolCall" | "listPending" | "approve" | "reject" | "undoLastMutation" | "dispose"
    >,
    ruleConfig: RuleConfig,
    options?: {
      serverId?: string;
      label?: string;
      enabled?: boolean;
    }
  ) {
    const serverId = options?.serverId ?? "filesystem";
    const descriptor: McpServerDescriptor = {
      id: serverId,
      label: options?.label ?? "Filesystem",
      enabled: options?.enabled ?? true,
      source: "built_in",
      health: "online",
      tools: buildBuiltinToolDescriptors(serverId, ruleConfig),
    };

    const adapter: McpServerAdapter = {
      descriptor,
      handleToolCall: service.handleToolCall.bind(service),
      listPending: service.listPending.bind(service),
      approve: service.approve.bind(service),
      reject: service.reject.bind(service),
      undoLastMutation: service.undoLastMutation.bind(service),
      dispose: service.dispose?.bind(service),
    };

    return new McpManager([adapter]);
  }

  listServers() {
    return [...this.servers.values()].map(server => server.descriptor);
  }

  listTools(serverId?: string) {
    if (serverId) {
      return this.servers.get(serverId)?.descriptor.tools ?? [];
    }
    return this.listServers().flatMap(server => server.tools);
  }

  private getPrimaryServer() {
    const [server] = this.servers.values();
    if (!server) {
      throw new Error("No MCP servers are registered.");
    }
    return server;
  }

  async handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult> {
    if (FILE_TOOL_NAMES.has(toolName.trim().toLowerCase())) {
      return this.getPrimaryServer().handleToolCall(toolName, input);
    }

    const [serverId] = toolName.split(".", 1);
    if (serverId && this.servers.has(serverId)) {
      return this.servers.get(serverId)!.handleToolCall(toolName, input);
    }

    return this.getPrimaryServer().handleToolCall(toolName, input);
  }

  listPending(): PendingReviewItem[] {
    return [...this.servers.values()]
      .flatMap(server => server.listPending())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async approve(id: string): Promise<McpHandleResult> {
    for (const server of this.servers.values()) {
      if (server.listPending().some(item => item.id === id)) {
        return server.approve(id);
      }
    }
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  reject(id: string): McpHandleResult {
    for (const server of this.servers.values()) {
      if (server.listPending().some(item => item.id === id)) {
        return server.reject(id);
      }
    }
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  async undoLastMutation(): Promise<McpHandleResult> {
    return this.getPrimaryServer().undoLastMutation();
  }

  dispose() {
    for (const server of this.servers.values()) {
      server.dispose?.();
    }
  }
}
