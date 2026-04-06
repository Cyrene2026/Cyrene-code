import { relative, resolve } from "node:path";
import { FileMcpService } from "./adapters/filesystem";
import { HttpMcpAdapter } from "./adapters/http";
import { StdioMcpAdapter } from "./adapters/stdio";
import type { RuleConfig } from "./toolTypes";
import { McpManager } from "./McpManager";
import { buildBuiltinToolDescriptors } from "./builtinTools";
import {
  loadMcpConfig,
  saveProjectMcpConfig,
  type LoadedMcpConfig,
  type McpConfigPatch,
  type McpConfiguredServer,
  type McpConfiguredTool,
} from "./loadMcpConfig";
import type {
  McpRuntime,
  McpRuntimeMutationResult,
  McpRuntimeServerInput,
  McpRuntimeSummary,
  McpServerAdapter,
  McpServerDescriptor,
} from "./runtimeTypes";

type CreateMcpRuntimeContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type InitializableMcpAdapter = McpServerAdapter & {
  initialize?: () => Promise<void>;
};

const FILE_ALIAS_NAMES = ["file", "fs", "mcp.file"];

const createRuleConfigFromServer = (
  appRoot: string,
  server: McpConfiguredServer
): RuleConfig => ({
  workspaceRoot: resolve(appRoot, server.workspaceRoot ?? appRoot),
  maxReadBytes: server.maxReadBytes ?? 120_000,
  requireReview: [...(server.requireReview ?? [])],
});

const createFilesystemServerAdapter = (
  appRoot: string,
  server: McpConfiguredServer
): McpServerAdapter => {
  const ruleConfig = createRuleConfigFromServer(appRoot, server);
  const service = new FileMcpService(ruleConfig);
  const descriptor: McpServerDescriptor = {
    id: server.id,
    label: server.label,
    enabled: server.enabled,
    source: "built_in",
    health: server.enabled ? "online" : "offline",
    transport: "filesystem",
    aliases: [...server.aliases],
    tools: buildBuiltinToolDescriptors(server.id, ruleConfig),
  };
  const toolNames = new Set(descriptor.tools.map(tool => tool.name.toLowerCase()));

  return {
    descriptor,
    handleToolCall: (toolName, input) => {
      if (!server.enabled) {
        return Promise.resolve({
          ok: false,
          message: `MCP server disabled: ${server.id}`,
        });
      }

      const normalizedToolName = toolName.trim().toLowerCase();
      if (FILE_ALIAS_NAMES.includes(normalizedToolName)) {
        return service.handleToolCall("file", input);
      }

      if (toolNames.has(normalizedToolName)) {
        return service.handleToolCall("file", {
          ...(typeof input === "object" && input !== null && !Array.isArray(input)
            ? input
            : {}),
          action: normalizedToolName,
        });
      }

      return service.handleToolCall(toolName, input);
    },
    listPending: () =>
      service.listPending().map(item => ({
        ...item,
        serverId: item.serverId ?? descriptor.id,
      })),
    approve: service.approve.bind(service),
    reject: service.reject.bind(service),
    undoLastMutation: service.undoLastMutation.bind(service),
    dispose: service.dispose?.bind(service),
  };
};

const createRemoteServerAdapter = (
  appRoot: string,
  server: McpConfiguredServer,
  context?: CreateMcpRuntimeContext
): InitializableMcpAdapter => {
  if (server.transport === "stdio") {
    return new StdioMcpAdapter(server, {
      appRoot,
      env: context?.env,
    });
  }

  if (server.transport === "http") {
    return new HttpMcpAdapter(server, {
      appRoot,
    });
  }

  throw new Error(`Unsupported MCP transport: ${server.transport}`);
};

const buildAliasMap = (config: LoadedMcpConfig) =>
  Object.fromEntries(
    config.servers.flatMap(server =>
      server.aliases.map(alias => [alias, server.id] as const)
    )
  );

const buildLegacyToolServerIds = (config: LoadedMcpConfig) =>
  Object.fromEntries(
    config.servers
      .filter(server =>
        server.aliases.some(alias =>
          FILE_ALIAS_NAMES.includes(alias.toLowerCase())
        )
      )
      .flatMap(server =>
        server.aliases
          .filter(alias => FILE_ALIAS_NAMES.includes(alias.toLowerCase()))
          .map(alias => [alias, server.id] as const)
      )
  );

const cloneConfiguredTool = (tool: McpConfiguredTool): McpConfiguredTool => ({
  ...tool,
  capabilities: tool.capabilities ? [...tool.capabilities] : undefined,
});

