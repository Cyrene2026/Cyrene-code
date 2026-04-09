import type { ToolRequest } from "./toolTypes";
import type {
  McpPolicyDecision,
  McpToolCapability,
  McpToolRisk,
} from "./runtimeTypes";

const READ_ACTIONS = new Set<ToolRequest["action"]>([
  "read_file",
  "read_files",
  "read_range",
  "read_json",
  "read_yaml",
  "list_dir",
  "stat_path",
  "stat_paths",
  "outline_file",
  "find_files",
  "find_symbol",
  "find_references",
  "search_text",
  "search_text_context",
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
  "read_shell",
  "shell_status",
]);

const WRITE_ACTIONS = new Set<ToolRequest["action"]>([
  "create_dir",
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "copy_path",
  "move_path",
  "lsp_rename",
  "lsp_code_actions",
  "lsp_format_document",
]);

const SHELL_ACTIONS = new Set<ToolRequest["action"]>([
  "run_shell",
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
]);

const GIT_ACTIONS = new Set<ToolRequest["action"]>([
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
]);

export const getMcpToolCapabilities = (
  action: ToolRequest["action"]
): McpToolCapability[] => {
  const capabilities = new Set<McpToolCapability>();

  if (READ_ACTIONS.has(action)) {
    capabilities.add("read");
  }
  if (WRITE_ACTIONS.has(action)) {
    capabilities.add("write");
    capabilities.add("review");
  }
  if (
    action === "find_files" ||
    action === "find_symbol" ||
    action === "find_references" ||
    action === "search_text" ||
    action === "ts_definition" ||
    action === "ts_references" ||
    action === "ts_prepare_rename" ||
    action === "lsp_definition" ||
    action === "lsp_implementation" ||
    action === "lsp_type_definition" ||
    action === "lsp_references" ||
    action === "lsp_workspace_symbols" ||
    action === "lsp_prepare_rename" ||
    action === "lsp_rename" ||
    action === "lsp_code_actions" ||
    action === "search_text_context"
  ) {
    capabilities.add("search");
  }
  if (SHELL_ACTIONS.has(action)) {
    capabilities.add("shell");
  }
  if (action === "run_command") {
    capabilities.add("command");
    capabilities.add("review");
  }
  if (GIT_ACTIONS.has(action)) {
    capabilities.add("git");
  }

  return [...capabilities];
};

export const getMcpToolRisk = (action: ToolRequest["action"]): McpToolRisk => {
  if (
    action === "delete_file" ||
    action === "move_path" ||
    action === "run_shell" ||
    action === "write_shell"
  ) {
    return "high";
  }

  if (
    action === "create_file" ||
    action === "write_file" ||
    action === "edit_file" ||
    action === "apply_patch" ||
    action === "copy_path" ||
    action === "lsp_rename" ||
    action === "lsp_code_actions" ||
    action === "lsp_format_document" ||
    action === "run_command" ||
    action === "open_shell" ||
    action === "interrupt_shell" ||
    action === "close_shell"
  ) {
    return "medium";
  }

  return "low";
};

export const buildMcpPolicyDecision = (
  request: ToolRequest,
  requiresReview: boolean
): McpPolicyDecision => ({
  allowed: true,
  requiresReview,
  risk: getMcpToolRisk(request.action),
});
