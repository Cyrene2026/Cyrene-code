import type {
  ExtensionManager,
  ExtensionManagerSummary,
  ExtensionQueryResolution,
  ManagedMcpServer,
  ManagedSkill,
  ResolvedExtension,
} from "../../core/extensions";
import type {
  McpRuntimeLspServerDescriptor,
  McpRuntimeSummary,
  McpServerDescriptor,
  McpToolDescriptor,
  PendingReviewItem,
} from "../../core/mcp";
import { formatLspPresetCatalog } from "../../core/mcp";
import type { SkillDefinition, SkillsRuntime } from "../../core/skills";

export const formatExtensionExposure = (exposure: string) => `exposure ${exposure}`;
export const formatExtensionScope = (scope?: string) => `scope ${scope ?? "default"}`;
export const formatExtensionTrust = (trusted?: boolean) =>
  `trust ${trusted === undefined ? "n/a" : trusted ? "trusted" : "untrusted"}`;
export const formatExtensionTags = (tags?: string[]) =>
  tags && tags.length > 0 ? tags.join(", ") : "(none)";
export const formatSelectionReason = (reason: string) =>
  reason.replace(/_/g, " ");

export const formatMcpAliases = (aliases?: string[]) =>
  aliases && aliases.length > 0 ? aliases.join(", ") : "(none)";

export const formatMcpCapabilities = (tool: McpToolDescriptor) =>
  tool.capabilities.length > 0 ? tool.capabilities.join(", ") : "-";

export const formatMcpLspSummary = (server: McpServerDescriptor) =>
  server.transport === "filesystem"
    ? server.lsp && server.lsp.configuredCount > 0
      ? `lsp ${server.lsp.configuredCount} configured | ${server.lsp.serverIds.join(", ")}`
      : "lsp none configured"
    : "";

export const formatMcpLspListHeader = (options: {
  scopeLabel: string;
  filesystemServerCount: number;
  configuredLspCount: number;
}) =>
  [
    "MCP LSP servers",
    `scope: ${options.scopeLabel}`,
    `filesystem_servers: ${options.filesystemServerCount}`,
    `configured_lsp_servers: ${options.configuredLspCount}`,
    "commands: /mcp lsp add <filesystem-server> <preset> [lsp-id] | /mcp lsp add ...custom-flags... | /mcp lsp bootstrap <filesystem-server> | /mcp lsp list [filesystem-server] | /mcp lsp doctor <filesystem-server> <path> [--lsp <lsp-id>]",
    `presets: ${formatLspPresetCatalog()}`,
  ].join("\n");

export const formatMcpLspServerHeader = (
  server: McpServerDescriptor,
  workspaceRoot: string,
  entryCount: number
) =>
  [
    `[${server.id}] ${server.label}`,
    `aliases ${formatMcpAliases(server.aliases)}`,
    `workspace ${workspaceRoot}`,
    `configured ${entryCount}`,
    formatMcpLspSummary(server),
  ]
    .filter(Boolean)
    .join(" | ");

