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
      capabilities: getMcpToolCapabilities(action),
      risk: policy.risk,
      requiresReview: policy.requiresReview,
      enabled: true,
    };
  });
