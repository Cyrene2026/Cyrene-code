export type FileAction =
  | "read_file"
  | "read_files"
  | "read_range"
  | "read_json"
  | "read_yaml"
  | "list_dir"
  | "create_dir"
  | "create_file"
  | "write_file"
  | "edit_file"
  | "apply_patch"
  | "delete_file"
  | "stat_path"
  | "stat_paths"
  | "outline_file"
  | "find_files"
  | "find_symbol"
  | "find_references"
  | "search_text"
  | "search_text_context"
  | "copy_path"
  | "move_path"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_show"
  | "git_blame";

export type ShellSessionAction =
  | "open_shell"
  | "write_shell"
  | "read_shell"
  | "shell_status"
  | "interrupt_shell"
  | "close_shell";

export type CommandAction = "run_command" | "run_shell" | ShellSessionAction;

export type MpcAction = FileAction | CommandAction;

export type ReadFileToolRequest = {
  action: "read_file";
  path: string;
};

export type ListDirToolRequest = {
  action: "list_dir";
  path: string;
};

export type ReadFilesToolRequest = {
  action: "read_files";
  path: string;
  paths?: string[];
};

export type ReadRangeToolRequest = {
  action: "read_range";
  path: string;
  startLine: number;
  endLine: number;
};

export type ReadJsonToolRequest = {
  action: "read_json";
  path: string;
  jsonPath?: string;
};

export type ReadYamlToolRequest = {
  action: "read_yaml";
  path: string;
  yamlPath?: string;
};

export type CreateDirToolRequest = {
  action: "create_dir";
  path: string;
};

export type CreateFileToolRequest = {
  action: "create_file";
  path: string;
  content?: string;
};

export type WriteFileToolRequest = {
  action: "write_file";
  path: string;
  content?: string;
};

export type EditFileToolRequest = {
  action: "edit_file";
  path: string;
  find?: string;
  replace?: string;
};

export type ApplyPatchToolRequest = {
  action: "apply_patch";
  path: string;
  find?: string;
  replace?: string;
};

export type DeleteFileToolRequest = {
  action: "delete_file";
  path: string;
};

export type StatPathToolRequest = {
  action: "stat_path";
  path: string;
};

export type StatPathsToolRequest = {
  action: "stat_paths";
  path: string;
  paths?: string[];
};

export type OutlineFileToolRequest = {
  action: "outline_file";
  path: string;
};

export type FindFilesToolRequest = {
  action: "find_files";
  path: string;
  pattern: string;
  maxResults?: number;
  caseSensitive?: boolean;
};

export type FindSymbolToolRequest = {
  action: "find_symbol";
  path: string;
  symbol: string;
  maxResults?: number;
  caseSensitive?: boolean;
};

export type FindReferencesToolRequest = {
  action: "find_references";
  path: string;
  symbol: string;
  maxResults?: number;
  caseSensitive?: boolean;
};

export type SearchTextToolRequest = {
  action: "search_text";
  path: string;
  query: string;
  maxResults?: number;
  caseSensitive?: boolean;
};

export type SearchTextContextToolRequest = {
  action: "search_text_context";
  path: string;
  query: string;
  before?: number;
  after?: number;
  maxResults?: number;
  caseSensitive?: boolean;
};

export type CopyPathToolRequest = {
  action: "copy_path";
  path: string;
  destination: string;
};

export type MovePathToolRequest = {
  action: "move_path";
  path: string;
  destination: string;
};

export type GitStatusToolRequest = {
  action: "git_status";
  path: string;
};

export type GitDiffToolRequest = {
  action: "git_diff";
  path: string;
};

export type GitLogToolRequest = {
  action: "git_log";
  path: string;
  maxResults?: number;
};

export type GitShowToolRequest = {
  action: "git_show";
  path: string;
  revision: string;
};

export type GitBlameToolRequest = {
  action: "git_blame";
  path: string;
  startLine?: number;
  endLine?: number;
};

export type FileToolRequest =
  | ReadFileToolRequest
  | ReadFilesToolRequest
  | ReadRangeToolRequest
  | ReadJsonToolRequest
  | ReadYamlToolRequest
  | ListDirToolRequest
  | CreateDirToolRequest
  | CreateFileToolRequest
  | WriteFileToolRequest
  | EditFileToolRequest
  | ApplyPatchToolRequest
  | DeleteFileToolRequest
  | StatPathToolRequest
  | StatPathsToolRequest
  | OutlineFileToolRequest
  | FindFilesToolRequest
  | FindSymbolToolRequest
  | FindReferencesToolRequest
  | SearchTextToolRequest
  | SearchTextContextToolRequest
  | CopyPathToolRequest
  | MovePathToolRequest
  | GitStatusToolRequest
  | GitDiffToolRequest
  | GitLogToolRequest
  | GitShowToolRequest
  | GitBlameToolRequest;

export type CommandToolRequest = {
  action: "run_command";
  path: string;
  command: string;
  args: string[];
  cwd?: string;
};

export type ShellToolRequest = {
  action: "run_shell";
  path: string;
  command: string;
  cwd?: string;
};

export type OpenShellToolRequest = {
  action: "open_shell";
  path: string;
  cwd?: string;
};

export type WriteShellToolRequest = {
  action: "write_shell";
  path: string;
  input: string;
};

export type ReadShellToolRequest = {
  action: "read_shell";
  path: string;
};

export type ShellStatusToolRequest = {
  action: "shell_status";
  path: string;
};

export type InterruptShellToolRequest = {
  action: "interrupt_shell";
  path: string;
};

export type CloseShellToolRequest = {
  action: "close_shell";
  path: string;
};

export type ToolRequest =
  | FileToolRequest
  | CommandToolRequest
  | ShellToolRequest
  | OpenShellToolRequest
  | WriteShellToolRequest
  | ReadShellToolRequest
  | ShellStatusToolRequest
  | InterruptShellToolRequest
  | CloseShellToolRequest;

export type PendingReviewItem = {
  id: string;
  serverId?: string;
  request: ToolRequest;
  preview: string;
  previewSummary: string;
  previewFull: string;
  createdAt: string;
};

export type RuleConfig = {
  workspaceRoot: string;
  maxReadBytes: number;
  requireReview: MpcAction[];
};
