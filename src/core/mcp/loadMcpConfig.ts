import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  resolveAmbientAppRoot,
} from "../../infra/config/appRoot";
import type { MpcAction } from "./toolTypes";
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
};

export type McpConfiguredServer = {
  id: string;
  transport: McpServerTransport;
  label: string;
  enabled: boolean;
  aliases: string[];
  workspaceRoot?: string;
  maxReadBytes?: number;
  requireReview?: MpcAction[];
  command?: string;
  args?: string[];
  url?: string;
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

const normalizeTransport = (value: unknown): McpServerTransport => {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "filesystem" || normalized === "stdio" || normalized === "http") {
    return normalized;
  }
  return "filesystem";
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

  const transport = normalizeTransport(value.transport ?? value.type);
  const tools = Array.isArray(value.tools)
    ? value.tools
        .map(item => normalizeTool(item))
        .filter((item): item is McpConfiguredTool => Boolean(item))
    : [];

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
    aliases,
    workspaceRoot: normalizeString(value.workspace_root ?? value.workspaceRoot),
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
  aliases: Array.from(new Set([...(base?.aliases ?? []), ...patch.aliases])),
  workspaceRoot: patch.workspaceRoot ?? base?.workspaceRoot,
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
  tools: patch.tools.length > 0 ? [...patch.tools] : [...(base?.tools ?? [])],
});

const mergeConfigPatches = (
  base: McpConfigPatch,
  patch: McpConfigPatch
): McpConfigPatch => {
  const serverMap = new Map<string, McpConfiguredServer>();

  for (const server of base.servers) {
    serverMap.set(server.id, { ...server, aliases: [...server.aliases], tools: [...server.tools] });
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
  ...(typeof tool.enabled === "boolean" && !tool.enabled
    ? { enabled: tool.enabled }
    : {}),
});

const serializeConfiguredServer = (server: McpConfiguredServer) => ({
  id: server.id,
  transport: server.transport,
  ...(server.label && server.label !== server.id ? { label: server.label } : {}),
  ...(typeof server.enabled === "boolean" && !server.enabled
    ? { enabled: server.enabled }
    : {}),
  ...(server.aliases.length > 0 ? { aliases: [...server.aliases] } : {}),
  ...(server.workspaceRoot ? { workspace_root: server.workspaceRoot } : {}),
  ...(typeof server.maxReadBytes === "number"
    ? { max_read_bytes: server.maxReadBytes }
    : {}),
  ...(server.requireReview && server.requireReview.length > 0
    ? { require_review: [...server.requireReview] }
    : {}),
  ...(server.command ? { command: server.command } : {}),
  ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
  ...(server.url ? { url: server.url } : {}),
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
