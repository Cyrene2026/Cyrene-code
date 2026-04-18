import type { PendingReviewItem, RuleConfig, ToolRequest } from "./toolTypes";
import { buildBuiltinToolDescriptors } from "./builtinTools";
import { McpServerRegistry } from "./McpServerRegistry";
import { McpToolRouter } from "./McpToolRouter";
import type {
  McpHandleResult,
  McpRuntime,
  McpRuntimeSummary,
  McpServerAdapter,
  McpServerDescriptor,
} from "./runtimeTypes";

const FILE_TOOL_NAMES = new Set(["file", "fs", "mcp.file"]);
const DEFAULT_REFRESH_SERVER_TIMEOUT_MS = 2_000;

const buildFileServerAliases = (serverId: string) => ({
  file: serverId,
  fs: serverId,
  "mcp.file": serverId,
});

const toRecord = (input: unknown): Record<string, unknown> | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
};

const withToolAction = (input: unknown, action: ToolRequest["action"]) => ({
  ...(toRecord(input) ?? {}),
  action,
});

type InitializableMcpServerAdapter = McpServerAdapter & {
  initialize?: () => Promise<void>;
};

export class McpManager implements McpRuntime {
  private readonly registry: McpServerRegistry;
  private readonly router: McpToolRouter;
  private readonly summary: McpRuntimeSummary;
  private readonly refreshServerTimeoutMs: number;

  constructor(
    servers: McpServerAdapter[],
    options?: {
      primaryServerId?: string;
      serverAliases?: Record<string, string>;
      legacyToolServerIds?: Record<string, string>;
      configPaths?: string[];
      refreshServerTimeoutMs?: number;
    }
  ) {
    this.registry = new McpServerRegistry(servers, {
      primaryServerId: options?.primaryServerId,
      serverAliases: options?.serverAliases,
    });
    this.router = new McpToolRouter(this.registry, {
      legacyToolServerIds: options?.legacyToolServerIds,
    });
    const descriptors = this.registry.listServers();
    this.summary = {
      primaryServerId: this.registry.getPrimaryServer().descriptor.id,
      serverCount: descriptors.length,
      enabledServerCount: descriptors.filter(server => server.enabled).length,
      configPaths: [...(options?.configPaths ?? [])],
    };
    this.refreshServerTimeoutMs = Math.max(
      0,
      options?.refreshServerTimeoutMs ?? DEFAULT_REFRESH_SERVER_TIMEOUT_MS
    );
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
      transport: "filesystem",
      aliases: Object.keys(buildFileServerAliases(serverId)),
      exposure: "full",
      tags: ["filesystem", "workspace", "core"],
      hint: "Core workspace file, git, shell, and LSP operations.",
      lsp: ruleConfig.lspServers
        ? {
            configuredCount: ruleConfig.lspServers.length,
            serverIds: ruleConfig.lspServers.map(entry => entry.id),
          }
        : undefined,
      tools: buildBuiltinToolDescriptors(serverId, ruleConfig, {
        serverExposure: "full",
      }),
    };
    const toolNames = new Set(descriptor.tools.map(tool => tool.name));

    const adapter: McpServerAdapter = {
      descriptor,
      handleToolCall: (toolName, input) => {
        const normalizedToolName = toolName.trim().toLowerCase();
        if (FILE_TOOL_NAMES.has(normalizedToolName)) {
          return service.handleToolCall("file", input);
        }

        if (toolNames.has(normalizedToolName as ToolRequest["action"])) {
          return service.handleToolCall(
            "file",
            withToolAction(input, normalizedToolName as ToolRequest["action"])
          );
        }

        return service.handleToolCall(toolName, input);
      },
      listPending: service.listPending.bind(service),
      approve: service.approve.bind(service),
      reject: service.reject.bind(service),
      undoLastMutation: service.undoLastMutation.bind(service),
      dispose: service.dispose?.bind(service),
    };

    const serverAliases = buildFileServerAliases(serverId);

    return new McpManager([adapter], {
      primaryServerId: serverId,
      serverAliases,
      legacyToolServerIds: serverAliases,
    });
  }

  listServers() {
    return this.registry.listServers();
  }

  listTools(serverId?: string) {
    return this.registry.listTools(serverId);
  }

  describeRuntime() {
    return {
      ...this.summary,
    };
  }

  private async refreshServerWithIsolation(server: McpServerAdapter) {
    const initializable = server as InitializableMcpServerAdapter;
    if (typeof initializable.initialize !== "function") {
      return;
    }

    const initializePromise = Promise.resolve()
      .then(() => initializable.initialize?.())
      .catch(() => undefined);

    if (this.refreshServerTimeoutMs === 0) {
      await initializePromise;
      return;
    }

    await new Promise<void>(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };
      const timer = setTimeout(finish, this.refreshServerTimeoutMs);
      void initializePromise.finally(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  async refreshServers(serverId?: string) {
    const targets = serverId
      ? [this.registry.getServer(serverId)].filter(
          (server): server is McpServerAdapter => Boolean(server)
        )
      : this.registry
          .listServers()
          .map(server => this.registry.getServer(server.id))
          .filter((server): server is McpServerAdapter => Boolean(server));

    await Promise.all(
      targets.map(server => this.refreshServerWithIsolation(server))
    );
  }

  async handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult> {
    const route = this.router.route(toolName);
    const result = await route.server.handleToolCall(route.forwardedToolName, input);
    return result.pending
      ? {
          ...result,
          pending: {
            ...result.pending,
            serverId: result.pending.serverId ?? route.server.descriptor.id,
          },
        }
      : result;
  }

  listPending(): PendingReviewItem[] {
    return this.registry
      .listServers()
      .flatMap(server =>
        (this.registry.getServer(server.id)?.listPending() ?? []).map(item => ({
          ...item,
          serverId: item.serverId ?? server.id,
        }))
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async approve(id: string): Promise<McpHandleResult> {
    const owner = this.registry.findPendingOwner(id);
    if (owner) {
      return owner.approve(id);
    }
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  reject(id: string): McpHandleResult {
    const owner = this.registry.findPendingOwner(id);
    if (owner) {
      return owner.reject(id);
    }
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  async undoLastMutation(): Promise<McpHandleResult> {
    const filesystemServer = this.registry
      .listServers()
      .find(server => server.transport === "filesystem" && server.enabled);

    return (filesystemServer
      ? this.registry.getServer(filesystemServer.id)
      : this.registry.getPrimaryServer()
    )!.undoLastMutation();
  }

  dispose() {
    for (const server of this.registry.listServers()) {
      this.registry.getServer(server.id)?.dispose?.();
    }
  }
}
