import type { McpServerAdapter } from "./runtimeTypes";
import { McpServerRegistry } from "./McpServerRegistry";

type McpToolRouterOptions = {
  legacyToolServerIds?: Record<string, string>;
  transportToolAliases?: Record<string, { serverId: string; toolName: string }>;
};

export type McpToolRouteKind =
  | "legacy_tool"
  | "server_namespace"
  | "tool_name"
  | "transport_alias";

export type McpToolRoute = {
  kind: McpToolRouteKind;
  server: McpServerAdapter;
  forwardedToolName: string;
};

const normalizeKey = (value: string) => value.trim().toLowerCase();

export class McpToolRouter {
  private readonly legacyToolServerIds = new Map<string, string>();
  private readonly transportToolAliases = new Map<
    string,
    { serverId: string; toolName: string }
  >();

  constructor(
    private readonly registry: McpServerRegistry,
    options: McpToolRouterOptions = {}
  ) {
    for (const [toolName, serverId] of Object.entries(options.legacyToolServerIds ?? {})) {
      this.legacyToolServerIds.set(normalizeKey(toolName), normalizeKey(serverId));
    }
    for (const [alias, target] of Object.entries(options.transportToolAliases ?? {})) {
      this.transportToolAliases.set(normalizeKey(alias), {
        serverId: normalizeKey(target.serverId),
        toolName: target.toolName.trim(),
      });
    }
  }

  route(toolName: string): McpToolRoute {
    const normalizedToolName = normalizeKey(toolName);
    const transportAlias = this.transportToolAliases.get(normalizedToolName);
    if (transportAlias) {
      const server = this.registry.getServer(transportAlias.serverId);
      if (server) {
        return {
          kind: "transport_alias",
          server,
          forwardedToolName: transportAlias.toolName,
        };
      }
    }

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
    if (toolMatches.length > 1) {
      const options = toolMatches
        .flatMap(server =>
          this.registry
            .getServerToolNames(server.descriptor.id)
            .filter(name => normalizeKey(name) === normalizedToolName)
            .map(name => `${server.descriptor.id}.${name}`)
        )
        .sort((left, right) => left.localeCompare(right));
      throw new Error(
        [
          `Ambiguous MCP tool name: ${toolName}.`,
          "Use a namespaced tool name instead.",
          options.length > 0 ? `Options: ${options.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
    }

    throw new Error(`Unsupported MCP tool: ${toolName}`);
  }
}
