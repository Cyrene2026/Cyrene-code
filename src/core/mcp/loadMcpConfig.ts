import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  resolveAmbientAppRoot,
} from "../../infra/config/appRoot";
import {
  defaultMcpServerExposureMode,
  defaultMcpToolExposureMode,
  normalizeExtensionExposureMode,
  type ExtensionExposureMode,
} from "../extensions/metadata";
import type { LspServerConfig, MpcAction } from "./toolTypes";
import { loadFilesystemRuleConfig } from "./adapters/filesystem";
import { parseYamlDocument, stringifyYamlDocument } from "./simpleYaml";
import type {
  McpServerTransport,
  McpToolCapability,
  McpToolRisk,
} from "./runtimeTypes";

type McpConfigLoadContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type McpConfigScope = "default" | "global" | "project";

export type McpConfiguredTool = {
  name: string;
  label?: string;
  description?: string;
  capabilities?: McpToolCapability[];
  risk?: McpToolRisk;
  requiresReview?: boolean;
  enabled?: boolean;
  exposure?: ExtensionExposureMode;
  tags?: string[];
};

export type McpConfiguredServer = {
  id: string;
  transport?: McpServerTransport;
  label: string;
  enabled: boolean;
  trusted?: boolean;
  aliases: string[];
  workspaceRoot?: string;
  cwd?: string;
  maxReadBytes?: number;
  requireReview?: MpcAction[];
  command?: string;
  args?: string[];
  url?: string;
  allowPrivateNetwork?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  exposure?: ExtensionExposureMode;
  tags?: string[];
  hint?: string;
  lspServers?: LspServerConfig[];
  tools: McpConfiguredTool[];
};

export type McpConfigPatch = {
  primaryServerId?: string;
  removeServerIds: string[];
  servers: McpConfiguredServer[];
};

export type LoadedMcpConfig = {
  primaryServerId: string;
  servers: McpConfiguredServer[];
  configPaths: string[];
  editableConfigPath: string;
  projectPatch: McpConfigPatch;
  serverOrigins: Record<
    string,
    {
      scope: McpConfigScope;
      configPath?: string;
    }
  >;
};

type LoadedConfigPatchFile = {
  path: string;
  patch: McpConfigPatch;
};

const SUPPORTED_MCP_ACTIONS: MpcAction[] = [
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
  "ts_hover",
  "ts_definition",
  "ts_references",
  "ts_diagnostics",
  "ts_prepare_rename",
  "lsp_hover",
  "lsp_definition",
  "lsp_implementation",
  "lsp_type_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_diagnostics",
  "lsp_prepare_rename",
  "lsp_rename",
  "lsp_code_actions",
  "lsp_format_document",
  "run_command",
  "run_shell",
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
];

const SUPPORTED_CAPABILITIES: McpToolCapability[] = [
  "read",
  "write",
  "search",
  "shell",
  "command",
  "git",
  "review",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeString = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeBoolean = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

const normalizeStringArray = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeString(item))
      .filter((item): item is string => Boolean(item));
  }
  const single = normalizeString(value);
  return single ? [single] : [];
};

const normalizeStringRecord = (value: unknown) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeString(entry);
    if (normalized) {
      next[key] = normalized;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const normalizeActionArray = (value: unknown) =>
  normalizeStringArray(value).filter(
    (item): item is MpcAction => SUPPORTED_MCP_ACTIONS.includes(item as MpcAction)
  );

const normalizeCapabilityArray = (value: unknown) =>
  normalizeStringArray(value).filter(
    (item): item is McpToolCapability =>
      SUPPORTED_CAPABILITIES.includes(item as McpToolCapability)
  );

const normalizeRisk = (value: unknown): McpToolRisk | undefined =>
  value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;

const normalizeTransport = (value: unknown): McpServerTransport | undefined => {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "filesystem" || normalized === "stdio" || normalized === "http") {
    return normalized;
  }
  return undefined;
};

