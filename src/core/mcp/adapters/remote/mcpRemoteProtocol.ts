import { getMcpToolCapabilities, getMcpToolRisk } from "../../McpPolicy";
import type { McpConfiguredServer, McpConfiguredTool } from "../../loadMcpConfig";
import type {
  McpHandleResult,
  McpToolCapability,
  McpToolDescriptor,
  McpToolRisk,
} from "../../runtimeTypes";

export type RemoteMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type RemoteToolCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

const normalizeName = (value: string) => value.trim().toLowerCase();

const inferCapabilities = (name: string): McpToolCapability[] => {
  const inferred = getMcpToolCapabilities(name as never);
  if (inferred.length > 0) {
    return inferred;
  }

  const normalized = normalizeName(name);
  const capabilities = new Set<McpToolCapability>();
  if (normalized.includes("read") || normalized.includes("get") || normalized.includes("list")) {
    capabilities.add("read");
  }
  if (normalized.includes("search") || normalized.includes("find")) {
    capabilities.add("search");
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("delete") ||
    normalized.includes("patch")
  ) {
    capabilities.add("write");
    capabilities.add("review");
  }
  if (normalized.includes("shell")) {
    capabilities.add("shell");
  }
  if (normalized.includes("command") || normalized.includes("exec")) {
    capabilities.add("command");
  }
  if (normalized.includes("git")) {
    capabilities.add("git");
  }
  return [...capabilities];
};

const inferRisk = (name: string): McpToolRisk => {
  const inferred = getMcpToolRisk(name as never);
  if (inferred !== "low") {
    return inferred;
  }

  const normalized = normalizeName(name);
  if (
    normalized.includes("delete") ||
    normalized.includes("remove") ||
    normalized.includes("move") ||
    normalized.includes("shell")
  ) {
    return "high";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("command")
  ) {
    return "medium";
  }
  return "low";
};

const mergeConfiguredTool = (
  serverId: string,
  remoteTool: RemoteMcpTool,
  configuredTool?: McpConfiguredTool
): McpToolDescriptor => ({
  id: `${serverId}.${remoteTool.name}`,
  serverId,
  name: remoteTool.name,
  label: configuredTool?.label ?? remoteTool.name,
  description: configuredTool?.description ?? remoteTool.description,
  capabilities:
    configuredTool?.capabilities && configuredTool.capabilities.length > 0
      ? [...configuredTool.capabilities]
      : inferCapabilities(remoteTool.name),
  risk: configuredTool?.risk ?? inferRisk(remoteTool.name),
  requiresReview: configuredTool?.requiresReview ?? false,
  enabled: configuredTool?.enabled ?? true,
});

export const buildRemoteToolDescriptors = (
  server: Pick<McpConfiguredServer, "id" | "tools">,
  remoteTools: RemoteMcpTool[]
): McpToolDescriptor[] => {
  const configuredByName = new Map(
    server.tools.map(tool => [normalizeName(tool.name), tool] as const)
  );

  const remoteDescriptors = remoteTools.map(tool =>
    mergeConfiguredTool(server.id, tool, configuredByName.get(normalizeName(tool.name)))
  );
  const seen = new Set(remoteDescriptors.map(tool => normalizeName(tool.name)));

  for (const configuredTool of server.tools) {
    if (seen.has(normalizeName(configuredTool.name))) {
      continue;
    }
    remoteDescriptors.push(
      mergeConfiguredTool(
        server.id,
        {
          name: configuredTool.name,
          description: configuredTool.description,
        },
        configuredTool
      )
    );
  }

  return remoteDescriptors;
};

const stringifyUnknown = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatRemoteContentItem = (item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return stringifyUnknown(item);
  }

  const type = "type" in item && typeof item.type === "string" ? item.type : undefined;
  if (type === "text" && "text" in item && typeof item.text === "string") {
    return item.text;
  }

  return stringifyUnknown(item);
};

export const formatRemoteToolCallResult = (
  toolName: string,
  result: unknown
): McpHandleResult => {
  const payload =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as RemoteToolCallResult)
      : undefined;
  const textParts =
    payload?.content?.map(item => formatRemoteContentItem(item)).filter(Boolean) ?? [];
  const body =
    textParts.length > 0
      ? textParts.join("\n")
      : payload && "structuredContent" in payload
        ? stringifyUnknown(payload.structuredContent)
        : stringifyUnknown(result);
  const ok = !(payload?.isError ?? false);

  return {
    ok,
    message: `[tool ${ok ? "result" : "error"}] ${toolName}\n${body}`.trim(),
  };
};
