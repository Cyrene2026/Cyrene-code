import type { McpServerAdapter } from "./runtimeTypes";
import { McpServerRegistry } from "./McpServerRegistry";

type McpToolRouterOptions = {
  legacyToolServerIds?: Record<string, string>;
};

export type McpToolRouteKind =
  | "legacy_tool"
  | "server_namespace"
  | "tool_name"
  | "primary_fallback";

export type McpToolRoute = {
  kind: McpToolRouteKind;
  server: McpServerAdapter;
  forwardedToolName: string;
};

const normalizeKey = (value: string) => value.trim().toLowerCase();

export class McpToolRouter {
  private readonly legacyToolServerIds = new Map<string, string>();

  constructor(
    private readonly registry: McpServerRegistry,
    options: McpToolRouterOptions = {}
  ) {
    for (const [toolName, serverId] of Object.entries(options.legacyToolServerIds ?? {})) {
      this.legacyToolServerIds.set(normalizeKey(toolName), normalizeKey(serverId));
    }
  }

  route(toolName: string): McpToolRoute {
    const normalizedToolName = normalizeKey(toolName);
    const legacyServerId = this.legacyToolServerIds.get(normalizedToolName);
    if (legacyServerId) {
      const server = this.registry.getServer(legacyServerId);
      if (server) {
        return {
          kind: "legacy_tool",
          server,
          forwardedToolName: normalizedToolName,
        };
      }
    }

    const namespacedMatch = this.registry.matchNamespacedServer(normalizedToolName);
    if (namespacedMatch) {
      return {
        kind: "server_namespace",
        server: namespacedMatch.server,
        forwardedToolName: namespacedMatch.forwardedToolName,
      };
    }

    const toolMatches = this.registry.findServersByToolName(normalizedToolName);
    if (toolMatches.length === 1) {
      return {
        kind: "tool_name",
        server: toolMatches[0]!,
        forwardedToolName: normalizedToolName,
      };
    }

    return {
      kind: "primary_fallback",
      server: this.registry.getPrimaryServer(),
      forwardedToolName: normalizedToolName,
    };
  }
}
