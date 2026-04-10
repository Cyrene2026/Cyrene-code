import type {
  McpRuntimeLspServerInput,
  McpRuntimeServerInput,
} from "../../core/mcp";
import {
  createLspInputFromPreset,
  formatLspPresetCatalog,
  resolveLspPreset,
} from "../../core/mcp";

const tokenizeInlineCommand = (raw: string) =>
  [...raw.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)].map(
    match => match[1] ?? match[2] ?? match[0] ?? ""
  );

export type ParsedMcpAddCommand =
  | {
      ok: true;
      input: McpRuntimeServerInput;
    }
  | {
      ok: false;
      message: string;
    };

export const parseMcpAddCommand = (query: string): ParsedMcpAddCommand => {
  const raw = query.slice("/mcp add ".length).trim();
  const tokens = tokenizeInlineCommand(raw);
  const transport = (tokens[0] ?? "").toLowerCase();

  if (transport === "stdio") {
    const id = tokens[1]?.trim();
    const command = tokens[2]?.trim();
    if (!id || !command) {
      return {
        ok: false,
        message: "Usage: /mcp add stdio <id> <command...>",
      };
    }
    return {
      ok: true,
      input: {
        id,
        transport: "stdio",
        command,
        args: tokens.slice(3),
      },
    };
  }

  if (transport === "http") {
    const id = tokens[1]?.trim();
    const url = tokens[2]?.trim();
    if (!id || !url) {
      return {
        ok: false,
        message: "Usage: /mcp add http <id> <url>",
      };
    }
    return {
      ok: true,
      input: {
        id,
        transport: "http",
        url,
      },
    };
  }

  if (transport === "filesystem") {
    const id = tokens[1]?.trim();
    if (!id) {
      return {
        ok: false,
        message: "Usage: /mcp add filesystem <id> [workspace]",
      };
    }
    return {
      ok: true,
      input: {
        id,
        transport: "filesystem",
        workspaceRoot: tokens[2]?.trim() || ".",
      },
    };
  }

  return {
    ok: false,
    message:
      "Usage: /mcp add stdio <id> <command...> | /mcp add http <id> <url> | /mcp add filesystem <id> [workspace]",
  };
};

export type ParsedMcpLspCommand =
  | {
      ok: true;
      action: "list";
      filesystemServerId?: string;
    }
  | {
      ok: true;
      action: "add";
      filesystemServerId: string;
      input: McpRuntimeLspServerInput;
    }
  | {
      ok: true;
      action: "remove";
      filesystemServerId: string;
      lspServerId: string;
    }
  | {
      ok: true;
      action: "doctor";
      filesystemServerId: string;
      path: string;
      lspServerId?: string;
    }
  | {
      ok: true;
      action: "bootstrap";
      filesystemServerId: string;
    }
  | {
      ok: false;
      message: string;
    };

export const MCP_LSP_LIST_USAGE = "Usage: /mcp lsp list [filesystem-server]";
export const MCP_LSP_ADD_USAGE =
  [
    "Usage: /mcp lsp add <filesystem-server> <preset> [lsp-id]",
    "   or: /mcp lsp add <filesystem-server> <lsp-id> --command <cmd> [--arg <arg>]... --pattern <glob> [--pattern <glob>]... [--root <marker>]... [--workspace <path>] [--env KEY=VALUE]...",
    `presets: ${formatLspPresetCatalog()}`,
  ].join("\n");
export const MCP_LSP_REMOVE_USAGE =
  "Usage: /mcp lsp remove <filesystem-server> <lsp-id>";
export const MCP_LSP_DOCTOR_USAGE =
  "Usage: /mcp lsp doctor <filesystem-server> <path> [--lsp <lsp-id>]";
export const MCP_LSP_BOOTSTRAP_USAGE =
  "Usage: /mcp lsp bootstrap <filesystem-server>";

