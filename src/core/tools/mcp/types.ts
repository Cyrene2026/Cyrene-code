export type FileAction =
  | "read_file"
  | "list_dir"
  | "create_file"
  | "write_file"
  | "edit_file"
  | "delete_file";

export type FileToolRequest = {
  action: FileAction;
  path: string;
  content?: string;
  find?: string;
  replace?: string;
};

export type PendingReviewItem = {
  id: string;
  request: FileToolRequest;
  preview: string;
  previewSummary: string;
  previewFull: string;
  createdAt: string;
};

export type RuleConfig = {
  workspaceRoot: string;
  maxReadBytes: number;
  requireReview: FileAction[];
};