const inferTransport = (value: Record<string, unknown>): McpServerTransport | undefined => {
  if (normalizeString(value.url)) {
    return "http";
  }
  if (normalizeString(value.command)) {
    return "stdio";
  }
  if (
    value.workspace_root !== undefined ||
    value.workspaceRoot !== undefined ||
    value.max_read_bytes !== undefined ||
    value.maxReadBytes !== undefined ||
    value.require_review !== undefined ||
    value.requireReview !== undefined ||
    value.lsp_servers !== undefined ||
    value.lspServers !== undefined
  ) {
    return "filesystem";
  }
  return undefined;
};

const normalizeTool = (value: unknown): McpConfiguredTool | null => {
  if (typeof value === "string") {
    const name = normalizeString(value);
    if (!name) {
      return null;
    }
    return {
      name,
      enabled: true,
      tags: [],
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const name = normalizeString(value.name);
  if (!name) {
    return null;
  }

  return {
    name,
    label: normalizeString(value.label),
    description: normalizeString(value.description),
    capabilities: normalizeCapabilityArray(value.capabilities),
    risk: normalizeRisk(value.risk),
    requiresReview:
      typeof value.requires_review === "boolean"
        ? value.requires_review
        : typeof value.requiresReview === "boolean"
          ? value.requiresReview
          : undefined,
    enabled: normalizeBoolean(value.enabled, true),
    exposure: normalizeExtensionExposureMode(value.exposure),
    tags: normalizeStringArray(value.tags),
  };
};

const normalizeLspServer = (value: unknown): LspServerConfig | null => {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  const command = normalizeString(value.command);
  if (!id || !command) {
    return null;
  }

  const filePatterns = normalizeStringArray(
    value.file_patterns ?? value.filePatterns ?? value.patterns ?? value.glob
  );
  const rootMarkers = normalizeStringArray(
    value.root_markers ?? value.rootMarkers ?? value.roots ?? value.markers
  );

  if (filePatterns.length === 0) {
    return null;
  }

  return {
    id,
    command,
    args: normalizeStringArray(value.args),
    filePatterns,
    rootMarkers,
    workspaceRoot: normalizeString(value.workspace_root ?? value.workspaceRoot),
    ...(value.initialization_options !== undefined
      ? { initializationOptions: value.initialization_options }
      : value.initializationOptions !== undefined
        ? { initializationOptions: value.initializationOptions }
        : {}),
    ...(value.settings !== undefined ? { settings: value.settings } : {}),
    ...(normalizeStringRecord(value.env) ? { env: normalizeStringRecord(value.env) } : {}),
  };
};

const normalizeServer = (value: unknown): McpConfiguredServer | null => {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  if (!id) {
    return null;
  }

  const transport =
    normalizeTransport(value.transport ?? value.type) ?? inferTransport(value);
  const tools = Array.isArray(value.tools)
    ? value.tools
        .map(item => normalizeTool(item))
        .filter((item): item is McpConfiguredTool => Boolean(item))
    : [];
  const rawLspServers = value.lsp_servers ?? value.lspServers;
  const lspServers = Array.isArray(rawLspServers)
    ? rawLspServers
        .map(item => normalizeLspServer(item))
        .filter((item): item is LspServerConfig => Boolean(item))
    : undefined;

  const aliases = Array.from(
    new Set(
      normalizeStringArray(value.aliases ?? value.alias).filter(
        alias => alias.toLowerCase() !== id.toLowerCase()
      )
    )
  );

  return {
    id,
    transport,
    label: normalizeString(value.label) ?? id,
    enabled: normalizeBoolean(value.enabled, true),
    trusted:
      typeof value.trusted === "boolean"
        ? value.trusted
        : typeof value.trust === "boolean"
          ? value.trust
          : undefined,
    aliases,
    workspaceRoot: normalizeString(value.workspace_root ?? value.workspaceRoot),
    cwd: normalizeString(value.cwd),
    maxReadBytes:
      typeof value.max_read_bytes === "number"
        ? Math.max(1, Math.floor(value.max_read_bytes))
        : typeof value.maxReadBytes === "number"
          ? Math.max(1, Math.floor(value.maxReadBytes))
          : undefined,
    requireReview: normalizeActionArray(value.require_review ?? value.requireReview),
    command: normalizeString(value.command),
    args: normalizeStringArray(value.args),
    url: normalizeString(value.url),
    allowPrivateNetwork:
      typeof value.allow_private_network === "boolean"
        ? value.allow_private_network
        : typeof value.allowPrivateNetwork === "boolean"
          ? value.allowPrivateNetwork
          : undefined,
    ...(normalizeStringRecord(value.env) ? { env: normalizeStringRecord(value.env) } : {}),
    ...(normalizeStringRecord(value.headers)
      ? { headers: normalizeStringRecord(value.headers) }
      : {}),
    exposure: normalizeExtensionExposureMode(value.exposure),
    tags: normalizeStringArray(value.tags),
    hint: normalizeString(value.hint),
    ...(lspServers !== undefined ? { lspServers } : {}),
    tools,
  };
};

const parseMcpConfigPatch = (raw: unknown): McpConfigPatch => {
  if (!isRecord(raw)) {
    return {
      removeServerIds: [],
      servers: [],
    };
  }

  return {
    primaryServerId: normalizeString(raw.primary_server ?? raw.primaryServerId),
    removeServerIds: normalizeStringArray(
      raw.remove_servers ?? raw.removeServers ?? raw.removed_servers ?? raw.removedServers
    ),
    servers: Array.isArray(raw.servers)
      ? raw.servers
          .map(entry => normalizeServer(entry))
          .filter((entry): entry is McpConfiguredServer => Boolean(entry))
      : [],
  };
};

const readExistingFile = async (path: string) => {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

const loadConfigPatchFile = async (path: string): Promise<LoadedConfigPatchFile | null> => {
  const content = await readExistingFile(path);
  if (!content) {
    return null;
  }
  return {
    path,
    patch: parseMcpConfigPatch(parseYamlDocument(content)),
  };
};

const mergeServer = (
  base: McpConfiguredServer | undefined,
  patch: McpConfiguredServer
): McpConfiguredServer => ({
  id: patch.id,
  transport: patch.transport ?? base?.transport ?? "filesystem",
  label: patch.label || base?.label || patch.id,
  enabled: patch.enabled ?? base?.enabled ?? true,
  trusted: patch.trusted ?? base?.trusted,
  aliases: Array.from(new Set([...(base?.aliases ?? []), ...patch.aliases])),
  workspaceRoot: patch.workspaceRoot ?? base?.workspaceRoot,
  cwd: patch.cwd ?? base?.cwd,
  maxReadBytes: patch.maxReadBytes ?? base?.maxReadBytes,
  requireReview:
    patch.requireReview && patch.requireReview.length > 0
      ? [...patch.requireReview]
      : base?.requireReview
        ? [...base.requireReview]
        : undefined,
  command: patch.command ?? base?.command,
  args:
    patch.args && patch.args.length > 0
      ? [...patch.args]
      : [...(base?.args ?? [])],
  url: patch.url ?? base?.url,
  allowPrivateNetwork: patch.allowPrivateNetwork ?? base?.allowPrivateNetwork,
  env: patch.env ? { ...patch.env } : base?.env ? { ...base.env } : undefined,
  headers:
    patch.headers ? { ...patch.headers } : base?.headers ? { ...base.headers } : undefined,
  exposure:
    patch.exposure ??
    base?.exposure ??
    defaultMcpServerExposureMode({
      transport: patch.transport ?? base?.transport,
      enabled: patch.enabled ?? base?.enabled,
    }),
  tags:
    patch.tags && patch.tags.length > 0
      ? [...patch.tags]
      : [...(base?.tags ?? [])],
  hint: patch.hint ?? base?.hint,
  ...(patch.lspServers !== undefined
    ? {
        lspServers: patch.lspServers.map(server => ({
          ...server,
          args: [...server.args],
          filePatterns: [...server.filePatterns],
          rootMarkers: [...server.rootMarkers],
          ...(server.env ? { env: { ...server.env } } : {}),
        })),
      }
    : base?.lspServers
      ? {
          lspServers: base.lspServers.map(server => ({
            ...server,
            args: [...server.args],
            filePatterns: [...server.filePatterns],
            rootMarkers: [...server.rootMarkers],
            ...(server.env ? { env: { ...server.env } } : {}),
          })),
        }
      : {}),
  tools:
    patch.tools.length > 0
      ? patch.tools.map(tool => ({
          ...tool,
          tags: tool.tags ? [...tool.tags] : [],
          exposure:
            tool.exposure ??
            defaultMcpToolExposureMode(
              patch.exposure ??
                base?.exposure ??
                defaultMcpServerExposureMode({
                  transport: patch.transport ?? base?.transport,
                  enabled: patch.enabled ?? base?.enabled,
                })
            ),
        }))
      : (base?.tools ?? []).map(tool => ({
          ...tool,
          tags: tool.tags ? [...tool.tags] : [],
        })),
});

const mergeConfigPatches = (
  base: McpConfigPatch,
  patch: McpConfigPatch
): McpConfigPatch => {
  const serverMap = new Map<string, McpConfiguredServer>();

  for (const server of base.servers) {
    serverMap.set(server.id, {
      ...server,
      aliases: [...server.aliases],
      tags: [...(server.tags ?? [])],
      tools: server.tools.map(tool => ({
        ...tool,
        tags: [...(tool.tags ?? [])],
      })),
    });
  }

  for (const server of patch.servers) {
    serverMap.set(server.id, mergeServer(serverMap.get(server.id), server));
  }

  const removeServerIds = Array.from(
    new Set([
      ...base.removeServerIds.filter(id => !serverMap.has(id)),
      ...patch.removeServerIds,
    ])
  );

  return {
    primaryServerId: patch.primaryServerId ?? base.primaryServerId,
    removeServerIds,
    servers: [...serverMap.values()],
  };
};

const buildDefaultFilesystemServer = async (
  resolvedAppRoot: string,
  context?: McpConfigLoadContext
): Promise<McpConfiguredServer> => {
  const ruleConfig = await loadFilesystemRuleConfig(resolvedAppRoot, context);
  return {
    id: "filesystem",
    transport: "filesystem",
    label: "Filesystem",
    enabled: true,
    aliases: ["file", "fs", "mcp.file"],
    workspaceRoot: ruleConfig.workspaceRoot,
    maxReadBytes: ruleConfig.maxReadBytes,
    requireReview: [...ruleConfig.requireReview],
    exposure: defaultMcpServerExposureMode({
      transport: "filesystem",
      enabled: true,
    }),
    tags: ["filesystem", "workspace", "core"],
    hint: "Core workspace file, git, shell, and LSP operations.",
    lspServers: [...(ruleConfig.lspServers ?? [])],
    tools: [],
  };
};

const ensureFilesystemServer = (
  servers: McpConfiguredServer[],
  fallback: McpConfiguredServer
) => {
  const enabledFilesystem = servers.find(
    server => server.transport === "filesystem" && server.enabled
  );
  if (enabledFilesystem) {
    return servers;
  }

  const next = [...servers];
  const existingIndex = next.findIndex(server => server.id === fallback.id);
  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...mergeServer(next[existingIndex], fallback),
      enabled: true,
    };
  } else {
    next.unshift(fallback);
  }
  return next;
};

const ensureFilesystemAliases = (
  servers: McpConfiguredServer[],
  primaryFilesystemId: string
) =>
  servers.map(server =>
    server.id === primaryFilesystemId
      ? {
          ...server,
          aliases: Array.from(
            new Set(["file", "fs", "mcp.file", ...server.aliases])
          ),
        }
      : {
          ...server,
          aliases: server.aliases.filter(
            alias => !["file", "fs", "mcp.file"].includes(alias.toLowerCase())
          ),
        }
  );

const serializeConfiguredTool = (tool: McpConfiguredTool) => ({
  name: tool.name,
  ...(tool.label ? { label: tool.label } : {}),
  ...(tool.description ? { description: tool.description } : {}),
  ...(tool.capabilities && tool.capabilities.length > 0
    ? { capabilities: [...tool.capabilities] }
    : {}),
  ...(tool.risk ? { risk: tool.risk } : {}),
  ...(typeof tool.requiresReview === "boolean"
    ? { requires_review: tool.requiresReview }
    : {}),
  ...(tool.exposure ? { exposure: tool.exposure } : {}),
  ...(tool.tags && tool.tags.length > 0 ? { tags: [...tool.tags] } : {}),
  ...(typeof tool.enabled === "boolean" && !tool.enabled
    ? { enabled: tool.enabled }
    : {}),
});

const serializeConfiguredLspServer = (server: LspServerConfig) => ({
  id: server.id,
  command: server.command,
  ...(server.args.length > 0 ? { args: [...server.args] } : {}),
  file_patterns: [...server.filePatterns],
  ...(server.rootMarkers.length > 0 ? { root_markers: [...server.rootMarkers] } : {}),
  ...(server.workspaceRoot ? { workspace_root: server.workspaceRoot } : {}),
  ...(server.initializationOptions !== undefined
    ? { initialization_options: server.initializationOptions }
    : {}),
  ...(server.settings !== undefined ? { settings: server.settings } : {}),
  ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
});

const serializeConfiguredServer = (server: McpConfiguredServer) => ({
  id: server.id,
  ...(server.transport ? { transport: server.transport } : {}),
  ...(server.label && server.label !== server.id ? { label: server.label } : {}),
  ...(typeof server.enabled === "boolean" && !server.enabled
    ? { enabled: server.enabled }
    : {}),
  ...(typeof server.trusted === "boolean" ? { trusted: server.trusted } : {}),
  ...(server.aliases.length > 0 ? { aliases: [...server.aliases] } : {}),
  ...(server.exposure ? { exposure: server.exposure } : {}),
  ...(server.tags && server.tags.length > 0 ? { tags: [...server.tags] } : {}),
  ...(server.hint ? { hint: server.hint } : {}),
  ...(server.workspaceRoot ? { workspace_root: server.workspaceRoot } : {}),
  ...(server.cwd ? { cwd: server.cwd } : {}),
  ...(typeof server.maxReadBytes === "number"
    ? { max_read_bytes: server.maxReadBytes }
    : {}),
  ...(server.requireReview && server.requireReview.length > 0
    ? { require_review: [...server.requireReview] }
    : {}),
  ...(server.command ? { command: server.command } : {}),
  ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
  ...(server.url ? { url: server.url } : {}),
  ...(typeof server.allowPrivateNetwork === "boolean"
    ? { allow_private_network: server.allowPrivateNetwork }
    : {}),
  ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
  ...(server.headers && Object.keys(server.headers).length > 0
    ? { headers: { ...server.headers } }
    : {}),
  ...(server.lspServers !== undefined
    ? { lsp_servers: server.lspServers.map(entry => serializeConfiguredLspServer(entry)) }
    : {}),
  ...(server.tools.length > 0
    ? { tools: server.tools.map(tool => serializeConfiguredTool(tool)) }
    : {}),
});

const serializeMcpConfigPatch = (patch: McpConfigPatch) =>
  stringifyYamlDocument({
    ...(patch.primaryServerId ? { primary_server: patch.primaryServerId } : {}),
    ...(patch.removeServerIds.length > 0
      ? { remove_servers: [...patch.removeServerIds] }
      : {}),
    servers: patch.servers.map(server => serializeConfiguredServer(server)),
  });

const getProjectConfigCandidates = (projectDir: string) => [
  join(projectDir, "mcp.yaml"),
  join(projectDir, "mcp.yml"),
];

const resolveEditableConfigPath = (
  projectDir: string,
  projectFiles: LoadedConfigPatchFile[]
) => projectFiles[0]?.path ?? getProjectConfigCandidates(projectDir)[0]!;

export const saveProjectMcpConfig = async (
  appRoot: string,
  patch: McpConfigPatch,
  context?: McpConfigLoadContext
) => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const projectDir = getLegacyProjectCyreneDir(resolvedAppRoot);
  const projectFiles = (
    await Promise.all(getProjectConfigCandidates(projectDir).map(path => loadConfigPatchFile(path)))
  ).filter((entry): entry is LoadedConfigPatchFile => Boolean(entry));
  const editableConfigPath = resolveEditableConfigPath(projectDir, projectFiles);

  await mkdir(dirname(editableConfigPath), { recursive: true });
  await writeFile(editableConfigPath, serializeMcpConfigPatch(patch), "utf8");

  return {
    path: editableConfigPath,
  };
};