const cloneConfiguredServer = (server: McpConfiguredServer): McpConfiguredServer => ({
  ...server,
  aliases: [...server.aliases],
  requireReview: server.requireReview ? [...server.requireReview] : undefined,
  args: server.args ? [...server.args] : undefined,
  tools: server.tools.map(tool => cloneConfiguredTool(tool)),
});

const cloneConfigPatch = (patch: McpConfigPatch): McpConfigPatch => ({
  primaryServerId: patch.primaryServerId,
  removeServerIds: [...patch.removeServerIds],
  servers: patch.servers.map(server => cloneConfiguredServer(server)),
});

const toPortableWorkspaceRoot = (appRoot: string, workspaceRoot?: string) => {
  if (!workspaceRoot) {
    return undefined;
  }

  const relativePath = relative(appRoot, workspaceRoot);
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !relativePath.includes(":")
  ) {
    return relativePath.startsWith(".") ? relativePath : `./${relativePath.replace(/\\/g, "/")}`;
  }

  return workspaceRoot;
};

const toPatchServer = (
  appRoot: string,
  server: McpConfiguredServer
): McpConfiguredServer => ({
  ...cloneConfiguredServer(server),
  workspaceRoot:
    server.transport === "filesystem"
      ? toPortableWorkspaceRoot(appRoot, server.workspaceRoot)
      : server.workspaceRoot,
});

const upsertPatchServer = (
  patch: McpConfigPatch,
  server: McpConfiguredServer
) => {
  const nextServers = patch.servers.filter(item => item.id !== server.id);
  nextServers.push(server);
  patch.servers = nextServers;
};

const normalizeAliases = (id: string, aliases?: string[]) =>
  Array.from(
    new Set(
      (aliases ?? [])
        .map(alias => alias.trim())
        .filter(Boolean)
        .filter(alias => alias.toLowerCase() !== id.toLowerCase())
    )
  );

const normalizeServerInput = (input: McpRuntimeServerInput): McpConfiguredServer => {
  const id = input.id.trim();
  if (!id) {
    throw new Error("MCP server id is required.");
  }

  if (input.transport === "stdio" && !input.command?.trim()) {
    throw new Error(`MCP stdio server requires a command: ${id}`);
  }
  if (input.transport === "http" && !input.url?.trim()) {
    throw new Error(`MCP http server requires a url: ${id}`);
  }

  return {
    id,
    transport: input.transport,
    label: input.label?.trim() || id,
    enabled: input.enabled ?? true,
    aliases: normalizeAliases(id, input.aliases),
    workspaceRoot:
      input.transport === "filesystem"
        ? input.workspaceRoot?.trim() || "."
        : input.workspaceRoot?.trim(),
    maxReadBytes:
      typeof input.maxReadBytes === "number"
        ? Math.max(1, Math.floor(input.maxReadBytes))
        : undefined,
    requireReview: input.requireReview ? [...input.requireReview] : undefined,
    command: input.command?.trim(),
    args: input.args ? [...input.args] : undefined,
    url: input.url?.trim(),
    tools: (input.tools ?? []).map(tool => ({
      name: tool.name.trim(),
      label: tool.label?.trim(),
      description: tool.description?.trim(),
      capabilities: tool.capabilities ? [...tool.capabilities] : undefined,
      risk: tool.risk,
      requiresReview: tool.requiresReview,
      enabled: tool.enabled,
    })),
  };
};

const buildMutationMessage = (
  action: string,
  serverId: string,
  configPath: string
) => `${action}: ${serverId}\nconfig: ${configPath}`;

const buildManagerFromConfig = async (
  appRoot: string,
  config: LoadedMcpConfig,
  context?: CreateMcpRuntimeContext
) => {
  const adapters: McpServerAdapter[] = [];

  for (const server of config.servers) {
    const adapter =
      server.transport === "filesystem"
        ? createFilesystemServerAdapter(appRoot, server)
        : createRemoteServerAdapter(appRoot, server, context);
    if ("initialize" in adapter && typeof adapter.initialize === "function") {
      await adapter.initialize().catch(() => undefined);
    }
    adapters.push(adapter);
  }

  return new McpManager(adapters, {
    primaryServerId: config.primaryServerId,
    serverAliases: buildAliasMap(config),
    legacyToolServerIds: buildLegacyToolServerIds(config),
    configPaths: config.configPaths,
  });
};

class ManagedMcpRuntime implements McpRuntime {
  private manager: McpManager | null = null;
  private config: LoadedMcpConfig | null = null;

  constructor(
    private readonly appRoot: string,
    private readonly context?: CreateMcpRuntimeContext
  ) {}

  private getManager() {
    if (!this.manager) {
      throw new Error("MCP runtime not initialized.");
    }
    return this.manager;
  }

  private getConfig() {
    if (!this.config) {
      throw new Error("MCP config not loaded.");
    }
    return this.config;
  }

