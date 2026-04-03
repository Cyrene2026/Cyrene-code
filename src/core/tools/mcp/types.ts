export type FileAction =
  | "read_file"
  | "list_dir"
  | "create_dir"
  | "create_file"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "stat_path"
  | "find_files"
  | "search_text"
  | "copy_path"
  | "move_path";

export type CommandAction = "run_command" | "run_shell";

export type MpcAction = FileAction | CommandAction;

export type ReadFileToolRequest = {
  action: "read_file";
  path: string;
};

export type ListDirToolRequest = {
  action: "list_dir";
  path: string;
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

export type DeleteFileToolRequest = {
  action: "delete_file";
  path: string;
};

export type StatPathToolRequest = {
  action: "stat_path";
  path: string;
};

export type FindFilesToolRequest = {
  action: "find_files";
  path: string;
  pattern: string;
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

export type FileToolRequest =
  | ReadFileToolRequest
  | ListDirToolRequest
  | CreateDirToolRequest
  | CreateFileToolRequest
  | WriteFileToolRequest
  | EditFileToolRequest
  | DeleteFileToolRequest
  | StatPathToolRequest
  | FindFilesToolRequest
  | SearchTextToolRequest
  | CopyPathToolRequest
  | MovePathToolRequest;

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

export type ToolRequest = FileToolRequest | CommandToolRequest | ShellToolRequest;

export type PendingReviewItem = {
  id: string;
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