export const parseMcpLspCommand = (query: string): ParsedMcpLspCommand => {
  const raw = query.slice("/mcp lsp ".length).trim();
  const tokens = tokenizeInlineCommand(raw);
  const action = (tokens[0] ?? "").toLowerCase();

  if (action === "list") {
    if (tokens.length > 2) {
      return { ok: false, message: MCP_LSP_LIST_USAGE };
    }
    return {
      ok: true,
      action: "list",
      filesystemServerId: tokens[1]?.trim() || undefined,
    };
  }

  if (action === "remove") {
    const filesystemServerId = tokens[1]?.trim();
    const lspServerId = tokens[2]?.trim();
    if (!filesystemServerId || !lspServerId || tokens.length !== 3) {
      return { ok: false, message: MCP_LSP_REMOVE_USAGE };
    }
    return {
      ok: true,
      action: "remove",
      filesystemServerId,
      lspServerId,
    };
  }

  if (action === "doctor") {
    const filesystemServerId = tokens[1]?.trim();
    const path = tokens[2]?.trim();
    if (!filesystemServerId || !path) {
      return { ok: false, message: MCP_LSP_DOCTOR_USAGE };
    }
    let lspServerId: string | undefined;
    for (let index = 3; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      if (token !== "--lsp") {
        return { ok: false, message: MCP_LSP_DOCTOR_USAGE };
      }
      const value = tokens[index + 1]?.trim();
      if (!value) {
        return { ok: false, message: MCP_LSP_DOCTOR_USAGE };
      }
      lspServerId = value;
      index += 1;
    }
    return {
      ok: true,
      action: "doctor",
      filesystemServerId,
      path,
      lspServerId,
    };
  }

  if (action === "bootstrap") {
    const filesystemServerId = tokens[1]?.trim();
    if (!filesystemServerId || tokens.length !== 2) {
      return { ok: false, message: MCP_LSP_BOOTSTRAP_USAGE };
    }
    return {
      ok: true,
      action: "bootstrap",
      filesystemServerId,
    };
  }

  if (action === "add") {
    const filesystemServerId = tokens[1]?.trim();
    const lspServerId = tokens[2]?.trim();
    if (!filesystemServerId || !lspServerId) {
      return { ok: false, message: MCP_LSP_ADD_USAGE };
    }

    const firstOptionIndex = tokens.findIndex((token, index) => index >= 3 && token.startsWith("--"));
    if (firstOptionIndex === -1) {
      const preset = resolveLspPreset(lspServerId);
      if (!preset || tokens.length > 4) {
        return { ok: false, message: MCP_LSP_ADD_USAGE };
      }
      return {
        ok: true,
        action: "add",
        filesystemServerId,
        input: createLspInputFromPreset(preset, tokens[3]?.trim()),
      };
    }

    let command = "";
    const args: string[] = [];
    const filePatterns: string[] = [];
    const rootMarkers: string[] = [];
    let workspaceRoot: string | undefined;
    const env: Record<string, string> = {};

    for (let index = 3; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      const value = tokens[index + 1]?.trim();
      if (
        token !== "--command" &&
        token !== "--arg" &&
        token !== "--pattern" &&
        token !== "--root" &&
        token !== "--workspace" &&
        token !== "--env"
      ) {
        return { ok: false, message: MCP_LSP_ADD_USAGE };
      }
      if (!value) {
        return { ok: false, message: MCP_LSP_ADD_USAGE };
      }

      switch (token) {
        case "--command":
          command = value;
          break;
        case "--arg":
          args.push(value);
          break;
        case "--pattern":
          filePatterns.push(value);
          break;
        case "--root":
          rootMarkers.push(value);
          break;
        case "--workspace":
          workspaceRoot = value;
          break;
        case "--env": {
          const separator = value.indexOf("=");
          if (separator <= 0 || separator === value.length - 1) {
            return {
              ok: false,
              message: `${MCP_LSP_ADD_USAGE}\ninvalid --env: expected KEY=VALUE`,
            };
          }
          env[value.slice(0, separator)] = value.slice(separator + 1);
          break;
        }
      }

      index += 1;
    }

    if (!command || filePatterns.length === 0) {
      return { ok: false, message: MCP_LSP_ADD_USAGE };
    }

    return {
      ok: true,
      action: "add",
      filesystemServerId,
      input: {
        id: lspServerId,
        command,
        args,
        filePatterns,
        rootMarkers,
        workspaceRoot,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    };
  }

  return {
    ok: false,
    message: [
      MCP_LSP_LIST_USAGE,
      MCP_LSP_ADD_USAGE,
      MCP_LSP_REMOVE_USAGE,
      MCP_LSP_DOCTOR_USAGE,
      MCP_LSP_BOOTSTRAP_USAGE,
    ].join("\n"),
  };
};
