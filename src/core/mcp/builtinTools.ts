import { defaultMcpToolExposureMode } from "../extensions/metadata";
import type { RuleConfig, ToolRequest } from "./toolTypes";
import { buildMcpPolicyDecision, getMcpToolCapabilities } from "./McpPolicy";
import type { McpToolDescriptor } from "./runtimeTypes";

export const BUILTIN_FILE_TOOL_ACTIONS: ToolRequest["action"][] = [
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

export const getNamespacedToolId = (serverId: string, action: string) =>
  `${serverId}.${action}`;

export const getToolLabel = (action: string) => action.replace(/_/g, " ");

const BUILTIN_TOOL_DESCRIPTIONS: Partial<Record<ToolRequest["action"], string>> = {
  read_file: "Read one file. Aliases: `read`, `cat`.",
  read_json: "Read one JSON file as structured data. Alias: `json`.",
  read_yaml: "Read one YAML file as structured data. Alias: `yaml`.",
  list_dir: "List one directory. Aliases: `list`, `ls`.",
  create_dir: "Create a directory path. Aliases: `create`, `mkdir`.",
  create_file:
    "Create a brand-new file only when fail-if-exists semantics matter. Aliases: `new`, `touch`.",
  write_file:
    "Default file write action for create-or-overwrite behavior. Aliases: `write`, `save`, `overwrite`.",
  edit_file: "Replace a targeted substring in one file. Aliases: `edit`, `replace`.",
  apply_patch: "Apply a targeted single-file patch using find/replace. Alias: `patch`.",
  delete_file: "Remove a file or directory path. Aliases: `delete`, `remove`, `rm`.",
  stat_path: "Inspect one path and report whether it is a file or directory. Aliases: `stat`, `info`.",
  find_files:
    "Find file paths when you know a filename or glob-like pattern. Omit `path` to search the whole workspace. Aliases: `find`, `glob`.",
  find_symbol:
    "Find symbol definitions when you know an identifier and want its declaration. Omit `path` to search the whole workspace. Aliases: `symbol`, `symbols_find`.",
  find_references:
    "Find symbol usages when you know an identifier and want its references. Omit `path` to search the whole workspace. Aliases: `references`, `refs`.",
  search_text:
    "Search file contents when you remember text but not the file path. Omit `path` to search the whole workspace. Aliases: `search`, `grep`.",
  search_text_context:
    "Search file contents and return surrounding lines around each hit. Omit `path` to search the whole workspace. Aliases: `search_context`, `grep_context`.",
  copy_path: "Copy a file or directory path. Aliases: `copy`, `cp`.",
  move_path: "Move or rename a file or directory path. Aliases: `move`, `mv`, `rename`.",
  ts_hover: "TypeScript/JavaScript quick info at an exact file position.",
  ts_definition: "TypeScript/JavaScript definition lookup at an exact file position.",
  ts_references: "TypeScript/JavaScript references at an exact file position.",
  ts_diagnostics: "TypeScript/JavaScript diagnostics for one file.",
  ts_prepare_rename:
    "Preview a TypeScript/JavaScript rename before any file mutation.",
  lsp_hover:
    "Generic language-server hover info. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_definition:
    "Generic language-server definition lookup. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_implementation:
    "Generic language-server implementation lookup. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_type_definition:
    "Generic language-server type-definition lookup. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_references:
    "Generic language-server references. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_workspace_symbols:
    "Generic language-server workspace symbol search. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_document_symbols:
    "Generic language-server document symbols for one file. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_diagnostics:
    "Generic language-server diagnostics for one file. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_prepare_rename:
    "Preview a generic language-server rename before any file mutation. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_rename:
    "Apply a reviewed generic language-server rename. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_code_actions:
    "List or apply generic language-server code actions at an exact file position. Applying edits requires review. Requires configured `lsp_servers` on the filesystem MCP server.",
  lsp_format_document:
    "Apply reviewed generic language-server document formatting edits. Requires configured `lsp_servers` on the filesystem MCP server.",
};

export const buildBuiltinToolDescriptors = (
  serverId: string,
  ruleConfig: Pick<RuleConfig, "requireReview">,
  options?: {
    serverExposure?: McpToolDescriptor["exposure"];
  }
): McpToolDescriptor[] =>
  BUILTIN_FILE_TOOL_ACTIONS.map(action => {
    const requiresReview =
      action === "run_command" ||
      action === "run_shell" ||
      ruleConfig.requireReview.includes(action);
    const policy = buildMcpPolicyDecision(
      { action, path: "." } as ToolRequest,
      requiresReview
    );

    return {
      id: getNamespacedToolId(serverId, action),
      serverId,
      name: action,
      label: getToolLabel(action),
      description: BUILTIN_TOOL_DESCRIPTIONS[action],
      capabilities: getMcpToolCapabilities(action),
      risk: policy.risk,
      requiresReview: policy.requiresReview,
      enabled: true,
      exposure: defaultMcpToolExposureMode(options?.serverExposure ?? "full"),
      tags: [...getMcpToolCapabilities(action), action.replace(/_/g, "-")],
    };
  });
