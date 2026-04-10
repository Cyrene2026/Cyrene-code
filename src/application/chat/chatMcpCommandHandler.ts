import type { McpRuntime, McpServerDescriptor, MpcAction } from "../../core/mcp";
import type { ChatItem } from "../../shared/types/chat";
import {
  MCP_LSP_ADD_USAGE,
  MCP_LSP_BOOTSTRAP_USAGE,
  MCP_LSP_DOCTOR_USAGE,
  MCP_LSP_LIST_USAGE,
  MCP_LSP_REMOVE_USAGE,
  parseMcpAddCommand,
  parseMcpLspCommand,
} from "./chatMcpCommandParsers";
import {
  buildMcpToolSectionLines,
  formatMcpAliases,
  formatMcpLspListHeader,
  formatMcpLspListLine,
  formatMcpLspServerHeader,
  formatMcpPendingLine,
  formatMcpRuntimeSummary,
  formatMcpServerLine,
  formatMcpToolLine,
} from "./chatMcpSkillsFormatting";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;

type HandleMcpCommandParams = {
  query: string;
  mcpService: McpRuntime;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
  getApprovalRisk: (action: MpcAction) => string;
};

const INFO_MESSAGE_OPTIONS = {
  kind: "system_hint",
  tone: "info",
  color: "cyan",
} satisfies SystemMessageOptions;

const ERROR_MESSAGE_OPTIONS = {
  kind: "error",
  tone: "danger",
  color: "red",
} satisfies SystemMessageOptions;

const NEUTRAL_MESSAGE_OPTIONS = {
  kind: "system_hint",
  tone: "neutral",
  color: "white",
} satisfies SystemMessageOptions;

const resolveMcpServerDescriptor = (
  servers: McpServerDescriptor[],
  idOrAlias: string
) => {
  const normalized = idOrAlias.trim().toLowerCase();
  return servers.find(
    server =>
      server.id.toLowerCase() === normalized ||
      (server.aliases ?? []).some(alias => alias.toLowerCase() === normalized)
  );
};

const resolveFilesystemMcpServerDescriptor = (
  servers: McpServerDescriptor[],
  idOrAlias: string
) => {
  const filesystemServers = servers.filter(server => server.transport === "filesystem");
  const server = resolveMcpServerDescriptor(servers, idOrAlias);
  if (!server) {
    return {
      ok: false as const,
      message: [
        `MCP filesystem server not found: ${idOrAlias}`,
        `available: ${
          filesystemServers.length > 0
            ? filesystemServers
                .map(entry => {
                  const aliases = formatMcpAliases(entry.aliases);
                  return aliases !== "(none)"
                    ? `${entry.id} (aliases: ${aliases})`
                    : entry.id;
                })
                .join(", ")
            : "(none)"
        }`,
        "hint: use /mcp servers or /mcp lsp list to inspect configured filesystem servers",
      ].join("\n"),
    };
  }
  if (server.transport !== "filesystem") {
    return {
      ok: false as const,
      message: [
        `MCP server is not a filesystem server: ${server.id}`,
        `transport: ${server.transport ?? "unknown"}`,
        "hint: /mcp lsp ... only works with filesystem MCP servers",
      ].join("\n"),
    };
  }
  return {
    ok: true as const,
    server,
  };
};

const pushMutationResult = (
  pushSystemMessage: HandleMcpCommandParams["pushSystemMessage"],
  result: { ok: boolean; message: string }
) => {
  pushSystemMessage(
    result.message,
    result.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
  );
};

