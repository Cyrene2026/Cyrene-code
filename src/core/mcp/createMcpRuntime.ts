import { lookup as dnsLookup } from "node:dns/promises";
import { readdir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import {
  FileMcpService,
  LspManager,
  createLspServerConfig,
  isLspConfigError,
} from "./adapters/filesystem";
import {
  createLspInputFromPreset,
  findLspPresetByInput,
  listLspPresets,
  type LspPreset,
  matchesLspPresetPath,
} from "./lspPresets";
import { HttpMcpAdapter } from "./adapters/http";
import { StdioMcpAdapter } from "./adapters/stdio";
import type { LspServerConfig, RuleConfig } from "./toolTypes";
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
  McpRuntimeLspDoctorResult,
  McpRuntimeLspServerDescriptor,
  McpRuntimeLspServerInput,
  McpRuntimeMutationResult,
  McpRuntimeServerInput,
  McpRuntimeSummary,
  McpServerAdapter,
  McpServerDescriptor,
} from "./runtimeTypes";

type CreateMcpRuntimeContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  dnsLookup?: DnsLookupFn;
};

type InitializableMcpAdapter = McpServerAdapter & {
  initialize?: () => Promise<void>;
};

type McpServerOrigin = LoadedMcpConfig["serverOrigins"][string];

type DnsLookupAddress = {
  address: string;
  family: number;
};

type DnsLookupFn = (
  hostname: string,
  options: { all: true; verbatim?: boolean }
) => Promise<DnsLookupAddress[]>;

const FILE_ALIAS_NAMES = ["file", "fs", "mcp.file"];

const cloneLspServerConfig = (entry: LspServerConfig): LspServerConfig => ({
  ...entry,
  args: [...entry.args],
  filePatterns: [...entry.filePatterns],
  rootMarkers: [...entry.rootMarkers],
  ...(entry.env ? { env: { ...entry.env } } : {}),
});

const buildFilesystemLspSummary = (lspServers?: LspServerConfig[]) =>
  lspServers
    ? {
        configuredCount: lspServers.length,
        serverIds: lspServers.map(entry => entry.id),
      }
    : undefined;

const createBlockedRemoteAdapter = (
  descriptor: McpServerDescriptor,
  serverId: string,
  message: string
): InitializableMcpAdapter => ({
  descriptor: {
    ...descriptor,
    enabled: false,
    health: "offline",
  },
  async handleToolCall() {
    return {
      ok: false,
      message,
    };
  },
  listPending() {
    return [];
  },
  async approve(id: string) {
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  },
  reject(id: string) {
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  },
  async undoLastMutation() {
    return {
      ok: false,
      message: `Undo is not supported for MCP server: ${serverId}`,
    };
  },
});

const isBlockedPrivateIpv4Host = (hostname: string) => {
  const octets = hostname.split(".").map(part => Number(part));
  if (
    octets.length !== 4 ||
    octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const isBlockedPrivateIpv6Host = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4 && isBlockedPrivateIpv4Host(mappedIpv4)) {
    return true;
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
};

const isBlockedPrivateHttpHost = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (!normalized) {
    return true;
  }
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "host.docker.internal" ||
    normalized === "gateway.docker.internal" ||
    normalized === "kubernetes.docker.internal"
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isBlockedPrivateIpv4Host(normalized);
  }
  if (ipVersion === 6) {
    return isBlockedPrivateIpv6Host(normalized);
  }
  return false;
};

const defaultDnsLookupAll: DnsLookupFn = async (hostname, options) =>
  (await dnsLookup(hostname, options)) as DnsLookupAddress[];

const resolveHttpHostnameAddresses = async (
  hostname: string,
  lookupFn: DnsLookupFn
) => {
  try {
    const resolved = await lookupFn(hostname, {
      all: true,
      verbatim: true,
    });
    const addresses = Array.from(
      new Set(
        resolved
          .map(entry => entry.address.trim())
          .filter(Boolean)
      )
    );
    return addresses.length > 0 ? addresses : null;
  } catch {
    return null;
  }
};

