import type {
  McpServerAdapter,
  McpServerDescriptor,
  McpToolDescriptor,
} from "./runtimeTypes";

type McpServerRegistryOptions = {
  primaryServerId?: string;
  serverAliases?: Record<string, string>;
};

type NamespacedServerMatch = {
  server: McpServerAdapter;
  forwardedToolName: string;
};

const normalizeKey = (value: string) => value.trim().toLowerCase();

export class McpServerRegistry {
  private readonly servers = new Map<string, McpServerAdapter>();
  private readonly serverAliases = new Map<string, string>();
  private readonly primaryServerId: string;

  constructor(servers: McpServerAdapter[], options: McpServerRegistryOptions = {}) {
    if (servers.length === 0) {
      throw new Error("MCP server registry requires at least one server.");
    }

    for (const server of servers) {
      const id = normalizeKey(server.descriptor.id);
      this.servers.set(id, server);
    }

    for (const [alias, serverId] of Object.entries(options.serverAliases ?? {})) {
      const normalizedAlias = normalizeKey(alias);
      const normalizedServerId = normalizeKey(serverId);
      if (this.servers.has(normalizedServerId)) {
        this.serverAliases.set(normalizedAlias, normalizedServerId);
      }
    }

    const configuredPrimary = options.primaryServerId
      ? normalizeKey(options.primaryServerId)
      : null;
    const fallbackPrimary = normalizeKey(servers[0]!.descriptor.id);
    this.primaryServerId =
      configuredPrimary && this.servers.has(configuredPrimary)
        ? configuredPrimary
        : fallbackPrimary;
  }

  listServers(): McpServerDescriptor[] {
    return [...this.servers.values()].map(server => server.descriptor);
  }

  listTools(serverId?: string): McpToolDescriptor[] {
    if (serverId) {
      return this.getServer(serverId)?.descriptor.tools ?? [];
    }
    return this.listServers().flatMap(server => server.tools);
  }

  getPrimaryServer(): McpServerAdapter {
    return this.servers.get(this.primaryServerId)!;
  }

  getServer(serverIdOrAlias: string): McpServerAdapter | undefined {
    const normalized = normalizeKey(serverIdOrAlias);
    const resolvedId = this.serverAliases.get(normalized) ?? normalized;
    return this.servers.get(resolvedId);
  }

  findPendingOwner(id: string): McpServerAdapter | undefined {
    for (const server of this.servers.values()) {
      if (server.listPending().some(item => item.id === id)) {
        return server;
      }
    }
    return undefined;
  }

  findServersByToolName(toolName: string): McpServerAdapter[] {
    const normalizedToolName = normalizeKey(toolName);
    return [...this.servers.values()].filter(server =>
      server.descriptor.tools.some(
        tool =>
          normalizeKey(tool.name) === normalizedToolName ||
          normalizeKey(tool.id) === normalizedToolName
      )
    );
  }

  getServerToolNames(serverId: string): string[] {
    return this.getServer(serverId)?.descriptor.tools.map(tool => tool.name) ?? [];
  }

  matchNamespacedServer(toolName: string): NamespacedServerMatch | null {
    const normalizedToolName = normalizeKey(toolName);
    const namespaceCandidates = [
      ...[...this.servers.keys()].map(key => ({ key, serverId: key })),
      ...[...this.serverAliases.entries()].map(([key, serverId]) => ({ key, serverId })),
    ].sort((left, right) => right.key.length - left.key.length);

    for (const candidate of namespaceCandidates) {
      const prefix = `${candidate.key}.`;
      if (!normalizedToolName.startsWith(prefix)) {
        continue;
      }
      const forwardedToolName = normalizedToolName.slice(prefix.length);
      if (!forwardedToolName) {
        continue;
      }
      const server = this.servers.get(candidate.serverId);
      if (!server) {
        continue;
      }
      return {
        server,
        forwardedToolName,
      };
    }

    return null;
  }
}
