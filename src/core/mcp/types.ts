import type { PendingReviewItem, ToolRequest } from "../tools/mcp/types";

export type McpToolCapability =
  | "read"
  | "write"
  | "search"
  | "shell"
  | "command"
  | "git"
  | "review";

export type McpToolRisk = "low" | "medium" | "high";

export type McpPolicyDecision = {
  allowed: boolean;
  requiresReview: boolean;
  risk: McpToolRisk;
  reason?: string;
};

export type McpToolDescriptor = {
  id: string;
  serverId: string;
  name: ToolRequest["action"];
  label: string;
  description?: string;
  capabilities: McpToolCapability[];
  risk: McpToolRisk;
  requiresReview: boolean;
  enabled: boolean;
};

export type McpServerDescriptor = {
  id: string;
  label: string;
  enabled: boolean;
  source: "built_in" | "local" | "remote";
  health: "unknown" | "online" | "offline" | "error";
  tools: McpToolDescriptor[];
};

export type McpHandleResult = {
  ok: boolean;
  message: string;
  pending?: PendingReviewItem;
};

export interface McpServerAdapter {
  descriptor: McpServerDescriptor;
  handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult>;
  listPending(): PendingReviewItem[];
  approve(id: string): Promise<McpHandleResult>;
  reject(id: string): McpHandleResult;
  undoLastMutation(): Promise<McpHandleResult>;
  dispose?(): void;
}

export interface McpRuntime {
  handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult>;
  listPending(): PendingReviewItem[];
  approve(id: string): Promise<McpHandleResult>;
  reject(id: string): McpHandleResult;
  undoLastMutation(): Promise<McpHandleResult>;
  listServers(): McpServerDescriptor[];
  listTools(serverId?: string): McpToolDescriptor[];
  dispose(): void;
}