  async load(config?: LoadedMcpConfig) {
    const nextConfig = config ?? (await loadMcpConfig(this.appRoot, this.context));
    const nextManager = await buildManagerFromConfig(this.appRoot, nextConfig, this.context);
    const previousManager = this.manager;
    this.manager = nextManager;
    this.config = nextConfig;
    previousManager?.dispose();
  }

  async reloadConfig(): Promise<McpRuntimeMutationResult> {
    await this.load();
    const loaded = this.getConfig();
    return {
      ok: true,
      message: `MCP config reloaded\nservers: ${loaded.servers.length}\nconfig: ${loaded.editableConfigPath}`,
      configPath: loaded.editableConfigPath,
    };
  }

  async addServer(input: McpRuntimeServerInput): Promise<McpRuntimeMutationResult> {
    const patch = cloneConfigPatch(this.getConfig().projectPatch);
    const server = normalizeServerInput(input);
    patch.removeServerIds = patch.removeServerIds.filter(id => id !== server.id);
    upsertPatchServer(patch, server);

    const saved = await saveProjectMcpConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: buildMutationMessage("MCP server added", server.id, saved.path),
      serverId: server.id,
      configPath: saved.path,
    };
  }

  async removeServer(serverId: string): Promise<McpRuntimeMutationResult> {
    const normalizedId = serverId.trim();
    const current = this.getConfig().servers.find(server => server.id === normalizedId);
    if (!current) {
      return {
        ok: false,
        message: `MCP server not found: ${serverId}`,
      };
    }

    const patch = cloneConfigPatch(this.getConfig().projectPatch);
    patch.servers = patch.servers.filter(server => server.id !== normalizedId);
    patch.removeServerIds = Array.from(
      new Set([...patch.removeServerIds, normalizedId])
    );

    const saved = await saveProjectMcpConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: buildMutationMessage("MCP server removed", normalizedId, saved.path),
      serverId: normalizedId,
      configPath: saved.path,
    };
  }

  async setServerEnabled(
    serverId: string,
    enabled: boolean
  ): Promise<McpRuntimeMutationResult> {
    const normalizedId = serverId.trim();
    const currentConfig = this.getConfig();
    const current =
      currentConfig.servers.find(server => server.id === normalizedId) ??
      currentConfig.projectPatch.servers.find(server => server.id === normalizedId);

    if (!current) {
      return {
        ok: false,
        message: `MCP server not found: ${serverId}`,
      };
    }

    const patch = cloneConfigPatch(currentConfig.projectPatch);
    patch.removeServerIds = patch.removeServerIds.filter(id => id !== normalizedId);
    const existingPatchServer =
      patch.servers.find(server => server.id === normalizedId) ??
      toPatchServer(this.appRoot, current);

    upsertPatchServer(patch, {
      ...existingPatchServer,
      enabled,
    });

    const saved = await saveProjectMcpConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: buildMutationMessage(
        enabled ? "MCP server enabled" : "MCP server disabled",
        normalizedId,
        saved.path
      ),
      serverId: normalizedId,
      configPath: saved.path,
    };
  }

  async handleToolCall(toolName: string, input: unknown) {
    return this.getManager().handleToolCall(toolName, input);
  }

  listPending() {
    return this.getManager().listPending();
  }

  async approve(id: string) {
    return this.getManager().approve(id);
  }

  reject(id: string) {
    return this.getManager().reject(id);
  }

  async undoLastMutation() {
    return this.getManager().undoLastMutation();
  }

  listServers() {
    return this.getManager().listServers();
  }

  listTools(serverId?: string) {
    return this.getManager().listTools(serverId);
  }

  describeRuntime(): McpRuntimeSummary {
    const summary = this.getManager().describeRuntime?.() ?? {
      primaryServerId: this.getConfig().primaryServerId,
      serverCount: this.getConfig().servers.length,
      enabledServerCount: this.getConfig().servers.filter(server => server.enabled).length,
      configPaths: this.getConfig().configPaths,
    };

    return {
      ...summary,
      editableConfigPath: this.getConfig().editableConfigPath,
    };
  }

  dispose() {
    this.manager?.dispose();
    this.manager = null;
  }
}

export const createMcpRuntimeFromConfig = async (
  appRoot: string,
  config: LoadedMcpConfig,
  context?: CreateMcpRuntimeContext
): Promise<McpRuntime> => {
  const runtime = new ManagedMcpRuntime(appRoot, context);
  await runtime.load(config);
  return runtime;
};

export const createMcpRuntime = async (
  appRoot: string,
  context?: CreateMcpRuntimeContext
) => createMcpRuntimeFromConfig(appRoot, await loadMcpConfig(appRoot, context), context);