export const loadMcpConfig = async (
  appRoot?: string,
  context?: McpConfigLoadContext
): Promise<LoadedMcpConfig> => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const defaultFilesystem = await buildDefaultFilesystemServer(resolvedAppRoot, context);
  const globalDir = getCyreneConfigDir({
    cwd: resolvedAppRoot,
    env: context?.env,
  });
  const projectDir = getLegacyProjectCyreneDir(resolvedAppRoot);
  const globalCandidates = [
    join(globalDir, "mcp.yaml"),
    join(globalDir, "mcp.yml"),
  ];
  const projectCandidates = getProjectConfigCandidates(projectDir);

  const globalFiles = (
    await Promise.all(globalCandidates.map(candidate => loadConfigPatchFile(candidate)))
  ).filter((entry): entry is LoadedConfigPatchFile => Boolean(entry));
  const projectFiles = (
    await Promise.all(projectCandidates.map(candidate => loadConfigPatchFile(candidate)))
  ).filter((entry): entry is LoadedConfigPatchFile => Boolean(entry));

  const globalPatch = globalFiles.reduce<McpConfigPatch>(
    (acc, loaded) => mergeConfigPatches(acc, loaded.patch),
    {
      removeServerIds: [],
      servers: [],
    }
  );
  const projectPatch = projectFiles.reduce<McpConfigPatch>(
    (acc, loaded) => mergeConfigPatches(acc, loaded.patch),
    {
      removeServerIds: [],
      servers: [],
    }
  );

  const serverMap = new Map<string, McpConfiguredServer>([
    [defaultFilesystem.id, defaultFilesystem],
  ]);
  const serverOrigins = new Map<
    string,
    {
      scope: McpConfigScope;
      configPath?: string;
    }
  >([
    [
      defaultFilesystem.id,
      {
        scope: "default",
      },
    ],
  ]);
  let primaryServerId = defaultFilesystem.id;

  for (const loaded of globalFiles) {
    if (loaded.patch.primaryServerId) {
      primaryServerId = loaded.patch.primaryServerId;
    }

    for (const server of loaded.patch.servers) {
      const base = serverMap.get(server.id);
      serverMap.set(server.id, mergeServer(base, server));
      serverOrigins.set(server.id, {
        scope: "global",
        configPath: loaded.path,
      });
    }
  }

  for (const loaded of projectFiles) {
    if (loaded.patch.primaryServerId) {
      primaryServerId = loaded.patch.primaryServerId;
    }

    for (const server of loaded.patch.servers) {
      const base = serverMap.get(server.id);
      serverMap.set(server.id, mergeServer(base, server));
      serverOrigins.set(server.id, {
        scope: "project",
        configPath: loaded.path,
      });
    }
  }

  for (const serverId of projectPatch.removeServerIds) {
    serverMap.delete(serverId);
    serverOrigins.delete(serverId);
  }

  let servers: McpConfiguredServer[] = ensureFilesystemServer(
    [...serverMap.values()],
    defaultFilesystem
  ).map(server => ({
    ...server,
    workspaceRoot:
      server.workspaceRoot && server.transport === "filesystem"
        ? resolve(resolvedAppRoot, server.workspaceRoot)
        : server.workspaceRoot,
  }));

  const primaryFilesystem =
    servers.find(server => server.id === primaryServerId && server.transport === "filesystem") ??
    servers.find(server => server.transport === "filesystem" && server.enabled) ??
    defaultFilesystem;

  servers = ensureFilesystemAliases(servers, primaryFilesystem.id);

  if (!servers.some(server => server.id === primaryServerId && server.enabled)) {
    primaryServerId = primaryFilesystem.id;
  }

  if (!serverOrigins.has(primaryFilesystem.id)) {
    serverOrigins.set(primaryFilesystem.id, {
      scope: "default",
    });
  }

  return {
    primaryServerId,
    servers,
    configPaths: [...globalFiles, ...projectFiles].map(entry => entry.path),
    editableConfigPath: resolveEditableConfigPath(projectDir, projectFiles),
    projectPatch,
    serverOrigins: Object.fromEntries(serverOrigins.entries()),
  };
};
