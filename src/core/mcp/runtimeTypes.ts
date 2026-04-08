import type { MpcAction, PendingReviewItem, ToolRequest } from "./toolTypes";

export type McpToolCapability =
  | "read"
  | "write"
  | "search"
  | "shell"
  | "command"
  | "git"
  | "review";

export type McpToolRisk = "low" | "medium" | "high";
export type McpServerTransport = "filesystem" | "stdio" | "http";

export type McpPolicyDecision = {
  allowed: boolean;
  requiresReview: boolean;
  risk: McpToolRisk;
  reason?: string;
};

export type McpToolDescriptor = {
  id: string;
  serverId: string;
  name: string;
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
  transport?: McpServerTransport;
  aliases?: string[];
  lsp?: {
    configuredCount: number;
    serverIds: string[];
  };
  tools: McpToolDescriptor[];
};

export type McpHandleResult = {
  ok: boolean;
  message: string;
  pending?: PendingReviewItem;
};

export type McpRuntimeSummary = {
  primaryServerId: string;
  serverCount: number;
  enabledServerCount: number;
  configPaths: string[];
  editableConfigPath?: string;
};

export type McpRuntimeToolInput = {
  name: string;
  label?: string;
  description?: string;
  capabilities?: McpToolCapability[];
  risk?: McpToolRisk;
  requiresReview?: boolean;
  enabled?: boolean;
};

export type McpRuntimeServerInput = {
  id: string;
  transport: McpServerTransport;
  label?: string;
  enabled?: boolean;
  aliases?: string[];
  workspaceRoot?: string;
  maxReadBytes?: number;
  requireReview?: MpcAction[];
  command?: string;
  args?: string[];
  url?: string;
  tools?: McpRuntimeToolInput[];
};

export type McpRuntimeLspServerInput = {
  id: string;
  command: string;
  args?: string[];
  filePatterns: string[];
  rootMarkers?: string[];
  workspaceRoot?: string;
  env?: Record<string, string>;
};

export type McpRuntimeLspServerDescriptor = {
  filesystemServerId: string;
  filesystemWorkspaceRoot: string;
  id: string;
  command: string;
  args: string[];
  filePatterns: string[];
  rootMarkers: string[];
  workspaceRoot?: string;
  envKeys: string[];
};

export type McpRuntimeLspDoctorResult = {
  ok: boolean;
  status: "ready" | "config_error" | "startup_error";
  filesystemServerId: string;
  workspaceRoot: string;
  inputPath: string;
  resolvedPath: string;
  configuredServerIds: string[];
  matchedServerIds: string[];
  selectedServerId?: string;
  resolvedRoot?: string;
  message: string;
};

export type McpRuntimeMutationResult = {
  ok: boolean;
  message: string;
  serverId?: string;
  configPath?: string;
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
  describeRuntime?(): McpRuntimeSummary;
  reloadConfig?(): Promise<McpRuntimeMutationResult>;
  addServer?(input: McpRuntimeServerInput): Promise<McpRuntimeMutationResult>;
  removeServer?(serverId: string): Promise<McpRuntimeMutationResult>;
  setServerEnabled?(
    serverId: string,
    enabled: boolean
  ): Promise<McpRuntimeMutationResult>;
  listLspServers?(filesystemServerId?: string): McpRuntimeLspServerDescriptor[];
  addLspServer?(
    filesystemServerId: string,
    input: McpRuntimeLspServerInput
  ): Promise<McpRuntimeMutationResult>;
  removeLspServer?(
    filesystemServerId: string,
    lspServerId: string
  ): Promise<McpRuntimeMutationResult>;
  doctorLsp?(
    filesystemServerId: string,
    path: string,
    options?: { lspServerId?: string }
  ): Promise<McpRuntimeLspDoctorResult>;
  dispose(): void;
}