export const formatMcpServerLine = (server: McpServerDescriptor) =>
  [
    `- ${server.id}`,
    server.label !== server.id ? `label ${server.label}` : "",
    `transport ${server.transport ?? "unknown"}`,
    `source ${server.source}`,
    formatExtensionScope(server.scope),
    formatExtensionTrust(server.trusted),
    formatExtensionExposure(server.exposure),
    `health ${server.health}`,
    server.enabled ? "enabled" : "disabled",
    `tools ${server.tools.length}`,
    formatMcpLspSummary(server),
    `aliases ${formatMcpAliases(server.aliases)}`,
    server.tags.length > 0 ? `tags ${formatExtensionTags(server.tags)}` : "",
    server.hint ? `hint ${server.hint}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

export const formatMcpToolLine = (tool: McpToolDescriptor) =>
  [
    `- ${tool.name}`,
    `caps ${formatMcpCapabilities(tool)}`,
    `risk ${tool.risk}`,
    formatExtensionExposure(tool.exposure),
    tool.requiresReview ? "review yes" : "review no",
    tool.enabled ? "enabled" : "disabled",
    tool.tags.length > 0 ? `tags ${formatExtensionTags(tool.tags)}` : "",
    tool.description ? `desc ${tool.description}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

export const formatMcpPendingLine = (
  item: PendingReviewItem,
  risk: string
) =>
  [
    `- ${item.id}`,
    `server ${item.serverId ?? "unknown"}`,
    `action ${item.request.action}`,
    `path ${item.request.path}`,
    `risk ${risk}`,
  ].join(" | ");

const formatMcpToolSectionHeader = (
  server: McpServerDescriptor,
  toolCount: number
) =>
  [
    `[${server.id}] ${server.label}`,
    `tools ${toolCount}`,
    formatMcpLspSummary(server),
  ]
    .filter(Boolean)
    .join(" | ");

export const buildMcpToolSectionLines = (
  server: McpServerDescriptor,
  tools: McpToolDescriptor[]
) => [
  formatMcpToolSectionHeader(server, tools.length),
  ...(server.transport === "filesystem" &&
  (!server.lsp || server.lsp.configuredCount === 0)
    ? [
        "tip: lsp_* tools will fail until lsp_servers are configured for this filesystem server",
      ]
    : []),
  ...(tools.length > 0 ? tools.map(formatMcpToolLine) : ["- (no tools registered)"]),
];

const formatMcpLspArgs = (args: string[]) =>
  args.length > 0 ? args.join(" ") : "(none)";

const formatMcpLspMatchHint = (entry: McpRuntimeLspServerDescriptor) =>
  [
    `workspace ${entry.workspaceRoot ?? "."} (path must stay inside)`,
    `patterns ${
      entry.filePatterns.length > 0
        ? `${entry.filePatterns.join(", ")} (any glob match)`
        : "(all files; no pattern filter)"
    }`,
    `roots ${
      entry.rootMarkers.length > 0
        ? `${entry.rootMarkers.join(", ")} (nearest marker wins)`
        : "(workspace root fallback)"
    }`,
  ].join(" | ");

export const formatMcpLspListLine = (entry: McpRuntimeLspServerDescriptor) =>
  [
    `- ${entry.id}`,
    `command ${entry.command}`,
    `args ${formatMcpLspArgs(entry.args)}`,
    `match_hint ${formatMcpLspMatchHint(entry)}`,
    entry.envKeys.length > 0 ? `env_keys ${entry.envKeys.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

export const formatMcpRuntimeSummary = (
  summary: McpRuntimeSummary | undefined,
  servers: McpServerDescriptor[],
  pending: PendingReviewItem[]
) => {
  const enabledCount = servers.filter(server => server.enabled).length;
  const trustedCount = servers.filter(server => server.trusted === true).length;
  const exposureCounts = servers.reduce(
    (acc, server) => {
      acc[server.exposure] = (acc[server.exposure] ?? 0) + 1;
      return acc;
    },
    { hidden: 0, hinted: 0, scoped: 0, full: 0 } as Record<
      McpServerDescriptor["exposure"],
      number
    >
  );
  const healthCounts = servers.reduce(
    (acc, server) => {
      acc[server.health] = (acc[server.health] ?? 0) + 1;
      return acc;
    },
    {} as Record<McpServerDescriptor["health"], number>
  );

  return [
    "MCP runtime",
    `primary: ${summary?.primaryServerId ?? servers[0]?.id ?? "(none)"}`,
    `servers: ${summary?.serverCount ?? servers.length} total | ${summary?.enabledServerCount ?? enabledCount} enabled`,
    `trust: ${trustedCount} trusted | ${servers.length - trustedCount} other`,
    `exposure: hidden ${exposureCounts.hidden} | hinted ${exposureCounts.hinted} | scoped ${exposureCounts.scoped} | full ${exposureCounts.full}`,
    `health: online ${healthCounts.online ?? 0} | unknown ${healthCounts.unknown ?? 0} | offline ${healthCounts.offline ?? 0} | error ${healthCounts.error ?? 0}`,
    `pending: ${pending.length}`,
    ...(summary?.configPaths.length
      ? ["config:", ...summary.configPaths.map(path => `- ${path}`)]
      : ["config: built-in default filesystem profile"]),
    ...(summary?.editableConfigPath
      ? [`editable: ${summary.editableConfigPath}`]
      : []),
    "commands: /mcp servers | /mcp server <id> | /mcp tools [server] | /mcp pending | /mcp add/remove/enable/disable/reload | /mcp lsp ...",
  ].join("\n");
};

export const formatSkillLine = (skill: SkillDefinition) =>
  [
    `- ${skill.id}`,
    `label ${skill.label}`,
    skill.enabled ? "enabled" : "disabled",
    `scope ${skill.source}`,
    formatExtensionExposure(skill.exposure),
    skill.configPath ? `config ${skill.configPath}` : "",
    skill.triggers.length > 0 ? `triggers ${skill.triggers.join(", ")}` : "",
    skill.tags.length > 0 ? `tags ${skill.tags.join(", ")}` : "",
    skill.description ? `desc ${skill.description}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

export const formatSkillDetail = (skill: SkillDefinition) =>
  [
    `Skill ${skill.id}`,
    `label: ${skill.label}`,
    `enabled: ${skill.enabled ? "yes" : "no"}`,
    `scope: ${skill.source}`,
    `exposure: ${skill.exposure}`,
    skill.configPath ? `config: ${skill.configPath}` : "",
    skill.triggers.length > 0
      ? `triggers: ${skill.triggers.join(", ")}`
      : "triggers: (none)",
    `tags: ${skill.tags.length > 0 ? skill.tags.join(", ") : "(none)"}`,
    skill.description ? `description: ${skill.description}` : "",
    "prompt:",
    skill.prompt.trim() || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");

export const formatSkillsRuntimeSummary = (
  summary: ReturnType<NonNullable<SkillsRuntime["describeRuntime"]>>
) =>
  [
    "Skills runtime",
    `skills: ${summary.skillCount} total | ${summary.enabledSkillCount} enabled`,
    ...(summary.configPaths.length > 0
      ? ["config:", ...summary.configPaths.map(path => `- ${path}`)]
      : ["config: built-in default"]),
    `editable: ${summary.editableConfigPath}`,
    "commands: /skills list | /skills create <task> | /skills show <id> | /skills enable <id> | /skills disable <id> | /skills remove <id> | /skills use <id> | /skills reload",
  ].join("\n");

export const formatManagedSkillLine = (skill: ManagedSkill) => formatSkillLine(skill);

export const formatManagedMcpServerLine = (server: ManagedMcpServer) =>
  formatMcpServerLine(server);

export const formatExtensionsRuntimeSummary = (
  summary: ExtensionManagerSummary,
  manager: ExtensionManager
) =>
  [
    "Extensions runtime",
    `skills: ${summary.skillCount} total | ${summary.enabledSkillCount} enabled`,
    `mcp: ${summary.mcpServerCount} total | ${summary.enabledMcpServerCount} enabled`,
    `exposure: hidden ${summary.exposureCounts.hidden} | hinted ${summary.exposureCounts.hinted} | scoped ${summary.exposureCounts.scoped} | full ${summary.exposureCounts.full}`,
    `selected-by-default: ${
      manager
        .resolveForQuery("")
        .mcpServers.map(entry => entry.item.id)
        .join(", ") || "(none)"
    }`,
    "commands: /extensions list | /extensions skills | /extensions mcp | /extensions show <id> | /extensions resolve <query> | /extensions enable/disable <id> | /extensions exposure <mode> <id>",
  ].join("\n");

const formatResolvedEntryPrefix = <T extends { id: string }>(
  entry: ResolvedExtension<T>
) => `- ${entry.item.id} | reason ${formatSelectionReason(entry.reason)} | score ${entry.score}`;

export const formatExtensionsResolution = (resolution: ExtensionQueryResolution) =>
  [
    "Resolved extensions",
    "skills:",
    ...(resolution.skills.length > 0
      ? resolution.skills.map(
          entry =>
            `${formatResolvedEntryPrefix(entry)} | exposure ${entry.item.exposure} | scope ${entry.item.source}`
        )
      : ["- (none)"]),
    "mcp:",
    ...(resolution.mcpServers.length > 0
      ? resolution.mcpServers.map(
          entry =>
            `${formatResolvedEntryPrefix(entry)} | exposure ${entry.item.exposure} | scope ${entry.item.scope ?? "default"} | trust ${
              entry.item.trusted === undefined ? "n/a" : entry.item.trusted ? "trusted" : "untrusted"
            }`
        )
      : ["- (none)"]),
  ].join("\n");

export const formatManagedSkillDetail = (skill: ManagedSkill) => formatSkillDetail(skill);

export const formatManagedMcpServerDetail = (server: ManagedMcpServer) =>
  [
    `MCP server ${server.id}`,
    `label: ${server.label}`,
    `transport: ${server.transport ?? "unknown"}`,
    `scope: ${server.scope ?? "default"}`,
    `trust: ${
      server.trusted === undefined ? "n/a" : server.trusted ? "trusted" : "untrusted"
    }`,
    `exposure: ${server.exposure}`,
    `source: ${server.source}`,
    `health: ${server.health}`,
    `enabled: ${server.enabled ? "true" : "false"}`,
    `aliases: ${formatMcpAliases(server.aliases)}`,
    `tags: ${formatExtensionTags(server.tags)}`,
    server.hint ? `hint: ${server.hint}` : "",
    `lsp: ${
      server.transport === "filesystem"
        ? server.lsp && server.lsp.configuredCount > 0
          ? `${server.lsp.configuredCount} configured | ${server.lsp.serverIds.join(", ")}`
          : "none configured"
        : "n/a"
    }`,
    `tools: ${server.tools.length}`,
  ]
    .filter(Boolean)
    .join("\n");

export const formatSelectedExtensionsPrompt = (
  resolution: ExtensionQueryResolution
) => {
  const skillLines = resolution.skills.map(entry =>
    [
      `- skill ${entry.item.id}`,
      `reason ${formatSelectionReason(entry.reason)}`,
      `scope ${entry.item.source}`,
      `exposure ${entry.item.exposure}`,
      entry.item.description ? `desc ${entry.item.description}` : "",
      entry.item.tags.length > 0 ? `tags ${entry.item.tags.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ")
  );
  const mcpLines = resolution.mcpServers.map(entry =>
    [
      `- mcp ${entry.item.id}`,
      `reason ${formatSelectionReason(entry.reason)}`,
      `transport ${entry.item.transport ?? "unknown"}`,
      `scope ${entry.item.scope ?? "default"}`,
      `trust ${
        entry.item.trusted === undefined
          ? "n/a"
          : entry.item.trusted
            ? "trusted"
            : "untrusted"
      }`,
      `exposure ${entry.item.exposure}`,
      entry.item.hint ? `hint ${entry.item.hint}` : "",
      entry.item.tags.length > 0 ? `tags ${entry.item.tags.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ")
  );
  return [
    "SELECTED EXTENSIONS (request-scoped summary):",
    "Only use the extension hints listed here for this request. Do not assume any other extension context exists.",
    "skills:",
    ...(skillLines.length > 0 ? skillLines : ["- (none)"]),
    "mcp:",
    ...(mcpLines.length > 0 ? mcpLines : ["- (none)"]),
  ].join("\n");
};
