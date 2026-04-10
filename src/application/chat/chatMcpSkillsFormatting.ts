import type {
  McpRuntimeLspServerDescriptor,
  McpRuntimeSummary,
  McpServerDescriptor,
  McpToolDescriptor,
  PendingReviewItem,
} from "../../core/mcp";
import { formatLspPresetCatalog } from "../../core/mcp";
import type { SkillDefinition, SkillsRuntime } from "../../core/skills";

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
    `health ${server.health}`,
    server.enabled ? "enabled" : "disabled",
    `tools ${server.tools.length}`,
    formatMcpLspSummary(server),
    `aliases ${formatMcpAliases(server.aliases)}`,
  ]
    .filter(Boolean)
    .join(" | ");

export const formatMcpToolLine = (tool: McpToolDescriptor) =>
  [
    `- ${tool.name}`,
    `caps ${formatMcpCapabilities(tool)}`,
    `risk ${tool.risk}`,
    tool.requiresReview ? "review yes" : "review no",
    tool.enabled ? "enabled" : "disabled",
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
    `source ${skill.source}`,
    skill.configPath ? `config ${skill.configPath}` : "",
    skill.triggers.length > 0 ? `triggers ${skill.triggers.join(", ")}` : "",
    skill.description ? `desc ${skill.description}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

export const formatSkillDetail = (skill: SkillDefinition) =>
  [
    `Skill ${skill.id}`,
    `label: ${skill.label}`,
    `enabled: ${skill.enabled ? "yes" : "no"}`,
    `source: ${skill.source}`,
    skill.configPath ? `config: ${skill.configPath}` : "",
    skill.triggers.length > 0
      ? `triggers: ${skill.triggers.join(", ")}`
      : "triggers: (none)",
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
    "commands: /skills list | /skills show <id> | /skills enable <id> | /skills disable <id> | /skills remove <id> | /skills use <id> | /skills reload",
  ].join("\n");

export const formatActiveSkillsPrompt = (skills: SkillDefinition[]) =>
  skills
    .map(skill => {
      const lines = [
        `[${skill.id}] ${skill.label}`,
        skill.description ? `description: ${skill.description}` : "",
        skill.prompt.trim(),
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