const getRemoteHttpBlockMessage = async (
  server: McpConfiguredServer,
  origin: McpServerOrigin | undefined,
  context?: CreateMcpRuntimeContext
) => {
  if (!server.url) {
    return `MCP http server missing url: ${server.id}`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(server.url);
  } catch {
    return `MCP http server blocked: invalid url: ${server.url}`;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return `MCP http server blocked: unsupported url scheme: ${server.url}`;
  }
  if (server.allowPrivateNetwork === true) {
    return null;
  }
  if (isBlockedPrivateHttpHost(parsedUrl.hostname)) {
    return [
      `MCP http server blocked: private or loopback addresses require allow_private_network: true`,
      `server: ${server.id}`,
      `url: ${server.url}`,
      origin?.configPath ? `config: ${origin.configPath}` : "",
      "hint: only enable allow_private_network for intentionally trusted local/private MCP endpoints",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const normalizedHostname = parsedUrl.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (isIP(normalizedHostname) !== 0) {
    return null;
  }

  const resolvedAddresses = await resolveHttpHostnameAddresses(
    normalizedHostname,
    context?.dnsLookup ?? defaultDnsLookupAll
  );
  if (!resolvedAddresses) {
    return null;
  }
  const blockedResolvedAddresses = resolvedAddresses.filter(address =>
    isBlockedPrivateHttpHost(address)
  );
  if (blockedResolvedAddresses.length === 0) {
    return null;
  }

  return [
    `MCP http server blocked: hostname resolved to private or loopback address(es)`,
    `server: ${server.id}`,
    `url: ${server.url}`,
    `hostname: ${normalizedHostname}`,
    `resolved_addresses: ${blockedResolvedAddresses.join(", ")}`,
    origin?.configPath ? `config: ${origin.configPath}` : "",
    "hint: only enable allow_private_network for intentionally trusted local/private MCP endpoints",
  ]
    .filter(Boolean)
    .join("\n");
};

const createRuleConfigFromServer = (
  appRoot: string,
  server: McpConfiguredServer
): RuleConfig => ({
  workspaceRoot: resolve(appRoot, server.workspaceRoot ?? appRoot),
  maxReadBytes: server.maxReadBytes ?? 120_000,
  requireReview: [...(server.requireReview ?? [])],
  lspServers: (server.lspServers ?? []).map(entry => cloneLspServerConfig(entry)),
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
    lsp: buildFilesystemLspSummary(server.lspServers),
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

const createRemoteServerAdapter = async (
  appRoot: string,
  server: McpConfiguredServer,
  origin: McpServerOrigin | undefined,
  context?: CreateMcpRuntimeContext
): Promise<InitializableMcpAdapter> => {
  const adapter =
    server.transport === "stdio"
      ? new StdioMcpAdapter(server, {
          appRoot,
          env: context?.env,
        })
      : server.transport === "http"
        ? new HttpMcpAdapter(server, {
            appRoot,
            validateRequestUrl: () =>
              getRemoteHttpBlockMessage(server, origin, context),
          })
        : null;

  if (!adapter) {
    throw new Error(`Unsupported MCP transport: ${server.transport}`);
  }

  if (server.transport === "http") {
    const httpBlockMessage = await getRemoteHttpBlockMessage(server, origin, context);
    if (httpBlockMessage) {
      return createBlockedRemoteAdapter(adapter.descriptor, server.id, httpBlockMessage);
    }
  }

  if (origin?.scope === "project" && server.trusted !== true) {
    const trustMessage = [
      `Project MCP server is blocked until trusted: ${server.id}`,
      `transport: ${server.transport}`,
      origin.configPath ? `config: ${origin.configPath}` : "",
      "hint: set `trusted: true` in .cyrene/mcp.yaml or re-enable the server via /mcp enable <id>",
    ]
      .filter(Boolean)
      .join("\n");
    return createBlockedRemoteAdapter(adapter.descriptor, server.id, trustMessage);
  }

  return adapter;
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
  env: server.env ? { ...server.env } : undefined,
  headers: server.headers ? { ...server.headers } : undefined,
  ...(server.lspServers ? { lspServers: server.lspServers.map(entry => cloneLspServerConfig(entry)) } : {}),
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
    trusted:
      input.transport === "filesystem"
        ? undefined
        : true,
    aliases: normalizeAliases(id, input.aliases),
    workspaceRoot:
      input.transport === "filesystem"
        ? input.workspaceRoot?.trim() || "."
        : input.workspaceRoot?.trim(),
    cwd: input.cwd?.trim() || undefined,
    maxReadBytes:
      typeof input.maxReadBytes === "number"
        ? Math.max(1, Math.floor(input.maxReadBytes))
        : undefined,
    requireReview: input.requireReview ? [...input.requireReview] : undefined,
    command: input.command?.trim(),
    args: input.args ? [...input.args] : undefined,
    url: input.url?.trim(),
    allowPrivateNetwork:
      typeof input.allowPrivateNetwork === "boolean"
        ? input.allowPrivateNetwork
        : undefined,
    env: normalizeEnvRecord(input.env),
    headers: normalizeEnvRecord(input.headers),
    lspServers: [],
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

const normalizeEnvRecord = (env?: Record<string, string>) => {
  if (!env) {
    return undefined;
  }
  const entries = Object.entries(env)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => Boolean(key) && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const normalizeLspServerInput = (
  input: McpRuntimeLspServerInput
): LspServerConfig => {
  const id = input.id.trim();
  const command = input.command.trim();
  const filePatterns = input.filePatterns
    .map(pattern => pattern.trim())
    .filter(Boolean);
  const rootMarkers = (input.rootMarkers ?? [])
    .map(marker => marker.trim())
    .filter(Boolean);

  if (!id) {
    throw new Error("LSP server id is required.");
  }
  if (!command) {
    throw new Error(`LSP server command is required: ${id}`);
  }
  if (filePatterns.length === 0) {
    throw new Error(`LSP server requires at least one file pattern: ${id}`);
  }

  return createLspServerConfig({
    id,
    command,
    args: (input.args ?? []).map(arg => arg.trim()).filter(Boolean),
    filePatterns,
    rootMarkers,
    workspaceRoot: input.workspaceRoot?.trim() || undefined,
    env: normalizeEnvRecord(input.env),
  });
};

const toRuntimeLspServerDescriptor = (
  server: McpConfiguredServer,
  lsp: LspServerConfig
): McpRuntimeLspServerDescriptor => ({
  filesystemServerId: server.id,
  filesystemWorkspaceRoot: resolve(server.workspaceRoot ?? "."),
  id: lsp.id,
  command: lsp.command,
  args: [...lsp.args],
  filePatterns: [...lsp.filePatterns],
  rootMarkers: [...lsp.rootMarkers],
  workspaceRoot: lsp.workspaceRoot,
  envKeys: Object.keys(lsp.env ?? {}).sort((left, right) =>
    left.localeCompare(right)
  ),
});

const BOOTSTRAP_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);
const BOOTSTRAP_MAX_FILES = 4_000;

const collectWorkspacePathsForLspBootstrap = async (workspaceRoot: string) => {
  const collected: string[] = [];
  const queue = [resolve(workspaceRoot)];

  while (queue.length > 0 && collected.length < BOOTSTRAP_MAX_FILES) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    try {
      const entries = await readdir(current, {
        withFileTypes: true,
        encoding: "utf8",
      });

      for (const entry of entries) {
        const absolute = resolve(current, entry.name);
        const relativePath = relative(workspaceRoot, absolute).replace(/\\/g, "/");
        if (!relativePath || relativePath.startsWith("..")) {
          continue;
        }

        if (entry.isDirectory()) {
          if (!BOOTSTRAP_IGNORED_DIRS.has(entry.name)) {
            queue.push(absolute);
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        collected.push(relativePath);
        if (collected.length >= BOOTSTRAP_MAX_FILES) {
          break;
        }
      }
    } catch {
      continue;
    }
  }

  return collected;
};

const detectRelevantLspPresets = async (workspaceRoot: string): Promise<LspPreset[]> => {
  const paths = await collectWorkspacePathsForLspBootstrap(workspaceRoot);
  if (paths.length === 0) {
    return [];
  }
  return listLspPresets().filter(preset =>
    paths.some(path => matchesLspPresetPath(preset, path))
  );
};

type LspDoctorFailureReason = NonNullable<McpRuntimeLspDoctorResult["reason"]>;

const classifyLspDoctorFailure = (
  message: string,
  startupFailed: boolean,
  requestFailed: boolean
): {
  reason: LspDoctorFailureReason;
  hint: string;
} => {
  const normalized = message.toLowerCase();

  if (normalized.includes("method not found")) {
    return {
      reason: "unsupported_request",
      hint: "the server started but rejected this LSP method; verify capability support or try a different lsp_* tool",
    };
  }
  if (normalized.includes("permission denied") || normalized.includes("eacces")) {
    return {
      reason: "permission_denied",
      hint: "the configured command is not executable; fix file permissions or point --command to a runnable binary",
    };
  }
  if (
    normalized.includes("invalid lsp frame") ||
    normalized.includes("invalid lsp json")
  ) {
    return {
      reason: "invalid_protocol_output",
      hint: "the process did not speak stdio LSP JSON-RPC; confirm the command/args use the server's --stdio mode",
    };
  }
  if (normalized.includes("exited before request completed")) {
    return {
      reason: "process_exited_early",
      hint: "the language server exited during initialize; run the command manually to inspect stderr or missing runtime dependencies",
    };
  }
  if (
    normalized.includes("failed to launch") &&
    (normalized.includes("enoent") ||
      normalized.includes("not found") ||
      normalized.includes("command not found"))
  ) {
    return {
      reason: "command_not_found",
      hint: "the configured command was not found in PATH; install the language server or set --command to an executable path",
    };
  }
  if (startupFailed) {
    return {
      reason: "startup_failed",
      hint: "install the language server binary or fix the configured command/args/env",
    };
  }
  if (requestFailed) {
    return {
      reason: "request_failed",
      hint: "the server started but the request failed; verify project roots/settings or try a simpler lsp_* probe first",
    };
  }
  return {
    reason: "unknown",
    hint: "adjust file_patterns/root_markers/workspace_root or re-run with --lsp <id>",
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
        : await createRemoteServerAdapter(
            appRoot,
            server,
            config.serverOrigins[server.id],
            context
          );
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

  private resolveFilesystemServer(serverId: string) {
    const normalizedId = serverId.trim();
    const server = this.getConfig().servers.find(
      entry => entry.id === normalizedId
    );
    if (!server) {
      return {
        ok: false as const,
        normalizedId,
        message: `MCP filesystem server not found: ${serverId}`,
      };
    }
    if (server.transport !== "filesystem") {
      return {
        ok: false as const,
        normalizedId,
        message: `MCP server is not a filesystem server: ${serverId}`,
      };
    }
    return {
      ok: true as const,
      normalizedId,
      server,
    };
  }

  private getEditableFilesystemPatchServer(serverId: string) {
    const resolved = this.resolveFilesystemServer(serverId);
    if (!resolved.ok) {
      return resolved;
    }

    const currentConfig = this.getConfig();
    const existingPatchServer =
      currentConfig.projectPatch.servers.find(server => server.id === resolved.normalizedId) ??
      toPatchServer(this.appRoot, resolved.server);

    return {
      ...resolved,
      patchServer: existingPatchServer,
    };
  }

  private resolveFilesystemDoctorPath(server: McpConfiguredServer, inputPath: string) {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      throw new Error("LSP doctor requires a file path.");
    }

    const workspaceRoot = resolve(server.workspaceRoot ?? this.appRoot);
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot, trimmed);
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
      message: [
        buildMutationMessage("MCP server added", server.id, saved.path),
        ...(server.transport === "filesystem"
          ? ["tip: use /mcp lsp add ... to configure lsp_servers for this filesystem server"]
          : []),
      ].join("\n"),
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
      ...(current.transport !== "filesystem" && enabled ? { trusted: true } : {}),
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

  listLspServers(filesystemServerId?: string): McpRuntimeLspServerDescriptor[] {
    const servers = this.getConfig().servers.filter(server => server.transport === "filesystem");
    const filtered = filesystemServerId
      ? servers.filter(server => server.id === filesystemServerId.trim())
      : servers;

    return filtered
      .flatMap(server =>
        (server.lspServers ?? []).map(lsp => toRuntimeLspServerDescriptor(server, lsp))
      )
      .sort((left, right) =>
        left.filesystemServerId === right.filesystemServerId
          ? left.id.localeCompare(right.id)
          : left.filesystemServerId.localeCompare(right.filesystemServerId)
      );
  }

  async addLspServer(
    filesystemServerId: string,
    input: McpRuntimeLspServerInput
  ): Promise<McpRuntimeMutationResult> {
    const editable = this.getEditableFilesystemPatchServer(filesystemServerId);
    if (!editable.ok) {
      return {
        ok: false,
        message: editable.message,
      };
    }

    const nextLsp = normalizeLspServerInput(input);
    const patch = cloneConfigPatch(this.getConfig().projectPatch);
    patch.removeServerIds = patch.removeServerIds.filter(id => id !== editable.normalizedId);
    const nextPatchServer = cloneConfiguredServer(editable.patchServer);
    nextPatchServer.lspServers = [
      ...(nextPatchServer.lspServers ?? []).filter(server => server.id !== nextLsp.id),
      nextLsp,
    ];
    upsertPatchServer(patch, nextPatchServer);

    const saved = await saveProjectMcpConfig(this.appRoot, patch, this.context);
    await this.load();
    const matchedPreset = findLspPresetByInput(input);

    return {
      ok: true,
      message: [
        "MCP LSP server added",
        `filesystem_server: ${editable.normalizedId}`,
        `lsp_server: ${nextLsp.id}`,
        `command: ${nextLsp.command}`,
        `args: ${nextLsp.args.length > 0 ? nextLsp.args.join(" ") : "(none)"}`,
        `patterns: ${nextLsp.filePatterns.join(", ")}`,
        `roots: ${
          nextLsp.rootMarkers.length > 0
            ? nextLsp.rootMarkers.join(", ")
            : "(none)"
        }`,
        `workspace: ${nextLsp.workspaceRoot ?? "(filesystem workspace)"}`,
        `env_keys: ${
          Object.keys(nextLsp.env ?? {}).sort((left, right) =>
            left.localeCompare(right)
          ).join(", ") || "(none)"
        }`,
        `config: ${saved.path}`,
        ...(matchedPreset?.installHint ? [`install_hint: ${matchedPreset.installHint}`] : []),
        `hint: run /mcp lsp doctor ${editable.normalizedId} <path> --lsp ${nextLsp.id} to verify startup`,
      ].join("\n"),
      serverId: editable.normalizedId,
      configPath: saved.path,
    };
  }

  async bootstrapLsp(filesystemServerId: string): Promise<McpRuntimeMutationResult> {
    const editable = this.getEditableFilesystemPatchServer(filesystemServerId);
    if (!editable.ok) {
      return {
        ok: false,
        message: editable.message,
      };
    }

    const workspaceRoot = resolve(editable.server.workspaceRoot ?? this.appRoot);
    const detectedPresets = await detectRelevantLspPresets(workspaceRoot);
    if (detectedPresets.length === 0) {
      return {
        ok: true,
        message: [
          "MCP LSP bootstrap",
          `filesystem_server: ${editable.normalizedId}`,
          `workspace: ${workspaceRoot}`,
          "detected: (none)",
          "added: (none)",
          "skipped_existing: (none)",
          "hint: no known mainstream-language files were detected in this workspace",
        ].join("\n"),
        serverId: editable.normalizedId,
      };
    }

    const existing = editable.server.lspServers ?? [];
    const existingIds = new Set(existing.map(server => server.id.toLowerCase()));
    const existingCommands = new Set(existing.map(server => server.command.toLowerCase()));
    const presetsToAdd = detectedPresets.filter(
      preset =>
        !existingIds.has(preset.id.toLowerCase()) &&
        !existingCommands.has(preset.command.toLowerCase())
    );
    const skipped = detectedPresets.filter(preset => !presetsToAdd.includes(preset));

    if (presetsToAdd.length === 0) {
      return {
        ok: true,
        message: [
          "MCP LSP bootstrap",
          `filesystem_server: ${editable.normalizedId}`,
          `workspace: ${workspaceRoot}`,
          `detected: ${detectedPresets.map(preset => preset.id).join(", ")}`,
          "added: (none)",
          `skipped_existing: ${skipped.map(preset => preset.id).join(", ") || "(none)"}`,
          "hint: the detected mainstream-language presets are already configured",
        ].join("\n"),
        serverId: editable.normalizedId,
      };
    }

    const patch = cloneConfigPatch(this.getConfig().projectPatch);
    patch.removeServerIds = patch.removeServerIds.filter(id => id !== editable.normalizedId);
    const nextPatchServer = cloneConfiguredServer(editable.patchServer);
    nextPatchServer.lspServers = [
      ...existing.map(server => cloneLspServerConfig(server)),
      ...presetsToAdd.map(preset => normalizeLspServerInput(createLspInputFromPreset(preset))),
    ];
    upsertPatchServer(patch, nextPatchServer);

    const saved = await saveProjectMcpConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: [
        "MCP LSP bootstrap",
        `filesystem_server: ${editable.normalizedId}`,
        `workspace: ${workspaceRoot}`,
        `detected: ${detectedPresets.map(preset => preset.id).join(", ")}`,
        `added: ${presetsToAdd.map(preset => preset.id).join(", ")}`,
        `skipped_existing: ${skipped.map(preset => preset.id).join(", ") || "(none)"}`,
        `config: ${saved.path}`,
        "install_hints:",
        ...presetsToAdd.map(preset => `- ${preset.id}: ${preset.installHint ?? "install the matching language server and ensure it is in PATH"}`),
        `hint: run /mcp lsp list ${editable.normalizedId} to review all configured language servers`,
      ].join("\n"),
      serverId: editable.normalizedId,
      configPath: saved.path,
    };
  }

  async removeLspServer(
    filesystemServerId: string,
    lspServerId: string
  ): Promise<McpRuntimeMutationResult> {
    const editable = this.getEditableFilesystemPatchServer(filesystemServerId);
    if (!editable.ok) {
      return {
        ok: false,
        message: editable.message,
      };
    }

    const normalizedLspId = lspServerId.trim();
    if (!normalizedLspId) {
      return {
        ok: false,
        message: "LSP server id is required.",
      };
    }

    const currentLspServers = editable.server.lspServers ?? [];
    if (!currentLspServers.some(server => server.id === normalizedLspId)) {
      return {
        ok: false,
        message: `MCP LSP server not found: ${editable.normalizedId}/${normalizedLspId}`,
      };
    }

    const patch = cloneConfigPatch(this.getConfig().projectPatch);
    patch.removeServerIds = patch.removeServerIds.filter(id => id !== editable.normalizedId);
    const nextPatchServer = cloneConfiguredServer(editable.patchServer);
    nextPatchServer.lspServers = currentLspServers
      .filter(server => server.id !== normalizedLspId)
      .map(server => cloneLspServerConfig(server));
    upsertPatchServer(patch, nextPatchServer);

    const saved = await saveProjectMcpConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: [
        "MCP LSP server removed",
        `filesystem_server: ${editable.normalizedId}`,
        `lsp_server: ${normalizedLspId}`,
        `remaining: ${
          nextPatchServer.lspServers && nextPatchServer.lspServers.length > 0
            ? nextPatchServer.lspServers.map(server => server.id).join(", ")
            : "(none)"
        }`,
        `config: ${saved.path}`,
        `hint: run /mcp lsp list ${editable.normalizedId} to confirm the remaining configuration`,
      ].join("\n"),
      serverId: editable.normalizedId,
      configPath: saved.path,
    };
  }

  async doctorLsp(
    filesystemServerId: string,
    path: string,
    options?: { lspServerId?: string }
  ): Promise<McpRuntimeLspDoctorResult> {
    const resolved = this.resolveFilesystemServer(filesystemServerId);
    if (!resolved.ok) {
      return {
        ok: false,
        status: "config_error",
        filesystemServerId: resolved.normalizedId || filesystemServerId,
        workspaceRoot: this.appRoot,
        inputPath: path,
        resolvedPath: path,
        configuredServerIds: [],
        matchedServerIds: [],
        message: resolved.message,
      };
    }

    const workspaceRoot = resolve(resolved.server.workspaceRoot ?? this.appRoot);
    const resolvedPath = this.resolveFilesystemDoctorPath(resolved.server, path);
    const configuredServerIds = (resolved.server.lspServers ?? []).map(entry => entry.id);
    const manager = new LspManager(workspaceRoot, (resolved.server.lspServers ?? []).map(entry =>
      cloneLspServerConfig(entry)
    ), {
      env: this.context?.env,
    });

    const baseLines = [
      "MCP LSP doctor",
      `filesystem_server: ${resolved.server.id}`,
      `requested_lsp: ${options?.lspServerId?.trim() || "(auto)"}`,
      `workspace_root: ${workspaceRoot}`,
      `input_path: ${path}`,
      `resolved_path: ${resolvedPath}`,
      `configured: ${configuredServerIds.length > 0 ? configuredServerIds.join(", ") : "(none)"}`,
    ];

    try {
      const fileInfo = await stat(resolvedPath);
      if (!fileInfo.isFile()) {
        return {
          ok: false,
          status: "config_error",
          reason: "path_not_file",
          filesystemServerId: resolved.server.id,
          workspaceRoot,
          inputPath: path,
          resolvedPath,
          configuredServerIds,
          matchedServerIds: [],
          message: [
            ...baseLines,
            "status: config_error",
            "reason: path_not_file",
            "hint: the requested path must point to an existing readable file inside the filesystem workspace",
          ].join("\n"),
        };
      }
    } catch {
      return {
        ok: false,
        status: "config_error",
        reason: "path_not_readable",
        filesystemServerId: resolved.server.id,
        workspaceRoot,
        inputPath: path,
        resolvedPath,
        configuredServerIds,
        matchedServerIds: [],
        message: [
          ...baseLines,
          "status: config_error",
          "reason: path_not_readable",
          "hint: the requested path does not exist or is not readable from the filesystem workspace",
        ].join("\n"),
      };
    }

    try {
      const inspection = await manager.inspectPath(resolvedPath, {
        serverId: options?.lspServerId,
      });
      const session = await manager.getSession(resolvedPath, {
        serverId: options?.lspServerId,
      });
      await session.probe(resolvedPath);

      return {
        ok: true,
        status: "ready",
        reason: undefined,
        filesystemServerId: resolved.server.id,
        workspaceRoot,
        inputPath: path,
        resolvedPath,
        configuredServerIds,
        matchedServerIds: [...inspection.matchedServerIds],
        selectedServerId: inspection.selectedServerId,
        resolvedRoot: inspection.resolvedRoot,
        message: [
          ...baseLines,
          `matched: ${inspection.matchedServerIds.length > 0 ? inspection.matchedServerIds.join(", ") : "(none)"}`,
          `selected: ${inspection.selectedServerId ?? "(none)"}`,
          `resolved_root: ${inspection.resolvedRoot ?? "(none)"}`,
          "status: ready",
          "hint: lsp_* tools can use this file now; pass serverId only when multiple servers could match",
        ].join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const requestFailed = message.startsWith("LSP request failed:");
      const startupFailed = message.startsWith("LSP startup error:");
      const status =
        startupFailed || requestFailed ? "startup_error" : "config_error";
      const classifiedFailure = classifyLspDoctorFailure(
        message,
        startupFailed,
        requestFailed
      );
      const reason = isLspConfigError(error)
        ? error.code
        : classifiedFailure.reason;
      const hintLine = isLspConfigError(error)
        ? undefined
        : status === "startup_error"
          ? `hint: ${classifiedFailure.hint}`
          : configuredServerIds.length === 0
            ? `hint: add an lsp server with /mcp lsp add ${resolved.server.id} <lsp-id> --command <cmd> --pattern <glob>`
            : "hint: adjust file_patterns/root_markers/workspace_root or re-run with --lsp <id>";
      return {
        ok: false,
        status,
        reason,
        filesystemServerId: resolved.server.id,
        workspaceRoot,
        inputPath: path,
        resolvedPath,
        configuredServerIds,
        matchedServerIds: [],
        message: [
          ...baseLines,
          `status: ${status}`,
          ...(isLspConfigError(error)
            ? error.detailLines
            : [`reason: ${reason}`, `error: ${message}`]),
          ...(hintLine ? [hintLine] : []),
        ].join("\n"),
      };
    } finally {
      await manager.dispose().catch(() => undefined);
    }
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
