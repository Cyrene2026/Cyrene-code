export type FileAction =
  | "read_file"
  | "list_dir"
  | "create_dir"
  | "create_file"
  | "write_file"
  | "edit_file"
  | "delete_file";

export type CommandAction = "run_command";

export type MpcAction = FileAction | CommandAction;

export type FileToolRequest = {
  action: FileAction;
  path: string;
  content?: string;
  find?: string;
  replace?: string;
};

export type CommandToolRequest = {
  action: CommandAction;
  path: string;
  command: string;
  args: string[];
  cwd?: string;
};

export type ToolRequest = FileToolRequest | CommandToolRequest;

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