export const handleMcpCommand = async ({
  query,
  mcpService,
  pushSystemMessage,
  clearInput,
  getApprovalRisk,
}: HandleMcpCommandParams) => {
  if (query === "/mcp") {
    const servers = mcpService.listServers();
    const pending = mcpService.listPending();
    pushSystemMessage(
      formatMcpRuntimeSummary(mcpService.describeRuntime?.(), servers, pending),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/mcp servers") {
    const servers = mcpService.listServers();
    pushSystemMessage(
      servers.length > 0
        ? ["MCP servers", ...servers.map(formatMcpServerLine)].join("\n")
        : "No MCP servers registered.",
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/mcp tools") {
    const servers = mcpService.listServers();
    const lines = servers.flatMap(server => {
      const tools = mcpService.listTools(server.id);
      return buildMcpToolSectionLines(server, tools);
    });

    pushSystemMessage(
      lines.length > 0
        ? ["MCP tools", ...lines].join("\n")
        : "No MCP tools registered.",
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/mcp lsp") {
    pushSystemMessage(
      [
        "MCP LSP commands",
        MCP_LSP_LIST_USAGE,
        MCP_LSP_ADD_USAGE,
        MCP_LSP_REMOVE_USAGE,
        MCP_LSP_DOCTOR_USAGE,
      ].join("\n"),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/mcp pending") {
    const pending = mcpService.listPending();
    pushSystemMessage(
      pending.length > 0
        ? [
            "MCP pending operations",
            ...pending.map(item =>
              formatMcpPendingLine(item, getApprovalRisk(item.request.action))
            ),
          ].join("\n")
        : "No pending MCP operations.",
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/mcp reload") {
    if (!mcpService.reloadConfig) {
      pushSystemMessage(
        "MCP runtime reload is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    const result = await mcpService.reloadConfig();
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp add ")) {
    if (!mcpService.addServer) {
      pushSystemMessage(
        "MCP server management is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    const parsed = parseMcpAddCommand(query);
    if (!parsed.ok) {
      pushSystemMessage(parsed.message, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await mcpService.addServer(parsed.input);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp lsp ")) {
    const parsed = parseMcpLspCommand(query);
    if (!parsed.ok) {
      pushSystemMessage(parsed.message, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const servers = mcpService.listServers();
    const resolveTarget = (serverRef: string) => {
      const resolved = resolveFilesystemMcpServerDescriptor(servers, serverRef);
      if (!resolved.ok) {
        pushSystemMessage(resolved.message, ERROR_MESSAGE_OPTIONS);
        clearInput();
        return null;
      }
      return resolved.server;
    };

    if (parsed.action === "list") {
      if (!mcpService.listLspServers) {
        pushSystemMessage(
          "MCP LSP listing is unavailable in this build.",
          ERROR_MESSAGE_OPTIONS
        );
        clearInput();
        return true;
      }

      const targetServer = parsed.filesystemServerId
        ? resolveTarget(parsed.filesystemServerId)
        : null;
      if (parsed.filesystemServerId && !targetServer) {
        return true;
      }

      const filesystemServers = parsed.filesystemServerId
        ? [targetServer!]
        : servers.filter(server => server.transport === "filesystem");
      const lspEntries = [...mcpService.listLspServers(targetServer?.id)].sort((left, right) =>
        left.filesystemServerId === right.filesystemServerId
          ? left.id.localeCompare(right.id)
          : left.filesystemServerId.localeCompare(right.filesystemServerId)
      );
      if (filesystemServers.length === 0) {
        pushSystemMessage(
          "No filesystem MCP servers registered.",
          NEUTRAL_MESSAGE_OPTIONS
        );
        clearInput();
        return true;
      }

      const lines = filesystemServers.flatMap(server => {
        const entries = lspEntries.filter(
          entry => entry.filesystemServerId === server.id
        );
        return [
          formatMcpLspServerHeader(
            server,
            entries[0]?.filesystemWorkspaceRoot ?? "(unknown)",
            entries.length
          ),
          ...(entries.length > 0
            ? entries.map(formatMcpLspListLine)
            : ["- (no configured lsp_servers)"]),
          `tip: /mcp lsp doctor ${server.id} <path>${
            entries.length === 1 ? ` --lsp ${entries[0]?.id}` : ""
          }`,
        ];
      });

      pushSystemMessage(
        [
          formatMcpLspListHeader({
            scopeLabel: parsed.filesystemServerId
              ? `${parsed.filesystemServerId} -> ${targetServer!.id}`
              : "all filesystem servers",
            filesystemServerCount: filesystemServers.length,
            configuredLspCount: lspEntries.length,
          }),
          ...lines,
        ].join("\n"),
        INFO_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    if (parsed.action === "add") {
      if (!mcpService.addLspServer) {
        pushSystemMessage(
          "MCP LSP management is unavailable in this build.",
          ERROR_MESSAGE_OPTIONS
        );
        clearInput();
        return true;
      }
      const targetServer = resolveTarget(parsed.filesystemServerId);
      if (!targetServer) {
        return true;
      }
      const result = await mcpService.addLspServer(targetServer.id, parsed.input);
      pushMutationResult(pushSystemMessage, result);
      clearInput();
      return true;
    }

    if (parsed.action === "bootstrap") {
      if (!mcpService.bootstrapLsp) {
        pushSystemMessage(
          "MCP LSP bootstrap is unavailable in this build.",
          ERROR_MESSAGE_OPTIONS
        );
        clearInput();
        return true;
      }
      const targetServer = resolveTarget(parsed.filesystemServerId);
      if (!targetServer) {
        return true;
      }
      const result = await mcpService.bootstrapLsp(targetServer.id);
      pushMutationResult(pushSystemMessage, result);
      clearInput();
      return true;
    }

    if (parsed.action === "remove") {
      if (!mcpService.removeLspServer) {
        pushSystemMessage(
          "MCP LSP management is unavailable in this build.",
          ERROR_MESSAGE_OPTIONS
        );
        clearInput();
        return true;
      }
      const targetServer = resolveTarget(parsed.filesystemServerId);
      if (!targetServer) {
        return true;
      }
      const result = await mcpService.removeLspServer(
        targetServer.id,
        parsed.lspServerId
      );
      pushMutationResult(pushSystemMessage, result);
      clearInput();
      return true;
    }

    if (!mcpService.doctorLsp) {
      pushSystemMessage(
        "MCP LSP doctor is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    const targetServer = resolveTarget(parsed.filesystemServerId);
    if (!targetServer) {
      return true;
    }
    const result = await mcpService.doctorLsp(targetServer.id, parsed.path, {
      lspServerId: parsed.lspServerId,
    });
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp remove ")) {
    if (!mcpService.removeServer) {
      pushSystemMessage(
        "MCP server management is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    const serverId = query.slice("/mcp remove ".length).trim();
    if (!serverId) {
      pushSystemMessage("Usage: /mcp remove <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await mcpService.removeServer(serverId);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp enable ")) {
    if (!mcpService.setServerEnabled) {
      pushSystemMessage(
        "MCP server management is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    const serverId = query.slice("/mcp enable ".length).trim();
    if (!serverId) {
      pushSystemMessage("Usage: /mcp enable <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await mcpService.setServerEnabled(serverId, true);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp disable ")) {
    if (!mcpService.setServerEnabled) {
      pushSystemMessage(
        "MCP server management is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    const serverId = query.slice("/mcp disable ".length).trim();
    if (!serverId) {
      pushSystemMessage("Usage: /mcp disable <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await mcpService.setServerEnabled(serverId, false);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp server ")) {
    const serverId = query.slice("/mcp server ".length).trim();
    if (!serverId) {
      pushSystemMessage("Usage: /mcp server <id>");
      clearInput();
      return true;
    }

    const servers = mcpService.listServers();
    const server = resolveMcpServerDescriptor(servers, serverId);
    if (!server) {
      pushSystemMessage(`MCP server not found: ${serverId}`, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const tools = mcpService.listTools(server.id);
    pushSystemMessage(
      [
        `MCP server ${server.id}`,
        `label: ${server.label}`,
        `transport: ${server.transport ?? "unknown"}`,
        `source: ${server.source}`,
        `health: ${server.health}`,
        `enabled: ${server.enabled ? "true" : "false"}`,
        `aliases: ${formatMcpAliases(server.aliases)}`,
        `lsp: ${
          server.transport === "filesystem"
            ? server.lsp && server.lsp.configuredCount > 0
              ? `${server.lsp.configuredCount} configured | ${server.lsp.serverIds.join(", ")}`
              : "none configured"
            : "n/a"
        }`,
        `tools: ${tools.length}`,
      ].join("\n"),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/mcp tools ")) {
    const serverId = query.slice("/mcp tools ".length).trim();
    if (!serverId) {
      pushSystemMessage("Usage: /mcp tools <server>");
      clearInput();
      return true;
    }

    const servers = mcpService.listServers();
    const server = resolveMcpServerDescriptor(servers, serverId);
    if (!server) {
      pushSystemMessage(`MCP server not found: ${serverId}`, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const tools = mcpService.listTools(server.id);
    pushSystemMessage(
      [
        `MCP tools for ${server.id}`,
        ...(server.transport === "filesystem"
          ? [
              `lsp: ${
                server.lsp && server.lsp.configuredCount > 0
                  ? `${server.lsp.configuredCount} configured | ${server.lsp.serverIds.join(", ")}`
                  : "none configured"
              }`,
              ...(!server.lsp || server.lsp.configuredCount === 0
                ? [
                    "tip: lsp_* tools will fail until lsp_servers are configured for this filesystem server",
                  ]
                : []),
            ]
          : []),
        ...(tools.length > 0
          ? tools.map(formatMcpToolLine)
          : ["- (no tools registered)"]),
      ].join("\n"),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  return false;
};
