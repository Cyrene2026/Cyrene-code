import {
  EXTENSION_EXPOSURE_MODES,
  type ExtensionExposureMode,
} from "../../core/extensions";
import type { ExtensionManager } from "../../core/extensions";
import type { McpRuntime } from "../../core/mcp";
import type { SkillsRuntime } from "../../core/skills";
import type { ChatItem } from "../../shared/types/chat";
import {
  formatExtensionsResolution,
  formatExtensionsRuntimeSummary,
  formatManagedMcpServerDetail,
  formatManagedMcpServerLine,
  formatManagedSkillDetail,
  formatManagedSkillLine,
} from "./chatMcpSkillsFormatting";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;

type HandleExtensionsCommandParams = {
  query: string;
  extensionManager?: ExtensionManager;
  skillsService?: SkillsRuntime;
  mcpService?: McpRuntime;
  activeSessionId: string | null;
  getSessionSkillUseIds: (sessionId: string | null) => string[];
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
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

const resolveShowTarget = (extensionManager: ExtensionManager, id: string) => {
  const normalized = id.trim().toLowerCase();
  const [prefix, rawValue] = normalized.includes(":")
    ? normalized.split(":", 2)
    : [null, normalized];

  const skills = extensionManager.listSkills();
  const mcpServers = extensionManager.listMcpServers();

  if (prefix === "skill") {
    return {
      skill: skills.find(skill => skill.id.toLowerCase() === rawValue) ?? null,
      mcpServer: null,
    };
  }
  if (prefix === "mcp") {
    return {
      skill: null,
      mcpServer:
        mcpServers.find(server => server.id.toLowerCase() === rawValue) ?? null,
    };
  }

  const skill = skills.find(item => item.id.toLowerCase() === normalized) ?? null;
  const mcpServer =
    mcpServers.find(item => item.id.toLowerCase() === normalized) ?? null;
  return { skill, mcpServer };
};

const resolveMutationTarget = (extensionManager: ExtensionManager, id: string) => {
  const resolved = resolveShowTarget(extensionManager, id);
  if (resolved.skill && resolved.mcpServer) {
    return {
      ok: false as const,
      message: [
        `Ambiguous extension id: ${id}`,
        "Use one of:",
        `- skill:${resolved.skill.id}`,
        `- mcp:${resolved.mcpServer.id}`,
      ].join("\n"),
    };
  }
  if (resolved.skill) {
    return {
      ok: true as const,
      kind: "skill" as const,
      id: resolved.skill.id,
    };
  }
  if (resolved.mcpServer) {
    return {
      ok: true as const,
      kind: "mcp" as const,
      id: resolved.mcpServer.id,
    };
  }
  return {
    ok: false as const,
    message: `Extension not found: ${id}`,
  };
};

const normalizeExposureArgument = (
  value: string
): ExtensionExposureMode | null =>
  EXTENSION_EXPOSURE_MODES.includes(value as ExtensionExposureMode)
    ? (value as ExtensionExposureMode)
    : null;

export const handleExtensionsCommand = async ({
  query,
  extensionManager,
  skillsService,
  mcpService,
  activeSessionId,
  getSessionSkillUseIds,
  pushSystemMessage,
  clearInput,
}: HandleExtensionsCommandParams) => {
  if (!query.startsWith("/extensions")) {
    return false;
  }

  if (!extensionManager) {
    pushSystemMessage(
      "Extensions runtime is unavailable in this build.",
      ERROR_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/extensions") {
    pushSystemMessage(
      formatExtensionsRuntimeSummary(
        extensionManager.describeRuntime(),
        extensionManager
      ),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/extensions list") {
    pushSystemMessage(
      [
        "Extensions",
        "skills:",
        ...extensionManager.listSkills().map(formatManagedSkillLine),
        "mcp:",
        ...extensionManager.listMcpServers().map(formatManagedMcpServerLine),
      ].join("\n"),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/extensions skills") {
    const skills = extensionManager.listSkills();
    pushSystemMessage(
      skills.length > 0
        ? ["Managed skills", ...skills.map(formatManagedSkillLine)].join("\n")
        : "No managed skills.",
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/extensions mcp") {
    const servers = extensionManager.listMcpServers();
    pushSystemMessage(
      servers.length > 0
        ? ["Managed MCP servers", ...servers.map(formatManagedMcpServerLine)].join("\n")
        : "No managed MCP servers.",
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/extensions show ")) {
    const target = query.slice("/extensions show ".length).trim();
    if (!target) {
      pushSystemMessage(
        "Usage: /extensions show <id|skill:<id>|mcp:<id>>",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const resolved = resolveShowTarget(extensionManager, target);
    if (resolved.skill && resolved.mcpServer) {
      pushSystemMessage(
        [
          `Ambiguous extension id: ${target}`,
          "Use one of:",
          `- skill:${resolved.skill.id}`,
          `- mcp:${resolved.mcpServer.id}`,
        ].join("\n"),
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    if (resolved.skill) {
      pushSystemMessage(formatManagedSkillDetail(resolved.skill), INFO_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    if (resolved.mcpServer) {
      pushSystemMessage(
        formatManagedMcpServerDetail(resolved.mcpServer),
        INFO_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    pushSystemMessage(`Extension not found: ${target}`, ERROR_MESSAGE_OPTIONS);
    clearInput();
    return true;
  }

  if (query.startsWith("/extensions resolve ")) {
    const request = query.slice("/extensions resolve ".length).trim();
    if (!request) {
      pushSystemMessage(
        "Usage: /extensions resolve <query>",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const resolution = extensionManager.resolveForQuery(request, {
      manualSkillIds: getSessionSkillUseIds(activeSessionId),
    });
    pushSystemMessage(
      formatExtensionsResolution(resolution),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/extensions enable ")) {
    const target = query.slice("/extensions enable ".length).trim();
    if (!target) {
      pushSystemMessage(
        "Usage: /extensions enable <id|skill:<id>|mcp:<id>>",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const resolved = resolveMutationTarget(extensionManager, target);
    if (!resolved.ok) {
      pushSystemMessage(resolved.message, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const result =
      resolved.kind === "skill"
        ? await skillsService?.setSkillEnabled?.(resolved.id, true)
        : await mcpService?.setServerEnabled?.(resolved.id, true);
    pushSystemMessage(
      result?.message ??
        "Extensions mutation is unavailable in this build.",
      result?.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/extensions disable ")) {
    const target = query.slice("/extensions disable ".length).trim();
    if (!target) {
      pushSystemMessage(
        "Usage: /extensions disable <id|skill:<id>|mcp:<id>>",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const resolved = resolveMutationTarget(extensionManager, target);
    if (!resolved.ok) {
      pushSystemMessage(resolved.message, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const result =
      resolved.kind === "skill"
        ? await skillsService?.setSkillEnabled?.(resolved.id, false)
        : await mcpService?.setServerEnabled?.(resolved.id, false);
    pushSystemMessage(
      result?.message ??
        "Extensions mutation is unavailable in this build.",
      result?.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/extensions exposure ")) {
    const rest = query.slice("/extensions exposure ".length).trim();
    const [rawExposure, ...targetParts] = rest.split(/\s+/);
    const exposure = normalizeExposureArgument((rawExposure ?? "").trim().toLowerCase());
    const target = targetParts.join(" ").trim();
    if (!exposure || !target) {
      pushSystemMessage(
        "Usage: /extensions exposure <hidden|hinted|scoped|full> <id|skill:<id>|mcp:<id>>",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const resolved = resolveMutationTarget(extensionManager, target);
    if (!resolved.ok) {
      pushSystemMessage(resolved.message, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const result =
      resolved.kind === "skill"
        ? await skillsService?.setSkillExposure?.(resolved.id, exposure)
        : await mcpService?.setServerExposure?.(resolved.id, exposure);
    pushSystemMessage(
      result?.message ??
        "Extensions exposure mutation is unavailable in this build.",
      result?.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  pushSystemMessage(
    [
      "Extensions commands",
      "/extensions",
      "/extensions list",
      "/extensions skills",
      "/extensions mcp",
      "/extensions show <id|skill:<id>|mcp:<id>>",
      "/extensions resolve <query>",
      "/extensions enable <id|skill:<id>|mcp:<id>>",
      "/extensions disable <id|skill:<id>|mcp:<id>>",
      "/extensions exposure <hidden|hinted|scoped|full> <id|skill:<id>|mcp:<id>>",
    ].join("\n"),
    INFO_MESSAGE_OPTIONS
  );
  clearInput();
  return true;
};
