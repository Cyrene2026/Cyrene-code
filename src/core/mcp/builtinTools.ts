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
  ruleConfig: Pick<RuleConfig, "requireReview">
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
    };
  });
