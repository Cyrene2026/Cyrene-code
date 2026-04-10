import { describe, expect, test } from "bun:test";
import {
  parseMcpAddCommand,
  parseMcpLspCommand,
} from "../src/application/chat/chatMcpCommandParsers";

describe("chatMcpCommandParsers", () => {
  test("parses /mcp add commands for stdio and filesystem transports", () => {
    expect(parseMcpAddCommand('/mcp add stdio tsserver "node" server.js')).toEqual({
      ok: true,
      input: {
        id: "tsserver",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      },
    });

    expect(parseMcpAddCommand("/mcp add filesystem repo ./workspace")).toEqual({
      ok: true,
      input: {
        id: "repo",
        transport: "filesystem",
        workspaceRoot: "./workspace",
      },
    });
  });

  test("parses /mcp lsp add command with patterns roots workspace and env", () => {
    expect(
      parseMcpLspCommand(
        "/mcp lsp add repo ts --command typescript-language-server --arg --stdio --pattern '**/*.ts' --root package.json --workspace ./app --env NODE_ENV=dev"
      )
    ).toEqual({
      ok: true,
      action: "add",
      filesystemServerId: "repo",
      input: {
        id: "ts",
        command: "typescript-language-server",
        args: ["--stdio"],
        filePatterns: ["**/*.ts"],
        rootMarkers: ["package.json"],
        workspaceRoot: "./app",
        env: {
          NODE_ENV: "dev",
        },
      },
    });
  });

  test("parses /mcp lsp add preset shorthand for mainstream languages", () => {
    expect(parseMcpLspCommand("/mcp lsp add repo typescript")).toEqual({
      ok: true,
      action: "add",
      filesystemServerId: "repo",
      input: {
        id: "typescript",
        command: "typescript-language-server",
        args: ["--stdio"],
        filePatterns: [
          "**/*.ts",
          "**/*.tsx",
          "**/*.js",
          "**/*.jsx",
          "**/*.mts",
          "**/*.cts",
          "**/*.mjs",
          "**/*.cjs",
        ],
        rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
      },
    });

    expect(parseMcpLspCommand("/mcp lsp add repo python pyright")).toEqual({
      ok: true,
      action: "add",
      filesystemServerId: "repo",
      input: {
        id: "pyright",
        command: "pyright-langserver",
        args: ["--stdio"],
        filePatterns: ["**/*.py", "**/*.pyi"],
        rootMarkers: [
          "pyproject.toml",
          "setup.py",
          "setup.cfg",
          "requirements.txt",
          ".git",
        ],
      },
    });
  });

  test("validates /mcp lsp doctor and bad env input", () => {
    expect(
      parseMcpLspCommand("/mcp lsp doctor repo src/index.ts --lsp tsserver")
    ).toEqual({
      ok: true,
      action: "doctor",
      filesystemServerId: "repo",
      path: "src/index.ts",
      lspServerId: "tsserver",
    });

    expect(parseMcpLspCommand("/mcp lsp bootstrap repo")).toEqual({
      ok: true,
      action: "bootstrap",
      filesystemServerId: "repo",
    });

    expect(
      parseMcpLspCommand(
        "/mcp lsp add repo ts --command tsserver --pattern '**/*.ts' --env BAD"
      )
    ).toEqual({
      ok: false,
      message:
        [
          "Usage: /mcp lsp add <filesystem-server> <preset> [lsp-id]",
          "   or: /mcp lsp add <filesystem-server> <lsp-id> --command <cmd> [--arg <arg>]... --pattern <glob> [--pattern <glob>]... [--root <marker>]... [--workspace <path>] [--env KEY=VALUE]...",
          "presets: typescript (ts, tsx, javascript, js), python (py), rust (rs), go (golang), cpp (c, cxx, cc, c++), java (jdt), csharp (cs, c#), php, ruby (rb), lua, html (htm), css (scss, less), json (jsonc), yaml (yml), bash (sh, shell, zsh)",
          "invalid --env: expected KEY=VALUE",
        ].join("\n"),
    });
  });
});
