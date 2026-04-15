import {
  copyFile,
  cp,
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type {
  ApplyPatchToolRequest,
  CommandToolRequest,
  FileAction,
  FindFilesToolRequest,
  FindReferencesToolRequest,
  FindSymbolToolRequest,
  GitBlameToolRequest,
  GitDiffToolRequest,
  GitLogToolRequest,
  GitShowToolRequest,
  GitStatusToolRequest,
  OutlineFileToolRequest,
  PendingReviewItem,
  ReadJsonToolRequest,
  ReadFilesToolRequest,
  ReadRangeToolRequest,
  ReadYamlToolRequest,
  RuleConfig,
  SearchTextContextToolRequest,
  SearchTextToolRequest,
  LspDefinitionToolRequest,
  LspDiagnosticsToolRequest,
  LspDocumentSymbolsToolRequest,
  LspHoverToolRequest,
  LspCodeActionsToolRequest,
  LspImplementationToolRequest,
  LspFormatDocumentToolRequest,
  LspPrepareRenameToolRequest,
  LspRenameToolRequest,
  LspReferencesToolRequest,
  LspTypeDefinitionToolRequest,
  LspWorkspaceSymbolsToolRequest,
  TsDefinitionToolRequest,
  TsDiagnosticsToolRequest,
  TsHoverToolRequest,
  TsPrepareRenameToolRequest,
  TsReferencesToolRequest,
  ShellToolRequest,
  OpenShellToolRequest,
  WriteShellToolRequest,
  ReadShellToolRequest,
  ShellStatusToolRequest,
  InterruptShellToolRequest,
  CloseShellToolRequest,
  StatPathsToolRequest,
  ToolRequest,
} from "../../toolTypes";
import { parseYamlDocument } from "../../simpleYaml";
import {
  TsServerClient,
  type TsServerClientLike,
  type TsServerDiagnostic,
  type TsServerFileSpan,
  type TsServerRenameLocation,
} from "./tsserverClient";
import {
  LspManager,
  pathFromLspUri,
  type LspCodeAction,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspLocation,
  type LspManagerLike,
  type LspPrepareRenameResult,
  type LspRange,
  type LspTextEdit,
  type LspWorkspaceLike,
  type LspWorkspaceSymbol,
  type LspWorkspaceEdit,
} from "./lspClient";
import { buildRestrictedSubprocessEnvFromBase } from "./subprocessEnv";

type HandleResult = {
  ok: boolean;
  message: string;
  pending?: PendingReviewItem;
};

type UndoEntry =
  | {
      kind: "restore_file";
      path: string;
      existedBefore: boolean;
      content: Uint8Array;
      sourceAction: ToolRequest["action"];
    }
  | {
      kind: "delete_path";
      path: string;
      sourceAction: ToolRequest["action"];
    }
  | {
      kind: "move_path";
      from: string;
      to: string;
      sourceAction: ToolRequest["action"];
    }
  | {
      kind: "restore_workspace";
      files: Array<{
        path: string;
        existedBefore: boolean;
        content: Uint8Array;
      }>;
      sourceAction: ToolRequest["action"];
    };

type FileMcpServiceOptions = {
  commandRunner?: (
    request: CommandToolRequest,
    resolvedCwd: string
  ) => Promise<string | CommandExecutionResult>;
  shellRunner?: (
    request: ShellToolRequest,
    resolvedCwd: string,
    shell: ShellFlavor
  ) => Promise<string | CommandExecutionResult>;
  gitRunner?: (
    args: string[],
    resolvedCwd: string
  ) => Promise<string | CommandExecutionResult>;
  ptyFactory?: PtyFactory;
  shellSettleMs?: number;
  tsServerClient?: TsServerClientLike;
  tsToolTimeoutMs?: number;
  lspManager?: LspManagerLike;
};

type CommandExecutionResult = {
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  output?: string;
  truncated?: boolean;
};

type ShellSessionStatus = "none" | "idle" | "running" | "exited";

type PersistentShellFlavor = "pwsh" | "bash" | "sh";

type PtyExitEvent = {
  exitCode: number;
  signal?: string | number;
};

type PtySubscription = {
  dispose: () => void;
};

type PtyProcess = {
  write: (data: string) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => PtySubscription | void;
  onExit: (listener: (event: PtyExitEvent) => void) => PtySubscription | void;
};

type PtyFactoryOptions = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  name: string;
  cols: number;
  rows: number;
};

type PtyFactory = (options: PtyFactoryOptions) => Promise<PtyProcess> | PtyProcess;

type ActiveShellSession = {
  shell: PersistentShellFlavor;
  program: string;
  cwd: string;
  busy: boolean;
  alive: boolean;
  exited: boolean;
  createdAt: string;
  lastActivityAt: string;
  lastExitCode: number | null;
  unreadOutputBuffer: string;
  unreadOutputTruncated: boolean;
  controlBuffer: string;
  pendingCommandId: string | null;
  pendingExitCode: number | null;
  pendingCwd: string | null;
  handle: PtyProcess;
  dataSubscription?: PtySubscription;
  exitSubscription?: PtySubscription;
};

type ShellSessionWriteAuditResult = {
  ok: boolean;
  shell: PersistentShellFlavor;
  tokens: string[];
  policy: "blocked" | "direct" | "review";
  risk: "low" | "medium" | "high";
  reason?: string;
  notes: string[];
};

type SearchableFile = {
  absolutePath: string;
  workspacePath: string;
  relativeToStart: string;
};

type WalkFilesResult = {
  files: SearchableFile[];
  skippedDirectoryNames: string[];
  fileLimitHit: boolean;
};

type PathConflict = {
  action: ToolRequest["action"];
  path: string;
};

type LspWorkspaceFileEditPlan = {
  uri: string;
  filePath: string;
  workspacePath: string;
  edits: LspTextEdit[];
  before: string;
  after: string;
};

type LspWorkspaceEditPlan = {
  files: LspWorkspaceFileEditPlan[];
  skippedPaths: string[];
  totalEdits: number;
};

type ResolvedLspRenamePlan = {
  session: LspWorkspaceLike;
  prepare: LspPrepareRenameResult | null;
  workspaceEdit: LspWorkspaceEdit | null;
  plan: LspWorkspaceEditPlan | null;
};

type ResolvedLspCodeActionPlan = {
  session: LspWorkspaceLike;
  absolutePath: string;
  actions: LspCodeAction[];
  selectedAction: LspCodeAction | null;
  plan: LspWorkspaceEditPlan | null;
};

type ResolvedLspFormatDocumentPlan = {
  session: LspWorkspaceLike;
  edits: LspTextEdit[];
  plan: LspWorkspaceEditPlan;
};

type PendingApprovalGuard =
  | {
      kind: "write_shell";
      sessionCreatedAt: string;
      cwd: string;
    }
  | {
      kind: "lsp_rename";
      resolved: ResolvedLspRenamePlan;
    }
  | {
      kind: "lsp_code_actions";
      resolved: ResolvedLspCodeActionPlan;
    }
  | {
      kind: "lsp_format_document";
      resolved: ResolvedLspFormatDocumentPlan;
    };

type PreparedPendingReview = {
  previewSummary: string;
  previewFull: string;
  guard?: PendingApprovalGuard;
};

type ShellFlavor = "cmd" | "pwsh" | "sh";

type ShellAuditResult = {
  ok: boolean;
  shell: ShellFlavor;
  tokens: string[];
  risk: "low" | "medium" | "high";
  reason?: string;
  notes: string[];
};

const READ_ONLY_ACTIONS: FileAction[] = [
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
];
const READ_ONLY_ACTION_SET = new Set<ToolRequest["action"]>(READ_ONLY_ACTIONS);
const LSP_SYMBOL_KIND_LABELS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum_member",
  "struct",
  "event",
  "operator",
  "type_parameter",
];
const TYPESCRIPT_LANGUAGE_EXTENSIONS = /\.(?:d\.)?(?:[cm]?[jt]sx?)$/i;
const SHELL_MUTATING_COMMANDS = new Set([
  "rm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rmdir",
  "mv",
  "move-item",
  "cp",
  "copy-item",
  "mkdir",
  "md",
  "touch",
  "new-item",
  "ni",
  "set-content",
  "add-content",
  "out-file",
]);
const SHELL_DELETE_COMMANDS = new Set([
  "rm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rmdir",
]);
const SHELL_SESSION_DIRECT_PATH_COMMANDS = new Set([
  "ls",
  "dir",
  "get-childitem",
]);
const SHELL_SESSION_DIRECT_READ_COMMANDS = new Set([
  "cat",
  "type",
  "get-content",
]);
const SHELL_SESSION_DIRECT_LITERAL_COMMANDS = new Set([
  "pwd",
  "get-location",
  "echo",
  "write-output",
  "which",
  "where",
]);
const COMMAND_TIMEOUT_MS = 20_000;
const INSTALL_COMMAND_TIMEOUT_MS = 180_000;
const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_SNIPPET_CHARS = 160;
const DEFAULT_GIT_LOG_RESULTS = 12;
const MAX_GIT_LOG_RESULTS = 50;
const MIN_STREAM_SCAN_BYTES = 1024 * 1024;
const MAX_STREAM_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_OUTLINE_ENTRIES = 200;
const MAX_SEARCHABLE_FILES = 8_000;
const DEFAULT_IGNORED_SEARCH_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "out",
  "target",
  "vendor",
]);
const RECENT_LIST_DIR_WINDOW_MS = 5_000;
const DEFAULT_SHELL_SETTLE_MS = 160;
const MAX_UNDO_HISTORY = 50;
const PENDING_CONFLICT_ACTIONS: FileAction[] = [
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
];
const MAX_PREVIEW_SUMMARY_LINES = 24;
const lineNoWidth = 4;
const MAX_MUTATION_DIFF_MATRIX_CELLS = 40_000;

const clip = (text: string, max = 320) =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

const INSTALL_SUBCOMMANDS = new Set([
  "install",
  "add",
  "i",
  "sync",
]);

const normalizeToken = (value: string) => value.trim().toLowerCase();

const isPackageInstallInvocation = (command: string, args: string[] = []) => {
  const normalizedCommand = normalizeToken(command);
  const normalizedArgs = args.map(normalizeToken).filter(Boolean);
  const firstArg = normalizedArgs[0] ?? "";

  if (["npm", "pnpm", "yarn", "bun"].includes(normalizedCommand)) {
    return INSTALL_SUBCOMMANDS.has(firstArg);
  }

  if (["pip", "pip3", "uv"].includes(normalizedCommand)) {
    return firstArg === "install" || (normalizedCommand === "uv" && firstArg === "sync");
  }

  if (["cargo", "go", "gem"].includes(normalizedCommand)) {
    return firstArg === "install";
  }

  return false;
};

const extractShellCommandTokens = (command: string) =>
  command
    .trim()
    .split(/\s+/)
    .map(token => token.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);

export const getCommandTimeoutMs = (
  request: Pick<CommandToolRequest | ShellToolRequest, "action" | "command"> & {
    args?: string[];
  }
) => {
  if (request.action === "run_command") {
    return isPackageInstallInvocation(request.command, request.args ?? [])
      ? INSTALL_COMMAND_TIMEOUT_MS
      : COMMAND_TIMEOUT_MS;
  }

  const tokens = extractShellCommandTokens(request.command);
  if (tokens.length === 0) {
    return COMMAND_TIMEOUT_MS;
  }

  const [command = "", ...args] = tokens;
  return isPackageInstallInvocation(command, args)
    ? INSTALL_COMMAND_TIMEOUT_MS
    : COMMAND_TIMEOUT_MS;
};

const countTextLines = (text: string) => {
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
};

const formatConfirmedFileMutationReceipt = (
  action: "create_file" | "write_file" | "edit_file" | "apply_patch",
  path: string,
  beforeContent: string,
  afterContent: string,
  postcondition: string
) => {
  const diff = summarizeMutationDiff(beforeContent, afterContent);
  return [
    `${
      action === "create_file"
        ? "Created file"
        : action === "write_file"
          ? "Wrote file"
          : action === "edit_file"
            ? "Edited file"
            : "Patched file"
    }: ${path}`,
    `[confirmed file mutation] ${action} ${path}`,
    `postcondition: ${postcondition}`,
    `bytes_before: ${Buffer.byteLength(beforeContent, "utf8")}`,
    `bytes_after: ${Buffer.byteLength(afterContent, "utf8")}`,
    `lines_before: ${countTextLines(beforeContent)}`,
    `lines_after: ${countTextLines(afterContent)}`,
    `diff_stats: +${diff.additions} -${diff.deletions}`,
    ...(diff.previewLines.length > 0 ? ["[diff preview]", ...diff.previewLines] : []),
    ...(diff.omitted > 0 ? [`diff_preview_omitted: ${diff.omitted}`] : []),
    "next: do not call read_file on this path just to confirm the write; continue unless explicit verification is required",
  ].join("\n");
};

const splitTextLinesForDiff = (text: string) => {
  if (text.length === 0) {
    return [] as string[];
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

type MutationDiffEntry = {
  kind: "equal" | "add" | "delete";
  text: string;
  lineNumber: number;
};

const getCommonPrefixLineCount = (beforeLines: string[], afterLines: string[]) => {
  let index = 0;
  while (
    index < beforeLines.length &&
    index < afterLines.length &&
    beforeLines[index] === afterLines[index]
  ) {
    index += 1;
  }
  return index;
};

const getCommonSuffixLineCount = (
  beforeLines: string[],
  afterLines: string[],
  prefixCount: number
) => {
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefixCount &&
    suffix < afterLines.length - prefixCount &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return suffix;
};

const buildMutationDiffEntries = (
  beforeLines: string[],
  afterLines: string[],
  startLine: number
): MutationDiffEntry[] => {
  const rows = beforeLines.length;
  const cols = afterLines.length;
  if (rows === 0 && cols === 0) {
    return [];
  }

  if (rows * cols > MAX_MUTATION_DIFF_MATRIX_CELLS) {
    return [
      ...beforeLines.map((text, index) => ({
        kind: "delete" as const,
        text,
        lineNumber: startLine + index,
      })),
      ...afterLines.map((text, index) => ({
        kind: "add" as const,
        text,
        lineNumber: startLine + index,
      })),
    ];
  }

  const matrix = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      matrix[row]![col] =
        beforeLines[row - 1] === afterLines[col - 1]
          ? (matrix[row - 1]![col - 1] ?? 0) + 1
          : Math.max(matrix[row - 1]![col] ?? 0, matrix[row]![col - 1] ?? 0);
    }
  }

  const entries: MutationDiffEntry[] = [];
  let row = rows;
  let col = cols;
  while (row > 0 && col > 0) {
    if (beforeLines[row - 1] === afterLines[col - 1]) {
      entries.push({
        kind: "equal",
        text: beforeLines[row - 1] ?? "",
        lineNumber: startLine + row - 1,
      });
      row -= 1;
      col -= 1;
      continue;
    }
    if ((matrix[row - 1]![col] ?? 0) >= (matrix[row]![col - 1] ?? 0)) {
      entries.push({
        kind: "delete",
        text: beforeLines[row - 1] ?? "",
        lineNumber: startLine + row - 1,
      });
      row -= 1;
      continue;
    }
    entries.push({
      kind: "add",
      text: afterLines[col - 1] ?? "",
      lineNumber: startLine + col - 1,
    });
    col -= 1;
  }
  while (row > 0) {
    entries.push({
      kind: "delete",
      text: beforeLines[row - 1] ?? "",
      lineNumber: startLine + row - 1,
    });
    row -= 1;
  }
  while (col > 0) {
    entries.push({
      kind: "add",
      text: afterLines[col - 1] ?? "",
      lineNumber: startLine + col - 1,
    });
    col -= 1;
  }
  return entries.reverse();
};

const summarizeMutationDiff = (beforeContent: string, afterContent: string) => {
  const beforeLines = splitTextLinesForDiff(beforeContent);
  const afterLines = splitTextLinesForDiff(afterContent);
  const prefixCount = getCommonPrefixLineCount(beforeLines, afterLines);
  const suffixCount = getCommonSuffixLineCount(beforeLines, afterLines, prefixCount);
  const beforeChanged = beforeLines.slice(prefixCount, beforeLines.length - suffixCount);
  const afterChanged = afterLines.slice(prefixCount, afterLines.length - suffixCount);
  const diffEntries = buildMutationDiffEntries(beforeChanged, afterChanged, prefixCount + 1);
  const changedEntries = diffEntries.filter(entry => entry.kind !== "equal");
  const previewLines = changedEntries.map(entry => {
    const marker = entry.kind === "add" ? "+" : "-";
    const lineNo = String(entry.lineNumber).padStart(lineNoWidth, " ");
    return `${marker} ${lineNo} | ${entry.text}`;
  });

  return {
    additions: changedEntries.filter(entry => entry.kind === "add").length,
    deletions: changedEntries.filter(entry => entry.kind === "delete").length,
    previewLines,
    omitted: 0,
  };
};

const lineNumberAtIndex = (text: string, index: number) =>
  text.slice(0, Math.max(0, index)).split("\n").length;

const formatDiffLines = (
  marker: "+" | "-",
  content: string,
  startLine: number,
  maxLines?: number
) => {
  const lines = content.split("\n");
  const limited = typeof maxLines === "number" ? lines.slice(0, maxLines) : lines;
  const body = limited.map((line, idx) => {
    const lineNo = String(startLine + idx).padStart(lineNoWidth, " ");
    return `${marker} ${lineNo} | ${line}`;
  });
  if (typeof maxLines === "number" && lines.length > limited.length) {
    body.push(`  .... | ... ${lines.length - limited.length} more lines`);
  }
  return body.join("\n");
};

const normalizeAction = (raw: unknown): ToolRequest["action"] | null => {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "read":
    case "read_file":
    case "cat":
      return "read_file";
    case "read_files":
    case "cat_files":
    case "multi_read":
      return "read_files";
    case "read_range":
    case "read_lines":
    case "read_window":
      return "read_range";
    case "read_json":
    case "json":
    case "json_read":
      return "read_json";
    case "read_yaml":
    case "yaml":
    case "yaml_read":
      return "read_yaml";
    case "list":
    case "list_dir":
    case "ls":
      return "list_dir";
    case "create":
    case "create_dir":
    case "mkdir":
    case "make_dir":
    case "new_dir":
      return "create_dir";
    case "create_file":
    case "new":
    case "touch":
      return "create_file";
    case "write":
    case "write_file":
    case "save":
    case "overwrite":
      return "write_file";
    case "edit":
    case "edit_file":
    case "replace":
      return "edit_file";
    case "apply_patch":
    case "patch":
      return "apply_patch";
    case "delete":
    case "delete_file":
    case "remove":
    case "rm":
      return "delete_file";
    case "stat":
    case "stat_path":
    case "info":
      return "stat_path";
    case "stat_paths":
    case "multi_stat":
      return "stat_paths";
    case "outline":
    case "outline_file":
    case "symbols":
      return "outline_file";
    case "find":
    case "find_files":
    case "glob":
      return "find_files";
    case "find_symbol":
    case "symbol":
    case "symbols_find":
      return "find_symbol";
    case "find_references":
    case "references":
    case "refs":
      return "find_references";
    case "search":
    case "search_text":
    case "grep":
      return "search_text";
    case "search_text_context":
    case "grep_context":
    case "search_context":
      return "search_text_context";
    case "copy":
    case "copy_path":
    case "cp":
      return "copy_path";
    case "move":
    case "move_path":
    case "mv":
    case "rename":
      return "move_path";
    case "run":
    case "run_command":
    case "command":
    case "exec":
      return "run_command";
    case "git_status":
    case "status_git":
      return "git_status";
    case "git_diff":
    case "diff_git":
      return "git_diff";
    case "git_log":
    case "log_git":
      return "git_log";
    case "git_show":
    case "show_git":
      return "git_show";
    case "git_blame":
    case "blame_git":
      return "git_blame";
    case "ts_hover":
    case "hover":
    case "quickinfo":
      return "ts_hover";
    case "ts_definition":
    case "definition":
    case "go_to_definition":
      return "ts_definition";
    case "ts_references":
    case "semantic_references":
      return "ts_references";
    case "ts_diagnostics":
    case "diagnostics":
      return "ts_diagnostics";
    case "ts_prepare_rename":
    case "prepare_rename":
    case "rename_preview":
      return "ts_prepare_rename";
    case "lsp_hover":
      return "lsp_hover";
    case "lsp_definition":
      return "lsp_definition";
    case "lsp_implementation":
    case "implementation":
    case "go_to_implementation":
      return "lsp_implementation";
    case "lsp_type_definition":
    case "type_definition":
    case "go_to_type_definition":
      return "lsp_type_definition";
    case "lsp_references":
      return "lsp_references";
    case "lsp_workspace_symbols":
    case "workspace_symbols":
      return "lsp_workspace_symbols";
    case "lsp_document_symbols":
    case "document_symbols":
    case "lsp_symbols":
      return "lsp_document_symbols";
    case "lsp_diagnostics":
      return "lsp_diagnostics";
    case "lsp_prepare_rename":
    case "lsp_rename_preview":
      return "lsp_prepare_rename";
    case "lsp_rename":
    case "rename_symbol":
      return "lsp_rename";
    case "lsp_code_actions":
    case "code_actions":
    case "code_action":
      return "lsp_code_actions";
    case "lsp_format_document":
    case "format_document":
    case "format_file":
    case "lsp_format":
      return "lsp_format_document";
    case "run_shell":
    case "shell_command":
    case "terminal":
    case "shell":
      return "run_shell";
    case "open_shell":
    case "shell_open":
      return "open_shell";
    case "write_shell":
    case "shell_write":
    case "shell_input":
      return "write_shell";
    case "read_shell":
    case "shell_read":
      return "read_shell";
    case "shell_status":
    case "status_shell":
      return "shell_status";
    case "interrupt_shell":
    case "shell_interrupt":
      return "interrupt_shell";
    case "close_shell":
    case "shell_close":
      return "close_shell";
    default:
      return null;
  }
};

const pickString = (obj: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const pickStringArray = (obj: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value) && value.every(item => typeof item === "string")) {
      return value as string[];
    }
  }
  return undefined;
};

const pickFirstNonEmptyValue = (values: string[] | undefined) => {
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
};

const buildPathTargets = (
  path: string | undefined,
  extraPaths: string[] | undefined,
  options?: { allowCurrentDir?: boolean }
) => {
  const seen = new Set<string>();
  const merged: string[] = [];
  const allowCurrentDir = options?.allowCurrentDir ?? true;

  for (const candidate of [path, ...(extraPaths ?? [])]) {
    const trimmed = candidate?.trim();
    if (!trimmed || (!allowCurrentDir && trimmed === ".")) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return merged;
};

const buildReadFilesTargets = (path: string | undefined, extraPaths: string[] | undefined) =>
  buildPathTargets(path, extraPaths, { allowCurrentDir: false });

const buildStatPathsTargets = (path: string | undefined, extraPaths: string[] | undefined) =>
  buildPathTargets(path, extraPaths, { allowCurrentDir: true });

const pickNumber = (obj: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const pickBoolean = (obj: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "true") {
        return true;
      }
      if (value.trim().toLowerCase() === "false") {
        return false;
      }
    }
  }
  return undefined;
};

const hasRecordValue = (obj: Record<string, unknown>, keys: string[]) =>
  keys.some(key => {
    const value = obj[key];
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return true;
  });

const normalizeSearchLimit = (value: number | undefined) => {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_SEARCH_RESULTS;
  }
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(value)));
};

const normalizeGitLogLimit = (value: number | undefined) => {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_GIT_LOG_RESULTS;
  }
  return Math.min(MAX_GIT_LOG_RESULTS, Math.max(1, Math.floor(value)));
};

const normalizePositiveInteger = (value: number | undefined) => {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
};

const normalizeNonNegativeInteger = (value: number | undefined) => {
  if (!Number.isFinite(value) || typeof value !== "number" || value < 0) {
    return undefined;
  }
  return Math.floor(value);
};

const toRecord = (input: unknown): Record<string, unknown> | null => {
  if (!input) {
    return null;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof input === "object") {
    return input as Record<string, unknown>;
  }
  return null;
};

const WRAPPER_KEYS = [
  "arguments",
  "args",
  "parameters",
  "params",
  "input",
  "tool_input",
  "payload",
  "data",
  "raw",
  "function",
  "tool_call",
  "toolCall",
] as const;

const tokenizeCommand = (raw: string) =>
  [...raw.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)].map(match =>
    match[1] ?? match[2] ?? match[0] ?? ""
  );

const WINDOWS_PWSH_ONLY_COMMANDS = new Set([
  "get-childitem",
  "get-content",
  "get-location",
  "write-output",
  "remove-item",
  "move-item",
  "copy-item",
  "new-item",
  "set-content",
  "add-content",
  "out-file",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
]);

const WINDOWS_CMD_PREFERRED_COMMANDS = new Set([
  "dir",
  "type",
  "where",
  "echo",
  "cd",
  "git",
  "python",
  "py",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "go",
  "cargo",
  "java",
  "javac",
  "rustc",
  "pip",
  "pip3",
]);

const resolveShellFlavorForCommand = (command: string): ShellFlavor => {
  if (process.platform !== "win32") {
    return "sh";
  }
  const tokenized = tokenizeSafeShellCommand(command);
  if (!tokenized.ok) {
    return "pwsh";
  }
  const commandName = (tokenized.tokens[0] ?? "").toLowerCase();
  if (!commandName) {
    return "pwsh";
  }
  if (WINDOWS_PWSH_ONLY_COMMANDS.has(commandName)) {
    return "pwsh";
  }
  if (WINDOWS_CMD_PREFERRED_COMMANDS.has(commandName)) {
    return "cmd";
  }
  return "pwsh";
};

const getShellFlavor = (command?: string): ShellFlavor =>
  process.platform === "win32"
    ? resolveShellFlavorForCommand(command ?? "")
    : "sh";

const getPersistentShellFlavor = async (): Promise<PersistentShellFlavor> => {
  if (process.platform === "win32") {
    return "pwsh";
  }
  try {
    await access("/bin/bash");
    return "bash";
  } catch {
    return "sh";
  }
};

const getPersistentShellProgram = (shell: PersistentShellFlavor) =>
  shell === "pwsh" ? "pwsh" : shell === "bash" ? "/bin/bash" : "/bin/sh";

const isPersistentShellAction = (
  action: ToolRequest["action"]
): action is
  | "open_shell"
  | "write_shell"
  | "read_shell"
  | "shell_status"
  | "interrupt_shell"
  | "close_shell" =>
  [
    "open_shell",
    "write_shell",
    "read_shell",
    "shell_status",
    "interrupt_shell",
    "close_shell",
  ].includes(action);

const SHELL_STATUS_MARKER_PREFIX = "__CYRENE_STATUS__";
const SHELL_CWD_MARKER_PREFIX = "__CYRENE_CWD__";

const buildShellStatusMarker = (commandId: string, exitCode: number | string) =>
  `${SHELL_STATUS_MARKER_PREFIX}${commandId}__${exitCode}`;

const buildShellCwdMarker = (commandId: string, cwd: string) =>
  `${SHELL_CWD_MARKER_PREFIX}${commandId}__${cwd}`;

const tokenizeSafeShellCommand = (
  raw: string
): { ok: true; tokens: string[] } | { ok: false; reason: string } => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    tokens.push(current);
    current = "";
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    const next = raw[index + 1] ?? "";

    if (!quote) {
      if (/\s/.test(char)) {
        pushCurrent();
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char as "'" | '"';
        continue;
      }
      if (char === "`") {
        return { ok: false, reason: "run_shell does not allow backticks or command substitution." };
      }
      if (char === "$" && next === "(") {
        return { ok: false, reason: "run_shell does not allow subshell syntax such as $(...)." };
      }
      if (char === "|") {
        return { ok: false, reason: "run_shell does not allow pipes or chained shell operators." };
      }
      if (char === ";" || char === "&") {
        return { ok: false, reason: "run_shell does not allow chaining or background execution." };
      }
      if (char === ">" || char === "<") {
        return { ok: false, reason: "run_shell does not allow redirection, heredoc, or here-string syntax." };
      }
      if (char === "\\") {
        if (next) {
          current += next;
          index += 1;
        }
        continue;
      }
      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === "\"" && char === "\\") {
      if (next) {
        current += next;
        index += 1;
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    return { ok: false, reason: "run_shell requires balanced quotes." };
  }

  pushCurrent();

  if (tokens.length === 0) {
    return { ok: false, reason: "run_shell requires a non-empty command." };
  }

  const first = tokens[0] ?? "";
  if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(first) || /^\$[A-Za-z_][\w:.-]*=.*/.test(first)) {
    return { ok: false, reason: "run_shell does not allow leading environment or variable assignment." };
  }

  return { ok: true, tokens };
};

const splitShellInputBlock = (input: string) =>
  input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

const looksLikeUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

const isShellNonFileSystemTarget = (value: string) =>
  /^~(?:[\\/]|$)/.test(value) ||
  (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-zA-Z]:([\\/]|$)/.test(value));

const looksLikePathToken = (value: string) =>
  value.startsWith(".") ||
  value.startsWith("/") ||
  value.startsWith("\\") ||
  /^[a-zA-Z]:[\\/]/.test(value) ||
  value.includes("/") ||
  value.includes("\\");

const isRootLikeShellTarget = (value: string) =>
  /^(\/|\/*)$/.test(value) ||
  /^(\\+|\*\\?|\*\/?)$/.test(value) ||
  /^[a-zA-Z]:[\\/]?$/.test(value) ||
  /^[a-zA-Z]:[\\/]\*$/.test(value);

const hasRecursiveForceFlags = (commandName: string, tokens: string[]) => {
  const flags = tokens.slice(1).filter(token => token.startsWith("-"));
  if (commandName === "rm") {
    const normalized = flags.join(" ").toLowerCase();
    return (
      normalized.includes("-rf") ||
      normalized.includes("-fr") ||
      flags.some(flag => flag === "--recursive" || flag === "--force")
    );
  }
  return flags.some(flag => /^-recurse$/i.test(flag) || /^-force$/i.test(flag));
};

const getShellTargetOperands = (commandName: string, tokens: string[]) => {
  const operands = tokens.slice(1).filter(token => !token.startsWith("-"));
  switch (commandName) {
    case "mv":
    case "move-item":
    case "cp":
    case "copy-item":
    case "mkdir":
    case "md":
    case "touch":
    case "new-item":
    case "ni":
    case "set-content":
    case "add-content":
    case "out-file":
      return operands.length > 0 ? [operands[operands.length - 1] ?? ""] : [];
    default:
      return operands;
  }
};

const looksLikeVenvActivationTarget = (value: string) =>
  /(^|\/)\.venv\/.*\/activate(\.ps1)?$/i.test(value.replace(/\\/g, "/"));

const getShellSessionStatus = (session: ActiveShellSession | null): ShellSessionStatus => {
  if (!session) {
    return "none";
  }
  if (session.exited || !session.alive) {
    return "exited";
  }
  return session.busy ? "running" : "idle";
};

const formatShellExitCode = (exitCode: number | null) =>
  exitCode === null ? "unknown" : String(exitCode);

const buildShellCommandWrapper = (
  shell: PersistentShellFlavor,
  input: string,
  commandId: string
) => {
  if (shell === "pwsh") {
    return [
      "& {",
      input,
      "$cyreneSuccess = $?",
      "$cyreneExit = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } elseif ($cyreneSuccess) { 0 } else { 1 }",
      "$cyrenePwd = (Get-Location).Path",
      `Write-Output "${buildShellStatusMarker(commandId, "$cyreneExit")}"`,
      `Write-Output "${buildShellCwdMarker(commandId, "$cyrenePwd")}"`,
      "}",
      "",
    ].join("\n");
  }

  return [
    "{",
    input,
    "__cyrene_exit=$?",
    "__cyrene_pwd=$(pwd)",
    `printf '%s\\n' "${buildShellStatusMarker(commandId, "$__cyrene_exit")}"`,
    `printf '%s\\n' "${buildShellCwdMarker(commandId, "$__cyrene_pwd")}"`,
    "}",
    "",
  ].join("\n");
};

const appendBoundedOutput = (
  current: string,
  incoming: string,
  maxChars: number
) => {
  if (!incoming) {
    return { text: current, truncated: false };
  }
  if (current.length >= maxChars) {
    return { text: current, truncated: true };
  }
  const remaining = maxChars - current.length;
  if (incoming.length <= remaining) {
    return { text: current + incoming, truncated: false };
  }
  return {
    text: current + incoming.slice(0, remaining),
    truncated: true,
  };
};

const collectRecords = (input: unknown, maxDepth = 4): Record<string, unknown>[] => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const records: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const record = toRecord(current.value);
    if (!record || seen.has(record)) {
      continue;
    }
    seen.add(record);
    records.push(record);

    if (current.depth >= maxDepth) {
      continue;
    }

    for (const key of WRAPPER_KEYS) {
      if (key in record) {
        queue.push({
          value: record[key],
          depth: current.depth + 1,
        });
      }
    }
  }

  return records;
};

const resolveRecordAction = (
  record: Record<string, unknown>,
  toolName: string
): ToolRequest["action"] | null =>
  normalizeAction(record.action) ??
  normalizeAction(record.operation) ??
  normalizeAction(record.op) ??
  normalizeAction(record.command) ??
  normalizeAction(record.method) ??
  normalizeAction(record.name) ??
  normalizeAction(toolName);

const buildSearchInputGuidance = (
  action: "find_files" | "search_text" | "search_text_context",
  field: "pattern" | "query"
) =>
  `Invalid tool input for ${action}: ${action} requires \`${field}\`. Use \`path: "."\` when searching the whole workspace and omit unrelated empty fields.`;

const buildNormalizedFileRequest = (
  action: FileAction,
  record: Record<string, unknown>,
  path: string | undefined,
  content: string | undefined,
  find: string | undefined,
  replace: string | undefined,
  rawArgs: string[] | undefined,
  explicitPaths: string[] | undefined
): ToolRequest | null => {
  const destination = pickString(record, ["destination", "dest", "to", "target_path"]);
  const pattern =
    pickString(record, ["pattern", "glob"]) ?? pickFirstNonEmptyValue(rawArgs);
  const symbol =
    pickString(record, ["symbol", "name", "identifier"]) ??
    pickString(record, ["query", "needle"]);
  const query = pickString(record, ["query", "needle"]) ?? pickFirstNonEmptyValue(rawArgs);
  const workspaceSymbolQuery =
    pickString(record, ["query", "needle", "symbol", "name"]) ??
    pickFirstNonEmptyValue(rawArgs);
  const revision = pickString(record, ["revision", "rev", "commit", "ref"]);
  const newName = pickString(record, ["newName", "new_name", "renameTo", "rename_to"]);
  const serverId = pickString(record, ["serverId", "server_id", "lspServer", "lsp_server"]);
  const title = pickString(record, ["title", "name", "label"]);
  const kind = pickString(record, ["kind", "actionKind", "action_kind"]);
  const jsonPath = pickString(record, ["jsonPath", "json_path", "pointer", "key"]);
  const yamlPath = pickString(record, ["yamlPath", "yaml_path", "pointer", "key"]);
  const maxResults = normalizeSearchLimit(
    pickNumber(record, ["maxResults", "max_results", "limit"])
  );
  const caseSensitive = pickBoolean(record, ["caseSensitive", "case_sensitive"]);
  const findInComments = pickBoolean(record, ["findInComments", "find_in_comments"]);
  const findInStrings = pickBoolean(record, ["findInStrings", "find_in_strings"]);
  const startLine = normalizePositiveInteger(
    pickNumber(record, ["startLine", "start_line", "lineStart", "line_start"])
  );
  const endLine = normalizePositiveInteger(
    pickNumber(record, ["endLine", "end_line", "lineEnd", "line_end"])
  );
  const line = normalizePositiveInteger(
    pickNumber(record, ["line", "lineNumber", "line_number"])
  );
  const column = normalizePositiveInteger(
    pickNumber(record, ["column", "col", "character", "offset"])
  );
  const before = normalizeNonNegativeInteger(
    pickNumber(record, ["before", "contextBefore", "context_before"])
  );
  const after = normalizeNonNegativeInteger(
    pickNumber(record, ["after", "contextAfter", "context_after"])
  );
  const tabSize = normalizePositiveInteger(
    pickNumber(record, ["tabSize", "tab_size"])
  );
  const insertSpaces = pickBoolean(record, ["insertSpaces", "insert_spaces"]);
  const hasStartLine = hasRecordValue(record, [
    "startLine",
    "start_line",
    "lineStart",
    "line_start",
  ]);
  const hasEndLine = hasRecordValue(record, [
    "endLine",
    "end_line",
    "lineEnd",
    "line_end",
  ]);

  switch (action) {
    case "read_file":
    case "list_dir":
    case "create_dir":
    case "delete_file":
    case "stat_path":
    case "outline_file":
    case "git_status":
    case "git_diff":
      if (!path) {
        return null;
      }
      return { action, path };
    case "read_json":
      if (!path) {
        return null;
      }
      return {
        action,
        path,
        jsonPath,
      };
    case "read_yaml":
      if (!path) {
        return null;
      }
      return {
        action,
        path,
        yamlPath,
      };
    case "read_files": {
      const targets = buildReadFilesTargets(path, explicitPaths);
      if (targets.length === 0) {
        return null;
      }
      return {
        action,
        path: targets[0] ?? ".",
        paths: targets.slice(1),
      };
    }
    case "read_range":
      if (!path || typeof startLine !== "number" || typeof endLine !== "number") {
        return null;
      }
      return {
        action,
        path,
        startLine,
        endLine,
      };
    case "stat_paths": {
      const targets = buildStatPathsTargets(path, explicitPaths);
      if (targets.length === 0) {
        return null;
      }
      return {
        action,
        path: targets[0] ?? ".",
        paths: targets.slice(1),
      };
    }
    case "create_file":
      if (!path) {
        return null;
      }
      return { action, path, content };
    case "write_file":
      if (!path) {
        return null;
      }
      return { action, path, content };
    case "edit_file":
    case "apply_patch":
      if (!path) {
        return null;
      }
      return {
        action,
        path,
        find,
        replace,
      };
    case "find_files":
      if (!pattern) {
        return null;
      }
      return {
        action,
        path: path ?? ".",
        pattern,
        maxResults,
        caseSensitive,
      };
    case "find_symbol":
    case "find_references":
      if (!symbol) {
        return null;
      }
      return {
        action,
        path: path ?? ".",
        symbol,
        maxResults,
        caseSensitive,
      };
    case "search_text":
      if (!query) {
        return null;
      }
      return {
        action,
        path: path ?? ".",
        query,
        maxResults,
        caseSensitive,
      };
    case "search_text_context":
      if (!query) {
        return null;
      }
      return {
        action,
        path: path ?? ".",
        query,
        before,
        after,
        maxResults,
        caseSensitive,
      };
    case "git_log":
      return {
        action,
        path: path ?? ".",
        maxResults: normalizeGitLogLimit(
          pickNumber(record, ["maxResults", "max_results", "limit"])
        ),
      };
    case "git_show":
      if (!revision) {
        return null;
      }
      return {
        action,
        path: path ?? ".",
        revision,
      };
    case "git_blame": {
      if (!path) {
        return null;
      }
      if ((hasStartLine && typeof startLine !== "number") || (hasEndLine && typeof endLine !== "number")) {
        return null;
      }
      const normalizedStart = startLine ?? endLine;
      const normalizedEnd = endLine ?? startLine;
      return {
        action,
        path,
        startLine: normalizedStart,
        endLine: normalizedEnd,
      };
    }
    case "ts_hover":
    case "ts_definition":
      if (!path || typeof line !== "number" || typeof column !== "number") {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
      };
    case "ts_references":
      if (!path || typeof line !== "number" || typeof column !== "number") {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        maxResults,
      };
    case "ts_diagnostics":
      if (!path) {
        return null;
      }
      return {
        action,
        path,
        maxResults,
      };
    case "ts_prepare_rename":
      if (
        !path ||
        typeof line !== "number" ||
        typeof column !== "number" ||
        !newName
      ) {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        newName,
        findInComments,
        findInStrings,
        maxResults,
      };
    case "lsp_hover":
    case "lsp_definition":
    case "lsp_implementation":
    case "lsp_type_definition":
      if (!path || typeof line !== "number" || typeof column !== "number") {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        serverId,
      };
    case "lsp_references":
      if (!path || typeof line !== "number" || typeof column !== "number") {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        serverId,
        maxResults,
      };
    case "lsp_workspace_symbols":
      if (!workspaceSymbolQuery) {
        return null;
      }
      return {
        action,
        path: path ?? ".",
        query: workspaceSymbolQuery,
        serverId,
        maxResults,
      };
    case "lsp_document_symbols":
    case "lsp_diagnostics":
      if (!path) {
        return null;
      }
      return {
        action,
        path,
        serverId,
        maxResults,
      };
    case "lsp_prepare_rename":
      if (
        !path ||
        typeof line !== "number" ||
        typeof column !== "number" ||
        !newName
      ) {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        newName,
        serverId,
        maxResults,
      };
    case "lsp_rename":
      if (
        !path ||
        typeof line !== "number" ||
        typeof column !== "number" ||
        !newName
      ) {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        newName,
        serverId,
        maxResults,
      };
    case "lsp_code_actions":
      if (!path || typeof line !== "number" || typeof column !== "number") {
        return null;
      }
      return {
        action,
        path,
        line,
        column,
        serverId,
        maxResults,
        title,
        kind,
      };
    case "lsp_format_document":
      if (!path) {
        return null;
      }
      return {
        action,
        path,
        serverId,
        tabSize,
        insertSpaces,
        maxResults,
      };
    case "copy_path":
    case "move_path":
      if (!path || !destination) {
        return null;
      }
      return {
        action,
        path,
        destination,
      };
  }
};

const normalizeFromRecord = (
  record: Record<string, unknown>,
  toolName: string
): ToolRequest | null => {
  let action = resolveRecordAction(record, toolName);
  const path = pickString(record, [
    "path",
    "file",
    "file_path",
    "filepath",
    "target",
    "dir",
    "directory",
  ]);
  const cwd = pickString(record, ["cwd", "working_directory", "workdir"]);
  const rawArgs = pickStringArray(record, ["args", "argv", "arguments"]);
  const explicitPaths = pickStringArray(record, [
    "paths",
    "files",
    "file_paths",
    "filepaths",
  ]);
  const rawCommand = pickString(record, ["command", "cmd", "program", "executable"]);
  const shellInput = pickString(record, ["input", "text", "line"]);
  const structuralContent = pickString(record, [
    "content",
    "contents",
    "value",
    "data",
    "body",
    "code",
    "fileContent",
    "file_content",
  ]);
  const find = pickString(record, [
    "find",
    "from",
    "old",
    "before",
    "oldText",
    "old_text",
    "search",
    "searchText",
    "search_text",
  ]);
  const replace = pickString(record, [
    "replace",
    "new",
    "after",
    "newText",
    "new_text",
    "replacement",
    "replacementText",
    "replacement_text",
  ]);

  if (action === "run_command" || ["command", "exec"].includes(toolName)) {
    const tokens = rawCommand ? tokenizeCommand(rawCommand) : [];
    const command = tokens[0];
    const args = rawArgs ?? tokens.slice(1);
    if (!command) {
      return null;
    }
    const display = [command, ...args].join(" ").trim();
    return {
      action: "run_command",
      command,
      args,
      cwd,
      path: path ?? (display || command),
    };
  }

  if (action === "run_shell") {
    if (!rawCommand) {
      return null;
    }
    return {
      action: "run_shell",
      command: rawCommand.trim(),
      cwd,
      path: path ?? ".",
    };
  }

  if (action === "open_shell") {
    return {
      action: "open_shell",
      cwd,
      path: path ?? ".",
    };
  }

  if (action === "write_shell") {
    if (!shellInput) {
      return null;
    }
    return {
      action: "write_shell",
      input: shellInput.trim(),
      path: path ?? ".",
    };
  }

  if (action === "read_shell") {
    return {
      action: "read_shell",
      path: path ?? ".",
    };
  }

  if (action === "shell_status") {
    return {
      action: "shell_status",
      path: path ?? ".",
    };
  }

  if (action === "interrupt_shell") {
    return {
      action: "interrupt_shell",
      path: path ?? ".",
    };
  }

  if (action === "close_shell") {
    return {
      action: "close_shell",
      path: path ?? ".",
    };
  }

  if (!action) {
    if (path && pickString(record, ["destination", "dest", "to", "target_path"])) {
      action = "move_path";
    } else if (path && pickString(record, ["revision", "rev", "commit", "ref"])) {
      action = "git_show";
    } else if (
      path &&
      typeof normalizePositiveInteger(
        pickNumber(record, ["startLine", "start_line", "lineStart", "line_start"])
      ) === "number" &&
      typeof normalizePositiveInteger(
        pickNumber(record, ["endLine", "end_line", "lineEnd", "line_end"])
      ) === "number"
    ) {
      action = "read_range";
    } else if (
      path &&
      pickString(record, ["symbol", "name", "identifier"])
    ) {
      action = "find_symbol";
    } else if (path && pickString(record, ["pattern", "glob"])) {
      action = "find_files";
    } else if (
      path &&
      pickString(record, ["query", "needle"]) &&
      (record.before !== undefined || record.after !== undefined)
    ) {
      action = "search_text_context";
    } else if (path && pickString(record, ["yamlPath", "yaml_path"])) {
      action = "read_yaml";
    } else if (path && pickString(record, ["jsonPath", "json_path", "pointer", "key"])) {
      action = "read_json";
    } else if (path && pickString(record, ["query", "needle"])) {
      action = "search_text";
    } else if (path && find && typeof replace === "string") {
      action = "edit_file";
    } else if (path && typeof structuralContent === "string") {
      action = "write_file";
    } else if (path) {
      action = "read_file";
    }
  }

  if (!action) {
    return null;
  }

  const content =
    action === "create_file" || action === "write_file"
      ? structuralContent ?? pickString(record, ["text"])
      : structuralContent;

  return buildNormalizedFileRequest(
    action as FileAction,
    record,
    path,
    content,
    find,
    replace,
    rawArgs,
    explicitPaths
  );
};

const summarizeInput = (input: unknown) => {
  if (typeof input === "string") {
    return clip(input, 240);
  }
  if (input && typeof input === "object") {
    const keys = Object.keys(input as Record<string, unknown>);
    let payload = "";
    try {
      payload = JSON.stringify(input);
    } catch {
      payload = String(input);
    }
    return `keys=[${keys.join(", ")}] payload=${clip(payload, 240)}`;
  }
  return String(input);
};

const normalizeToolInput = (
  toolName: string,
  input: unknown
): ToolRequest | null => {
  const records = collectRecords(input);
  if (records.length === 0) {
    return null;
  }

  let best: ToolRequest | null = null;
  let bestScore = -1;

  for (const record of records) {
    const normalized = normalizeFromRecord(record, toolName);
    if (!normalized) {
      continue;
    }
    const score =
      normalized.action === "run_command"
        ? 4 + normalized.args.length + (normalized.cwd ? 1 : 0)
        : normalized.action === "run_shell"
          ? 4 + (normalized.cwd ? 1 : 0)
        : normalized.action === "open_shell"
          ? 4 + (normalized.cwd ? 1 : 0)
        : normalized.action === "write_shell"
          ? 4 + normalized.input.length
        : normalized.action === "read_shell" ||
            normalized.action === "shell_status" ||
            normalized.action === "interrupt_shell" ||
            normalized.action === "close_shell"
          ? 3
        : 2 +
          (normalized.path ? 2 : 0) +
          ("paths" in normalized ? (normalized.paths?.length ?? 0) : 0) +
          ("content" in normalized ? 1 : 0) +
          ("find" in normalized ? 1 : 0) +
          ("replace" in normalized ? 1 : 0) +
          ("destination" in normalized ? 2 : 0) +
          ("startLine" in normalized ? 2 : 0) +
          ("endLine" in normalized ? 2 : 0) +
          ("line" in normalized ? 2 : 0) +
          ("column" in normalized ? 2 : 0) +
          ("newName" in normalized ? 2 : 0) +
          ("serverId" in normalized && normalized.serverId ? 1 : 0) +
          ("jsonPath" in normalized && normalized.jsonPath ? 1 : 0) +
          ("yamlPath" in normalized && normalized.yamlPath ? 1 : 0) +
          ("pattern" in normalized ? 2 : 0) +
          ("symbol" in normalized ? 2 : 0) +
          ("query" in normalized ? 2 : 0) +
          ("before" in normalized ? 1 : 0) +
          ("after" in normalized ? 1 : 0) +
          ("revision" in normalized ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = normalized;
    }
  }

  return best;
};

const describeInvalidToolInput = (toolName: string, input: unknown) => {
  const records = collectRecords(input);

  for (const record of records) {
    const action = resolveRecordAction(record, toolName);
    const rawArgs = pickStringArray(record, ["args", "argv", "arguments"]);

    if (action === "find_files") {
      const pattern =
        pickString(record, ["pattern", "glob"]) ?? pickFirstNonEmptyValue(rawArgs);
      if (!pattern) {
        return buildSearchInputGuidance("find_files", "pattern");
      }
    }

    if (action === "search_text") {
      const query =
        pickString(record, ["query", "needle"]) ?? pickFirstNonEmptyValue(rawArgs);
      if (!query) {
        return buildSearchInputGuidance("search_text", "query");
      }
    }

    if (action === "search_text_context") {
      const query =
        pickString(record, ["query", "needle"]) ?? pickFirstNonEmptyValue(rawArgs);
      if (!query) {
        return buildSearchInputGuidance("search_text_context", "query");
      }
    }

    if (action === "read_range") {
      const startLine = normalizePositiveInteger(
        pickNumber(record, ["startLine", "start_line", "lineStart", "line_start"])
      );
      const endLine = normalizePositiveInteger(
        pickNumber(record, ["endLine", "end_line", "lineEnd", "line_end"])
      );
      if (typeof startLine !== "number" || typeof endLine !== "number") {
        return "Invalid tool input for read_range: read_range requires `startLine` and `endLine` as 1-based inclusive integers.";
      }
    }

    if (action === "stat_paths") {
      const path = pickString(record, [
        "path",
        "file",
        "file_path",
        "filepath",
        "target",
        "dir",
        "directory",
      ]);
      const paths = pickStringArray(record, ["paths", "files", "file_paths", "filepaths"]);
      const targets = buildStatPathsTargets(path, paths);
      if (targets.length === 0) {
        return "Invalid tool input for stat_paths: provide at least one path via `path` or `paths`.";
      }
    }

    if (action === "find_symbol") {
      const symbol =
        pickString(record, ["symbol", "name", "identifier"]) ??
        pickString(record, ["query", "needle"]);
      if (!symbol) {
        return "Invalid tool input for find_symbol: find_symbol requires `symbol`.";
      }
    }

    if (action === "find_references") {
      const symbol =
        pickString(record, ["symbol", "name", "identifier"]) ??
        pickString(record, ["query", "needle"]);
      if (!symbol) {
        return "Invalid tool input for find_references: find_references requires `symbol`.";
      }
    }

    if (
      action === "ts_hover" ||
      action === "ts_definition" ||
      action === "ts_references" ||
      action === "lsp_hover" ||
      action === "lsp_definition" ||
      action === "lsp_implementation" ||
      action === "lsp_type_definition" ||
      action === "lsp_references" ||
      action === "lsp_code_actions"
    ) {
      const line = normalizePositiveInteger(
        pickNumber(record, ["line", "lineNumber", "line_number"])
      );
      const column = normalizePositiveInteger(
        pickNumber(record, ["column", "col", "character", "offset"])
      );
      if (typeof line !== "number" || typeof column !== "number") {
        return `Invalid tool input for ${action}: ${action} requires positive integer \`line\` and \`column\`.`;
      }
    }

    if (action === "lsp_workspace_symbols") {
      const query =
        pickString(record, ["query", "symbol", "name"]) ??
        pickFirstNonEmptyValue(
          Array.isArray(record.args) && record.args.every(item => typeof item === "string")
            ? (record.args as string[])
            : undefined
        );
      if (!query) {
        return "Invalid tool input for lsp_workspace_symbols: lsp_workspace_symbols requires `query`.";
      }
    }

    if (
      action === "ts_prepare_rename" ||
      action === "lsp_prepare_rename" ||
      action === "lsp_rename"
    ) {
      const line = normalizePositiveInteger(
        pickNumber(record, ["line", "lineNumber", "line_number"])
      );
      const column = normalizePositiveInteger(
        pickNumber(record, ["column", "col", "character", "offset"])
      );
      const newName = pickString(record, ["newName", "new_name", "renameTo", "rename_to"]);
      if (typeof line !== "number" || typeof column !== "number") {
        return `Invalid tool input for ${action}: ${action} requires positive integer \`line\` and \`column\`.`;
      }
      if (!newName) {
        return `Invalid tool input for ${action}: ${action} requires \`newName\`.`;
      }
    }

    if (action === "lsp_format_document") {
      const tabSize = pickNumber(record, ["tabSize", "tab_size"]);
      if (
        typeof tabSize === "number" &&
        (!Number.isInteger(tabSize) || tabSize <= 0)
      ) {
        return "Invalid tool input for lsp_format_document: lsp_format_document requires `tabSize` to be a positive integer when provided.";
      }
    }

    if (action === "git_show") {
      const revision = pickString(record, ["revision", "rev", "commit", "ref"]);
      if (!revision) {
        return "Invalid tool input for git_show: git_show requires `revision`.";
      }
    }

    if (action === "git_blame") {
      const hasStartLine = hasRecordValue(record, [
        "startLine",
        "start_line",
        "lineStart",
        "line_start",
      ]);
      const hasEndLine = hasRecordValue(record, [
        "endLine",
        "end_line",
        "lineEnd",
        "line_end",
      ]);
      const startLine = normalizePositiveInteger(
        pickNumber(record, ["startLine", "start_line", "lineStart", "line_start"])
      );
      const endLine = normalizePositiveInteger(
        pickNumber(record, ["endLine", "end_line", "lineEnd", "line_end"])
      );

      if ((hasStartLine && typeof startLine !== "number") || (hasEndLine && typeof endLine !== "number")) {
        return "Invalid tool input for git_blame: git_blame requires positive integer `startLine` / `endLine` when provided.";
      }

      const normalizedStart = startLine ?? endLine;
      const normalizedEnd = endLine ?? startLine;
      if (
        typeof normalizedStart === "number" &&
        typeof normalizedEnd === "number" &&
        normalizedStart > normalizedEnd
      ) {
        return "Invalid tool input for git_blame: git_blame requires `startLine` to be less than or equal to `endLine`.";
      }
    }

    if (action === "write_shell") {
      const shellInput = pickString(record, ["input", "text", "line"]);
      if (!shellInput) {
        return "Invalid tool input for write_shell: write_shell requires `input`.";
      }
    }
  }

  return null;
};

const validateRequest = (request: ToolRequest): string | null => {
  if (request.action === "run_command") {
    if (!request.command.trim()) {
      return "run_command requires `command`.";
    }
    return null;
  }

  if (request.action === "run_shell") {
    if (!request.command.trim()) {
      return "run_shell requires `command`.";
    }
    if (/[\r\n]/.test(request.command)) {
      return "run_shell does not accept multiline `command`. Use open_shell plus write_shell for multiline shell input.";
    }
    return null;
  }

  if (request.action === "open_shell") {
    return null;
  }

  if (request.action === "write_shell") {
    if (!request.input.trim()) {
      return "write_shell requires `input`.";
    }
    return null;
  }

  if (
    request.action === "read_shell" ||
    request.action === "shell_status" ||
    request.action === "interrupt_shell" ||
    request.action === "close_shell"
  ) {
    return null;
  }

  switch (request.action) {
    case "read_files": {
      const targets = buildReadFilesTargets(request.path, request.paths);
      if (targets.length === 0) {
        return "read_files requires at least one file path via `path` or `paths`.";
      }
      return null;
    }
    case "stat_paths": {
      const targets = buildStatPathsTargets(request.path, request.paths);
      if (targets.length === 0) {
        return "stat_paths requires at least one path via `path` or `paths`.";
      }
      return null;
    }
    case "read_range":
      if (!Number.isInteger(request.startLine) || request.startLine <= 0) {
        return "read_range requires a positive integer `startLine`.";
      }
      if (!Number.isInteger(request.endLine) || request.endLine <= 0) {
        return "read_range requires a positive integer `endLine`.";
      }
      if (request.startLine > request.endLine) {
        return "read_range requires `startLine` to be less than or equal to `endLine`.";
      }
      return null;
    case "read_json":
    case "read_yaml":
    case "create_file":
    case "create_dir":
    case "read_file":
    case "list_dir":
    case "delete_file":
    case "stat_path":
    case "outline_file":
    case "git_status":
    case "git_diff":
    case "git_log":
      return null;
    case "write_file":
      if (typeof request.content !== "string") {
        return "write_file requires `content`.";
      }
      return null;
    case "edit_file":
    case "apply_patch":
      if (!request.find) {
        return `${request.action} requires \`find\`.`;
      }
      if (typeof request.replace !== "string") {
        return `${request.action} requires \`replace\`.`;
      }
      return null;
    case "find_files":
      if (!request.pattern.trim()) {
        return "find_files requires `pattern`.";
      }
      return null;
    case "find_symbol":
    case "find_references":
      if (!request.symbol.trim()) {
        return `${request.action} requires \`symbol\`.`;
      }
      return null;
    case "search_text":
      if (!request.query.trim()) {
        return "search_text requires `query`.";
      }
      return null;
    case "search_text_context":
      if (!request.query.trim()) {
        return "search_text_context requires `query`.";
      }
      if (
        typeof request.before === "number" &&
        (!Number.isInteger(request.before) || request.before < 0)
      ) {
        return "search_text_context requires `before` to be a non-negative integer when provided.";
      }
      if (
        typeof request.after === "number" &&
        (!Number.isInteger(request.after) || request.after < 0)
      ) {
        return "search_text_context requires `after` to be a non-negative integer when provided.";
      }
      return null;
    case "git_show":
      if (!request.revision.trim()) {
        return "git_show requires `revision`.";
      }
      return null;
    case "git_blame": {
      const startLine = request.startLine ?? request.endLine;
      const endLine = request.endLine ?? request.startLine;
      if (typeof startLine === "number" || typeof endLine === "number") {
        if (!Number.isInteger(startLine) || !startLine || startLine <= 0) {
          return "git_blame requires `startLine` to be a positive integer when provided.";
        }
        if (!Number.isInteger(endLine) || !endLine || endLine <= 0) {
          return "git_blame requires `endLine` to be a positive integer when provided.";
        }
        if (startLine > endLine) {
          return "git_blame requires `startLine` to be less than or equal to `endLine`.";
        }
      }
      return null;
    }
    case "ts_hover":
    case "ts_definition":
    case "ts_references":
    case "lsp_hover":
    case "lsp_definition":
    case "lsp_implementation":
    case "lsp_type_definition":
    case "lsp_references":
    case "lsp_code_actions":
      if (!Number.isInteger(request.line) || request.line <= 0) {
        return `${request.action} requires a positive integer \`line\`.`;
      }
      if (!Number.isInteger(request.column) || request.column <= 0) {
        return `${request.action} requires a positive integer \`column\`.`;
      }
      if (
        (
          request.action === "ts_references" ||
          request.action === "lsp_references" ||
          request.action === "lsp_implementation" ||
          request.action === "lsp_type_definition" ||
          request.action === "lsp_code_actions"
        ) &&
        typeof request.maxResults === "number" &&
        (!Number.isInteger(request.maxResults) || request.maxResults <= 0)
      ) {
        return `${request.action} requires \`maxResults\` to be a positive integer when provided.`;
      }
      if (
        request.action === "lsp_code_actions" &&
        typeof request.title === "string" &&
        !request.title.trim()
      ) {
        return "lsp_code_actions requires `title` to be non-empty when provided.";
      }
      return null;
    case "lsp_workspace_symbols":
      if (!request.query.trim()) {
        return "lsp_workspace_symbols requires `query`.";
      }
      if (
        typeof request.maxResults === "number" &&
        (!Number.isInteger(request.maxResults) || request.maxResults <= 0)
      ) {
        return "lsp_workspace_symbols requires `maxResults` to be a positive integer when provided.";
      }
      return null;
    case "ts_diagnostics":
    case "lsp_document_symbols":
    case "lsp_diagnostics":
      if (
        typeof request.maxResults === "number" &&
        (!Number.isInteger(request.maxResults) || request.maxResults <= 0)
      ) {
        return `${request.action} requires \`maxResults\` to be a positive integer when provided.`;
      }
      return null;
    case "ts_prepare_rename":
    case "lsp_prepare_rename":
    case "lsp_rename":
      if (!Number.isInteger(request.line) || request.line <= 0) {
        return `${request.action} requires a positive integer \`line\`.`;
      }
      if (!Number.isInteger(request.column) || request.column <= 0) {
        return `${request.action} requires a positive integer \`column\`.`;
      }
      if (!request.newName.trim()) {
        return `${request.action} requires \`newName\`.`;
      }
      if (
        typeof request.maxResults === "number" &&
        (!Number.isInteger(request.maxResults) || request.maxResults <= 0)
      ) {
        return `${request.action} requires \`maxResults\` to be a positive integer when provided.`;
      }
      return null;
    case "lsp_format_document":
      if (
        typeof request.tabSize === "number" &&
        (!Number.isInteger(request.tabSize) || request.tabSize <= 0)
      ) {
        return "lsp_format_document requires `tabSize` to be a positive integer when provided.";
      }
      if (
        typeof request.maxResults === "number" &&
        (!Number.isInteger(request.maxResults) || request.maxResults <= 0)
      ) {
        return "lsp_format_document requires `maxResults` to be a positive integer when provided.";
      }
      return null;
    case "copy_path":
    case "move_path":
      if (!request.destination.trim()) {
        return `${request.action} requires \`destination\`.`;
      }
      return null;
  }
};

const isPendingConflictAction = (action: FileAction) =>
  PENDING_CONFLICT_ACTIONS.includes(action);

const clipSnippet = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return clip(normalized, MAX_SEARCH_SNIPPET_CHARS);
};

const clipContextLine = (text: string) =>
  clip(text.replace(/\t/g, "  "), MAX_SEARCH_SNIPPET_CHARS);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isLspCodeActionApplyRequest = (
  request: ToolRequest
): request is LspCodeActionsToolRequest =>
  request.action === "lsp_code_actions" &&
  typeof request.title === "string" &&
  request.title.trim().length > 0;

const isMutatingLspRequest = (request: ToolRequest) =>
  request.action === "lsp_rename" ||
  request.action === "lsp_format_document" ||
  isLspCodeActionApplyRequest(request);

const isReadOnlyRequest = (request: ToolRequest) =>
  READ_ONLY_ACTION_SET.has(request.action) ||
  (request.action === "lsp_code_actions" && !isLspCodeActionApplyRequest(request));

const splitFileLines = (content: string) => {
  if (content.length === 0) {
    return [] as string[];
  }
  const lines = content.split(/\r?\n/);
  if (/\r?\n$/.test(content)) {
    lines.pop();
  }
  return lines;
};

const formatNumberedLines = (lines: string[], startLine: number) =>
  lines
    .map((line, index) => {
      const lineNo = String(startLine + index).padStart(lineNoWidth, " ");
      return `  ${lineNo} | ${line}`;
    })
    .join("\n");

const formatContextWindow = (
  lines: string[],
  hitIndex: number,
  before: number,
  after: number
) => {
  const start = Math.max(0, hitIndex - before);
  const end = Math.min(lines.length - 1, hitIndex + after);
  const window: string[] = [];

  for (let index = start; index <= end; index += 1) {
    const lineNo = String(index + 1).padStart(lineNoWidth, " ");
    const marker = index === hitIndex ? ">" : " ";
    window.push(`${marker} ${lineNo} | ${clipContextLine(lines[index] ?? "")}`);
  }

  return window.join("\n");
};

const formatContextLineAtNumber = (
  lineNumber: number,
  line: string,
  marker: ">" | " "
) => `${marker} ${String(lineNumber).padStart(lineNoWidth, " ")} | ${clipContextLine(line)}`;

const parseStructuredPathSegments = (input: string) => {
  const normalized = input.trim().replace(/^\$\./, "").replace(/^\$/, "");
  if (!normalized) {
    return [] as string[];
  }

  return normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map(segment => segment.trim())
    .filter(Boolean);
};

const formatStructuredValue = (value: unknown) =>
  typeof value === "string"
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2) ?? String(value);

const OUTLINE_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?class\s+[A-Za-z_$][\w$]*/,
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/,
  /^(?:export\s+)?interface\s+[A-Za-z_$][\w$]*/,
  /^(?:export\s+)?type\s+[A-Za-z_$][\w$]*/,
  /^(?:export\s+)?enum\s+[A-Za-z_$][\w$]*/,
  /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^=]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^(?:async\s+)?def\s+[A-Za-z_][\w]*\s*\(/,
  /^class\s+[A-Za-z_][\w]*(?:\([^)]*\))?:/,
];

const getOutlineEntry = (line: string) => {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return null;
  }
  return OUTLINE_PATTERNS.some(pattern => pattern.test(trimmed)) ? trimmed : null;
};

const formatOutlineEntry = (line: string, index: number) => {
  const lineNo = String(index).padStart(lineNoWidth, " ");
  return `${lineNo} | ${clip(line, 160)}`;
};

const uniqueSorted = (values: string[]) =>
  Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );

const buildSymbolDefinitionPatterns = (symbol: string, flags: string) => [
  new RegExp(`^(?:export\\s+)?(?:default\\s+)?class\\s+${symbol}\\b`, flags),
  new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`, flags),
  new RegExp(`^(?:export\\s+)?interface\\s+${symbol}\\b`, flags),
  new RegExp(`^(?:export\\s+)?type\\s+${symbol}\\b`, flags),
  new RegExp(`^(?:export\\s+)?enum\\s+${symbol}\\b`, flags),
  new RegExp(
    `^(?:export\\s+)?const\\s+${symbol}\\s*=\\s*(?:async\\s*)?(?:\\([^=]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
    flags
  ),
  new RegExp(`^(?:async\\s+)?def\\s+${symbol}\\b`, flags),
  new RegExp(`^class\\s+${symbol}(?:\\(|:|\\s|$)`, flags),
];

const buildSymbolReferencePattern = (symbol: string, caseSensitive: boolean) =>
  new RegExp(`(^|[^A-Za-z0-9_$])${symbol}([^A-Za-z0-9_$]|$)`, caseSensitive ? "" : "i");

const globToRegExp = (pattern: string, caseSensitive: boolean) => {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
  }

  source += "$";
  return new RegExp(source, caseSensitive ? "" : "i");
};

export const isPathInsideWorkspaceRoot = (
  absolutePath: string,
  workspaceRoot: string,
  pathApi: Pick<typeof import("node:path"), "isAbsolute" | "relative" | "resolve"> = {
    isAbsolute,
    relative,
    resolve,
  }
) => {
  const normalizedRoot = pathApi.resolve(workspaceRoot);
  const normalizedAbsolute = pathApi.resolve(absolutePath);
  if (normalizedAbsolute === normalizedRoot) {
    return true;
  }

  const relativePath = pathApi.relative(normalizedRoot, normalizedAbsolute);
  return !/^\.\.(?:[\\/]|$)/.test(relativePath) && !pathApi.isAbsolute(relativePath);
};

const realpathNative = (targetPath: string) =>
  typeof realpathSync.native === "function"
    ? realpathSync.native(targetPath)
    : realpathSync(targetPath);

const resolvePathThroughRealAncestors = (targetPath: string) => {
  const absolutePath = resolve(targetPath);
  let ancestor = absolutePath;

  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      ancestor = parent;
    }
  }

  let realAncestor: string;
  try {
    realAncestor = realpathNative(ancestor);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`Path traverses a broken symbolic link: ${absolutePath}`);
    }
    throw error;
  }

  const remainder = relative(ancestor, absolutePath);
  return remainder && remainder !== "."
    ? resolve(realAncestor, remainder)
    : realAncestor;
};

export class FileMcpService {
  private pending = new Map<string, PendingReviewItem>();
  private pendingApprovalGuards = new Map<string, PendingApprovalGuard>();
  private recentListDir = new Map<
    string,
    { output: string; listedAt: number; mutationVersion: number }
  >();
  private filesystemMutationVersion = 0;
  private undoHistory: UndoEntry[] = [];
  private suppressUndoRecording = false;
  private shellSession: ActiveShellSession | null = null;
  private ptyFactoryPromise: Promise<PtyFactory> | null = null;
  private persistentShellFlavorPromise: Promise<PersistentShellFlavor> | null = null;
  private tsServerClient: TsServerClientLike | null;
  private lspManager: LspManagerLike | null;
  private readonly workspaceRootAbsolute: string;
  private readonly workspaceRootRealpath: string;

  constructor(
    private readonly rules: RuleConfig,
    private readonly options: FileMcpServiceOptions = {}
  ) {
    this.workspaceRootAbsolute = resolve(this.rules.workspaceRoot);
    this.workspaceRootRealpath = resolvePathThroughRealAncestors(
      this.workspaceRootAbsolute
    );
    this.tsServerClient = options.tsServerClient ?? null;
    this.lspManager = options.lspManager ?? null;
    if (process.platform === "win32") {
      this.prewarmPersistentShellRuntime();
    }
  }

  private toWorkspaceRelativePath(inputPath: string) {
    const raw = inputPath.trim();
    const hasDrivePrefix = /^[a-zA-Z]:[\\/]/.test(raw);
    const isUnc = /^\\\\/.test(raw);
    const isRootRelative = (raw.startsWith("/") || raw.startsWith("\\")) &&
      !hasDrivePrefix &&
      !isUnc;
    if (isRootRelative) {
      return raw.replace(/^[\\/]+/, "");
    }
    return raw;
  }

  private resolveAbsolutePathForContainment(absolutePath: string) {
    return resolvePathThroughRealAncestors(absolutePath);
  }

  private canAccessAbsolutePathInsideWorkspaceRoot(absolutePath: string) {
    try {
      return isPathInsideWorkspaceRoot(
        this.resolveAbsolutePathForContainment(absolutePath),
        this.workspaceRootRealpath
      );
    } catch {
      return false;
    }
  }

  private formatAbsolutePathForDisplay(absolutePath: string) {
    const normalizedAbsolute = resolve(absolutePath);
    if (this.canAccessAbsolutePathInsideWorkspaceRoot(normalizedAbsolute)) {
      const normalized = relative(this.workspaceRootAbsolute, normalizedAbsolute)
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "");
      return normalized || ".";
    }

    try {
      return this.resolveAbsolutePathForContainment(normalizedAbsolute).replace(/\\/g, "/");
    } catch {
      return normalizedAbsolute.replace(/\\/g, "/");
    }
  }

  private isShellTargetInsideWorkspace(cwd: string, token: string) {
    if (!token || token === "-") {
      return false;
    }
    if (isShellNonFileSystemTarget(token)) {
      return false;
    }
    return this.canAccessAbsolutePathInsideWorkspaceRoot(resolve(cwd, token));
  }

  private resolvePath(inputPath: string) {
    const normalized = this.toWorkspaceRelativePath(inputPath);
    const absolute = resolve(this.workspaceRootAbsolute, normalized);
    if (!this.canAccessAbsolutePathInsideWorkspaceRoot(absolute)) {
      throw new Error(
        `Path escapes workspace root: ${inputPath}. Use workspace-relative paths such as "test_files/...".`
      );
    }
    return absolute;
  }

  private normalizeWorkspacePath(inputPath: string) {
    const absolute = this.resolvePath(inputPath);
    const normalized = relative(this.workspaceRootAbsolute, absolute)
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    return normalized || ".";
  }

  private normalizeWorkspacePathFromAbsolute(absolutePath: string) {
    const normalized = relative(this.workspaceRootAbsolute, absolutePath)
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    return normalized || ".";
  }

  private getTsServerClient() {
    if (!this.tsServerClient) {
      this.tsServerClient = new TsServerClient({
        workspaceRoot: this.rules.workspaceRoot,
        requestTimeoutMs: this.options.tsToolTimeoutMs,
      });
    }
    return this.tsServerClient;
  }

  private invalidateTsServer(inputPath?: string) {
    if (!this.tsServerClient) {
      return;
    }
    if (!inputPath) {
      this.tsServerClient.invalidate();
      return;
    }
    try {
      this.tsServerClient.invalidate(this.resolvePath(inputPath));
    } catch {
      this.tsServerClient.invalidate();
    }
  }

  private async ensureTypescriptLanguageFile(path: string, absolutePath: string) {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error(`TypeScript semantic tools only support files: ${path}`);
    }
    if (!TYPESCRIPT_LANGUAGE_EXTENSIONS.test(path)) {
      throw new Error(
        `TypeScript semantic tools only support TS/JS files: ${path}`
      );
    }
  }

  private formatTsLocation(location: { line: number; offset: number }) {
    return `${location.line}:${location.offset}`;
  }

  private formatTsWorkspacePath(absolutePath: string) {
    return this.formatAbsolutePathForDisplay(absolutePath);
  }

  private async getFileLineSnippet(absolutePath: string, lineNumber: number) {
    if (!this.canAccessAbsolutePathInsideWorkspaceRoot(absolutePath)) {
      throw new Error(`Path escapes workspace root: ${absolutePath}`);
    }
    const content = await readFile(absolutePath, "utf8");
    const line = splitFileLines(content)[lineNumber - 1] ?? "";
    const trimmed = line.trim();
    return trimmed ? clipSnippet(trimmed) : "(blank line)";
  }

  private async formatTsFileSpan(span: TsServerFileSpan) {
    const absolutePath = resolve(span.file);
    const workspacePath = this.formatTsWorkspacePath(absolutePath);
    const snippet = await this.getFileLineSnippet(absolutePath, span.start.line).catch(
      () => ""
    );
    return [
      `${workspacePath}:${this.formatTsLocation(span.start)}-${this.formatTsLocation(span.end)}`,
      snippet ? `| ${snippet}` : "",
      span.unverified ? "[unverified]" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private formatTsTag(tag: { name: string; text?: string }) {
    return `- @${tag.name}${tag.text ? ` ${tag.text}` : ""}`;
  }

  private formatTsDiagnostic(
    diagnostic: TsServerDiagnostic,
    category: "syntactic" | "semantic" | "suggestion"
  ) {
    const workspacePath = this.formatTsWorkspacePath(diagnostic.file);
    const location = diagnostic.start
      ? `:${diagnostic.start.line}:${diagnostic.start.offset}`
      : "";
    return `[${category}] ${workspacePath}${location} | ${diagnostic.category} TS${diagnostic.code} | ${diagnostic.text}`;
  }

  private buildTsRenameReplacement(
    location: TsServerRenameLocation,
    newName: string
  ) {
    return `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}`;
  }

  private async formatTsRenameLocation(
    filePath: string,
    location: TsServerRenameLocation,
    newName: string
  ) {
    const absolutePath = resolve(filePath);
    const workspacePath = this.formatTsWorkspacePath(absolutePath);
    const snippet = await this.getFileLineSnippet(absolutePath, location.start.line).catch(
      () => ""
    );
    return [
      `${workspacePath}:${this.formatTsLocation(location.start)}-${this.formatTsLocation(location.end)}`,
      `=> ${this.buildTsRenameReplacement(location, newName)}`,
      snippet ? `| ${snippet}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private getTsLineStartOffsets(content: string) {
    const offsets = [0];
    for (let index = 0; index < content.length; index += 1) {
      const char = content.charCodeAt(index);
      if (char === 13) {
        if (content.charCodeAt(index + 1) === 10) {
          index += 1;
        }
        offsets.push(index + 1);
        continue;
      }
      if (char === 10) {
        offsets.push(index + 1);
      }
    }
    return offsets;
  }

  private getTsLineEndIndex(
    content: string,
    lineStarts: number[],
    lineNumber: number
  ) {
    const lineStart = lineStarts[lineNumber - 1];
    if (typeof lineStart !== "number") {
      throw new Error(`TypeScript rename location line out of range: ${lineNumber}`);
    }
    const nextLineStart =
      lineNumber < lineStarts.length
        ? (lineStarts[lineNumber] ?? content.length)
        : content.length;
    let lineEnd = nextLineStart;
    if (lineEnd > lineStart && content[lineEnd - 1] === "\n") {
      lineEnd -= 1;
    }
    if (lineEnd > lineStart && content[lineEnd - 1] === "\r") {
      lineEnd -= 1;
    }
    return lineEnd;
  }

  private tsLocationToIndex(
    content: string,
    lineStarts: number[],
    location: { line: number; offset: number }
  ) {
    if (
      !Number.isInteger(location.line) ||
      location.line < 1 ||
      !Number.isInteger(location.offset) ||
      location.offset < 1
    ) {
      throw new Error(
        `Invalid TypeScript rename location: ${location.line}:${location.offset}`
      );
    }
    const lineStart = lineStarts[location.line - 1];
    if (typeof lineStart !== "number") {
      throw new Error(`TypeScript rename location line out of range: ${location.line}`);
    }
    const lineEnd = this.getTsLineEndIndex(content, lineStarts, location.line);
    const index = lineStart + location.offset - 1;
    if (index > lineEnd) {
      throw new Error(
        `TypeScript rename location offset out of range: ${location.line}:${location.offset}`
      );
    }
    return index;
  }

  private applyTsRenameLocationsToContent(
    content: string,
    locations: TsServerRenameLocation[],
    newName: string
  ) {
    const lineStarts = this.getTsLineStartOffsets(content);
    const edits = locations
      .map(location => {
        const start = this.tsLocationToIndex(content, lineStarts, location.start);
        const end = this.tsLocationToIndex(content, lineStarts, location.end);
        if (end < start) {
          throw new Error(
            `TypeScript rename span is invalid: ${this.formatTsLocation(location.start)}-${this.formatTsLocation(location.end)}`
          );
        }
        return {
          start,
          end,
          replacement: this.buildTsRenameReplacement(location, newName),
        };
      })
      .sort((left, right) => right.start - left.start || right.end - left.end);

    let nextContent = content;
    let lastAppliedStart = Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    for (const edit of edits) {
      const key = `${edit.start}:${edit.end}:${edit.replacement}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (edit.end > lastAppliedStart) {
        throw new Error("TypeScript rename preview produced overlapping text spans.");
      }
      nextContent =
        nextContent.slice(0, edit.start) +
        edit.replacement +
        nextContent.slice(edit.end);
      lastAppliedStart = edit.start;
    }
    return nextContent;
  }

  private formatApplyPatchPlan(path: string, before: string, after: string) {
    return [
      `[apply_patch plan] ${path}`,
      "```json",
      JSON.stringify(
        {
          action: "apply_patch",
          path,
          find: before,
          replace: after,
        },
        null,
        2
      ),
      "```",
    ].join("\n");
  }

  private getLspManager() {
    if (!this.lspManager) {
      this.lspManager = new LspManager(
        this.rules.workspaceRoot,
        this.rules.lspServers ?? []
      );
    }
    return this.lspManager;
  }

  private invalidateLsp(inputPath?: string) {
    if (!this.lspManager) {
      return;
    }
    if (!inputPath) {
      this.lspManager.invalidate();
      return;
    }
    try {
      this.lspManager.invalidate(this.resolvePath(inputPath));
    } catch {
      this.lspManager.invalidate();
    }
  }

  private async ensureRegularFile(path: string, absolutePath: string, label: string) {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error(`${label} only support files: ${path}`);
    }
  }

  private formatLspPosition(position: { line: number; character: number }) {
    return `${position.line + 1}:${position.character + 1}`;
  }

  private formatLspRange(range: LspRange) {
    return `${this.formatLspPosition(range.start)}-${this.formatLspPosition(range.end)}`;
  }

  private getAbsolutePathFromLspUri(uri: string) {
    if (!uri.startsWith("file://")) {
      return null;
    }
    return resolve(pathFromLspUri(uri));
  }

  private async formatLspLocation(location: LspLocation, suffix?: string) {
    const absolutePath = this.getAbsolutePathFromLspUri(location.uri);
    const workspacePath = absolutePath
      ? this.formatTsWorkspacePath(absolutePath)
      : location.uri;
    const snippet = absolutePath
      ? await this.getFileLineSnippet(absolutePath, location.range.start.line + 1).catch(
          () => ""
        )
      : "";
    return [
      `${workspacePath}:${this.formatLspRange(location.range)}`,
      suffix ?? "",
      snippet ? `| ${snippet}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private formatLspDiagnostic(filePath: string, diagnostic: LspDiagnostic) {
    const workspacePath = this.formatTsWorkspacePath(resolve(filePath));
    const severity =
      diagnostic.severity === 1
        ? "error"
        : diagnostic.severity === 2
          ? "warning"
          : diagnostic.severity === 3
            ? "info"
            : diagnostic.severity === 4
              ? "hint"
              : "unknown";
    return [
      `[${severity}] ${workspacePath}:${this.formatLspPosition(diagnostic.range.start)}`,
      diagnostic.source ? `${diagnostic.source}` : "",
      diagnostic.code !== undefined ? `${diagnostic.code}` : "",
      `| ${diagnostic.message}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private flattenLspDocumentSymbols(
    symbols: LspDocumentSymbol[],
    depth = 0
  ): Array<{ symbol: LspDocumentSymbol; depth: number }> {
    const entries: Array<{ symbol: LspDocumentSymbol; depth: number }> = [];
    for (const symbol of symbols) {
      entries.push({ symbol, depth });
      if (symbol.children.length > 0) {
        entries.push(...this.flattenLspDocumentSymbols(symbol.children, depth + 1));
      }
    }
    return entries;
  }

  private formatLspDocumentSymbolEntry(symbol: LspDocumentSymbol, depth: number) {
    const indent = "  ".repeat(depth);
    const location = this.formatLspPosition(symbol.selectionRange?.start ?? symbol.range.start);
    return [
      `${indent}${symbol.name}`,
      symbol.detail ? `(${symbol.detail})` : "",
      `@ ${location}`,
      symbol.containerName ? `[${symbol.containerName}]` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private formatLspSymbolKind(kind: number) {
    return LSP_SYMBOL_KIND_LABELS[kind - 1] ?? `kind_${kind}`;
  }

  private async formatLspWorkspaceSymbolEntry(symbol: LspWorkspaceSymbol) {
    const locationText = symbol.location
      ? await this.formatLspLocation(symbol.location)
      : symbol.uri
        ? (() => {
            const absolutePath = this.getAbsolutePathFromLspUri(symbol.uri);
            return absolutePath ? this.formatTsWorkspacePath(absolutePath) : symbol.uri;
          })()
        : "";
    return [
      symbol.name,
      `(${this.formatLspSymbolKind(symbol.kind)})`,
      symbol.containerName ? `[${symbol.containerName}]` : "",
      locationText ? `@ ${locationText}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async getLspSessionForWorkspaceQuery(
    path: string,
    serverId?: string
  ) {
    const absolutePath = this.resolvePath(path);
    const info = await stat(absolutePath).catch(() => null);
    if (!info) {
      throw new Error(`LSP workspace query path does not exist: ${path}`);
    }
    if (info.isFile()) {
      return this.getLspManager().getSession(absolutePath, { serverId });
    }
    if (info.isDirectory()) {
      return this.getLspManager().getSessionForServer({ serverId });
    }
    throw new Error(`LSP workspace queries only support files or directories: ${path}`);
  }

  private lspPositionToIndex(
    content: string,
    lineStarts: number[],
    position: { line: number; character: number }
  ) {
    if (
      !Number.isInteger(position.line) ||
      position.line < 0 ||
      !Number.isInteger(position.character) ||
      position.character < 0
    ) {
      throw new Error(
        `Invalid LSP position: ${position.line}:${position.character}`
      );
    }
    const lineStart = lineStarts[position.line];
    if (typeof lineStart !== "number") {
      throw new Error(`LSP position line out of range: ${position.line}`);
    }
    const nextLineStart =
      position.line + 1 < lineStarts.length
        ? (lineStarts[position.line + 1] ?? content.length)
        : content.length;
    let lineEnd = nextLineStart;
    if (lineEnd > lineStart && content[lineEnd - 1] === "\n") {
      lineEnd -= 1;
    }
    if (lineEnd > lineStart && content[lineEnd - 1] === "\r") {
      lineEnd -= 1;
    }
    const index = lineStart + position.character;
    if (index > lineEnd) {
      throw new Error(
        `LSP position character out of range: ${position.line}:${position.character}`
      );
    }
    return index;
  }

  private applyLspTextEditsToContent(content: string, edits: LspTextEdit[]) {
    const lineStarts = this.getTsLineStartOffsets(content);
    const normalizedEdits = edits
      .map(edit => {
        const start = this.lspPositionToIndex(content, lineStarts, edit.range.start);
        const end = this.lspPositionToIndex(content, lineStarts, edit.range.end);
        if (end < start) {
          throw new Error(
            `LSP edit range is invalid: ${this.formatLspRange(edit.range)}`
          );
        }
        return {
          start,
          end,
          newText: edit.newText,
        };
      })
      .sort((left, right) => right.start - left.start || right.end - left.end);

    let nextContent = content;
    let lastAppliedStart = Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    for (const edit of normalizedEdits) {
      const key = `${edit.start}:${edit.end}:${edit.newText}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (edit.end > lastAppliedStart) {
        throw new Error("LSP rename preview produced overlapping text edits.");
      }
      nextContent =
        nextContent.slice(0, edit.start) +
        edit.newText +
        nextContent.slice(edit.end);
      lastAppliedStart = edit.start;
    }
    return nextContent;
  }

  private collectLspWorkspaceEdits(workspaceEdit: LspWorkspaceEdit) {
    const byUri = new Map<string, LspTextEdit[]>();
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      if (edits.length === 0) {
        continue;
      }
      byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
    }
    for (const change of workspaceEdit.documentChanges) {
      if (change.kind === "resource") {
        throw new Error(
          `LSP rename preview does not support resource operations: ${change.operation}`
        );
      }
      byUri.set(change.uri, [...(byUri.get(change.uri) ?? []), ...change.edits]);
    }
    return [...byUri.entries()].map(([uri, edits]) => ({ uri, edits }));
  }

  private async formatLspRenameEdit(uri: string, edit: LspTextEdit) {
    const absolutePath = this.getAbsolutePathFromLspUri(uri);
    if (!absolutePath) {
      throw new Error(`LSP rename preview does not support non-file URI edits: ${uri}`);
    }
    return this.formatLspLocation(
      {
        uri,
        range: edit.range,
      },
      `=> ${clipSnippet(edit.newText)}`
    );
  }

  private async buildLspWorkspaceEditPlan(workspaceEdit: LspWorkspaceEdit) {
    const files: LspWorkspaceFileEditPlan[] = [];
    const skippedPaths: string[] = [];
    const groupedEdits = this.collectLspWorkspaceEdits(workspaceEdit);
    let totalEdits = 0;

    for (const group of groupedEdits) {
      totalEdits += group.edits.length;
      const filePath = this.getAbsolutePathFromLspUri(group.uri);
      if (!filePath) {
        throw new Error(`LSP workspace edit does not support non-file URI edits: ${group.uri}`);
      }
      if (!this.canAccessAbsolutePathInsideWorkspaceRoot(filePath)) {
        skippedPaths.push(this.formatTsWorkspacePath(filePath));
        continue;
      }
      const before = await readFile(filePath, "utf8");
      const after = this.applyLspTextEditsToContent(before, group.edits);
      if (before === after) {
        continue;
      }
      files.push({
        uri: group.uri,
        filePath,
        workspacePath: this.normalizeWorkspacePathFromAbsolute(filePath),
        edits: group.edits,
        before,
        after,
      });
    }

    return {
      files,
      skippedPaths,
      totalEdits,
    } satisfies LspWorkspaceEditPlan;
  }

  private async applyLspWorkspaceEditPlan(
    request: ToolRequest,
    plan: LspWorkspaceEditPlan
  ) {
    if (plan.skippedPaths.length > 0) {
      throw new Error(
        `LSP workspace edit includes ${plan.skippedPaths.length} path(s) outside the workspace: ${plan.skippedPaths
          .slice(0, 5)
          .join(", ")}`
      );
    }

    if (plan.files.length === 0) {
      return 0;
    }

    const undoFiles = await Promise.all(
      plan.files.map(async file => ({
        path: file.workspacePath,
        existedBefore: true,
        content: await readFile(file.filePath),
      }))
    );

    for (const file of plan.files) {
      await writeFile(file.filePath, file.after, "utf8");
    }

    this.pushUndoEntry({
      kind: "restore_workspace",
      files: undoFiles,
      sourceAction: request.action,
    });
    this.noteFilesystemMutation();
    return plan.files.length;
  }

  private async ensureLspWorkspaceEditPlanFresh(plan: LspWorkspaceEditPlan) {
    const driftedPaths: string[] = [];

    for (const file of plan.files) {
      const current = await readFile(file.filePath, "utf8").catch(error => {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (current !== file.before) {
        driftedPaths.push(file.workspacePath);
      }
    }

    if (driftedPaths.length > 0) {
      throw new Error(
        [
          `LSP review is stale: ${driftedPaths.length} file(s) changed after preview.`,
          ...driftedPaths.slice(0, 5).map(path => `- ${path}`),
          driftedPaths.length > 5
            ? `- ... ${driftedPaths.length - 5} more file(s)`
            : "",
          "Re-run the LSP action to refresh the preview before approving.",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  private formatResolvedLspRenameReviewDetails(
    request: LspRenameToolRequest,
    resolved: ResolvedLspRenamePlan,
    mode: "summary" | "full"
  ) {
    const { session, prepare, workspaceEdit, plan } = resolved;
    return [
      "[lsp rename preview]",
      `server: ${session.getInfo().serverId}`,
      `path: ${request.path}`,
      `position: ${request.line}:${request.column}`,
      `symbol: ${prepare?.placeholder ?? "(unavailable)"}`,
      `rename_to: ${request.newName}`,
      workspaceEdit ? "workspace_edit: ready" : "workspace_edit: unavailable",
      ...(plan
        ? [
            `files: ${plan.files.length}`,
            `edits: ${plan.totalEdits}`,
            ...this.formatLspWorkspaceEditDiffPreview(plan, mode),
            ...(plan.skippedPaths.length > 0
              ? [
                  `skipped_outside_workspace: ${plan.skippedPaths.length}`,
                  ...plan.skippedPaths.slice(0, 5).map(path => `- ${path}`),
                ]
              : []),
          ]
        : []),
    ].join("\n");
  }

  private formatResolvedLspCodeActionReviewDetails(
    request: LspCodeActionsToolRequest,
    resolved: ResolvedLspCodeActionPlan,
    mode: "summary" | "full"
  ) {
    const { session, actions, selectedAction, plan } = resolved;
    return [
      "[lsp code action preview]",
      `server: ${session.getInfo().serverId}`,
      `path: ${request.path}`,
      `position: ${request.line}:${request.column}`,
      `title: ${request.title}`,
      request.kind ? `kind_filter: ${request.kind}` : "",
      selectedAction?.kind ? `kind: ${selectedAction.kind}` : "",
      selectedAction?.isPreferred ? "preferred: true" : "",
      selectedAction?.disabledReason
        ? `disabled: ${selectedAction.disabledReason}`
        : selectedAction
          ? "disabled: false"
          : "",
      !selectedAction
        ? `match: not found (${actions.length} available action(s))`
        : selectedAction.edit
          ? "workspace_edit: ready"
          : selectedAction.hasCommand
            ? "workspace_edit: command-only (not supported yet)"
            : "workspace_edit: none",
      ...(plan
        ? [
            `files: ${plan.files.length}`,
            `edits: ${plan.totalEdits}`,
            ...this.formatLspWorkspaceEditDiffPreview(plan, mode),
            ...(plan.skippedPaths.length > 0
              ? [
                  `skipped_outside_workspace: ${plan.skippedPaths.length}`,
                  ...plan.skippedPaths.slice(0, 5).map(path => `- ${path}`),
                ]
              : []),
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatResolvedLspFormatDocumentReviewDetails(
    request: LspFormatDocumentToolRequest,
    resolved: ResolvedLspFormatDocumentPlan,
    mode: "summary" | "full"
  ) {
    const { session, plan } = resolved;
    return [
      "[lsp format preview]",
      `server: ${session.getInfo().serverId}`,
      `path: ${request.path}`,
      typeof request.tabSize === "number" ? `tab_size: ${request.tabSize}` : "",
      typeof request.insertSpaces === "boolean"
        ? `insert_spaces: ${request.insertSpaces}`
        : "",
      `files: ${plan.files.length}`,
      `edits: ${plan.totalEdits}`,
      ...this.formatLspWorkspaceEditDiffPreview(plan, mode),
      ...(plan.skippedPaths.length > 0
        ? [
            `skipped_outside_workspace: ${plan.skippedPaths.length}`,
            ...plan.skippedPaths.slice(0, 5).map(path => `- ${path}`),
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatLspWorkspaceEditDiffPreview(
    plan: LspWorkspaceEditPlan,
    mode: "summary" | "full"
  ) {
    if (plan.files.length === 0) {
      return ["changes: none"];
    }

    const maxFiles = mode === "summary" ? 2 : plan.files.length;
    const maxLinesPerFile = mode === "summary" ? 12 : 40;
    const previewLines: string[] = [];

    for (const file of plan.files.slice(0, maxFiles)) {
      const diff = summarizeMutationDiff(file.before, file.after);
      previewLines.push(`[file] ${file.workspacePath}`);
      previewLines.push(`diff_stats: +${diff.additions} -${diff.deletions}`);
      const lines = diff.previewLines.slice(0, maxLinesPerFile);
      if (lines.length > 0) {
        previewLines.push(...lines);
      }
      if (diff.previewLines.length > lines.length) {
        previewLines.push(`... ${diff.previewLines.length - lines.length} more diff line(s)`);
      }
    }

    if (plan.files.length > maxFiles) {
      previewLines.push(`... ${plan.files.length - maxFiles} more file(s)`);
    }
    return previewLines;
  }

  private formatLspWorkspaceApplyPlanBlocks(plan: LspWorkspaceEditPlan) {
    return plan.files.map(file =>
      this.formatApplyPatchPlan(file.workspacePath, file.before, file.after)
    );
  }

  private async resolveLspRenamePlan(request: LspPrepareRenameToolRequest | LspRenameToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const prepare = await session.prepareRename(
      absolutePath,
      request.line,
      request.column
    );
    if (!prepare) {
      return {
        session,
        prepare: null,
        workspaceEdit: null,
        plan: null,
      };
    }
    const workspaceEdit = await session.rename(
      absolutePath,
      request.line,
      request.column,
      request.newName
    );
    if (!workspaceEdit) {
      return {
        session,
        prepare,
        workspaceEdit: null,
        plan: null,
      };
    }
    return {
      session,
      prepare,
      workspaceEdit,
      plan: await this.buildLspWorkspaceEditPlan(workspaceEdit),
    };
  }

  private async listLspCodeActions(
    request: LspCodeActionsToolRequest
  ): Promise<{
    session: LspWorkspaceLike;
    absolutePath: string;
    actions: LspCodeAction[];
  }> {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const actions = await session.codeActions(
      absolutePath,
      request.line,
      request.column,
      request.kind ? { kind: request.kind } : undefined
    );
    return {
      session,
      absolutePath,
      actions,
    };
  }

  private findLspCodeActionByTitle(actions: LspCodeAction[], title: string) {
    const normalizedTitle = title.trim().toLowerCase();
    return (
      actions.find(action => action.title.trim() === title.trim()) ??
      actions.find(action => action.title.trim().toLowerCase() === normalizedTitle) ??
      null
    );
  }

  private async resolveLspCodeActionPlan(request: LspCodeActionsToolRequest) {
    const listed = await this.listLspCodeActions(request);
    const desiredTitle = request.title?.trim();
    if (!desiredTitle) {
      return {
        ...listed,
        selectedAction: null,
        plan: null,
      };
    }
    const selectedAction = this.findLspCodeActionByTitle(listed.actions, desiredTitle);
    if (!selectedAction) {
      return {
        ...listed,
        selectedAction: null,
        plan: null,
      };
    }
    return {
      ...listed,
      selectedAction,
      plan: selectedAction.edit
        ? await this.buildLspWorkspaceEditPlan(selectedAction.edit)
        : null,
    };
  }

  private async resolveLspFormatDocumentPlan(request: LspFormatDocumentToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const edits = await session.formatDocument(absolutePath, {
      tabSize: request.tabSize,
      insertSpaces: request.insertSpaces,
    });
    const workspaceEdit: LspWorkspaceEdit = {
      changes: edits.length > 0 ? { [pathToFileURL(absolutePath).href]: edits } : {},
      documentChanges: [],
    };
    return {
      session,
      edits,
      plan: await this.buildLspWorkspaceEditPlan(workspaceEdit),
    };
  }

  private async pathExists(inputPath: string) {
    try {
      await stat(this.resolvePath(inputPath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private getConflictKeys(request: ToolRequest) {
    if (
      request.action === "run_command" ||
      request.action === "run_shell" ||
      isPersistentShellAction(request.action) ||
      request.action === "create_dir" ||
      isReadOnlyRequest(request)
    ) {
      return [];
    }

    if (!isPendingConflictAction(request.action)) {
      return [];
    }

    const keys = new Set([this.normalizeWorkspacePath(request.path)]);
    if ("destination" in request) {
      keys.add(this.normalizeWorkspacePath(request.destination));
    }
    return [...keys];
  }

  private getPendingConflict(request: ToolRequest): PathConflict | null {
    const requestKeys = this.getConflictKeys(request);
    if (requestKeys.length === 0) {
      return null;
    }

    for (const item of this.pending.values()) {
      const itemKeys = this.getConflictKeys(item.request);
      if (itemKeys.length === 0) {
        continue;
      }
      if (!itemKeys.some(key => requestKeys.includes(key))) {
        continue;
      }
      return {
        action: item.request.action,
        path: this.normalizeWorkspacePath(item.request.path),
      };
    }

    return null;
  }

  private async validatePendingRequest(request: ToolRequest): Promise<string | null> {
    if (
      request.action === "run_command" ||
      request.action === "run_shell" ||
      isPersistentShellAction(request.action) ||
      request.action === "create_dir"
    ) {
      return null;
    }

    if (isReadOnlyRequest(request)) {
      return null;
    }

    const normalizedPath = this.normalizeWorkspacePath(request.path);

    switch (request.action) {
      case "create_file":
        if (await this.pathExists(request.path)) {
          return `create_file target already exists: ${normalizedPath}`;
        }
        return null;
      case "write_file":
        return null;
      case "edit_file":
      case "apply_patch": {
        if (!(await this.pathExists(request.path))) {
          return `${request.action} target does not exist: ${normalizedPath}`;
        }
        const before = await readFile(this.resolvePath(request.path), "utf8");
        if (!request.find || !before.includes(request.find)) {
          return `${request.action} find text not found: ${normalizedPath}`;
        }
        return null;
      }
      case "delete_file":
        if (!(await this.pathExists(request.path))) {
          return `delete_file target does not exist: ${normalizedPath}`;
        }
        return null;
      case "copy_path":
      case "move_path": {
        const destinationPath = this.normalizeWorkspacePath(request.destination);
        if (normalizedPath === destinationPath) {
          return `${request.action} destination must differ from source: ${normalizedPath}`;
        }
        if (!(await this.pathExists(request.path))) {
          return `${request.action} source does not exist: ${normalizedPath}`;
        }
        if (await this.pathExists(request.destination)) {
          return `${request.action} destination already exists: ${destinationPath}`;
        }
        return null;
      }
      case "lsp_rename":
      case "lsp_code_actions":
      case "lsp_format_document":
        if (!(await this.pathExists(request.path))) {
          return `${request.action} target does not exist: ${normalizedPath}`;
        }
        return null;
    }

    return null;
  }

  private auditShellRequest(request: ShellToolRequest): ShellAuditResult {
    const shell = getShellFlavor(request.command);
    const tokenized = tokenizeSafeShellCommand(request.command);
    if (!tokenized.ok) {
      return {
        ok: false,
        shell,
        tokens: [],
        risk: "high",
        reason: tokenized.reason,
        notes: ["Only a safe single-command shell subset is allowed."],
      };
    }

    const tokens = tokenized.tokens;
    const commandName = (tokens[0] ?? "").toLowerCase();
    const cwd = request.cwd
      ? this.resolvePath(request.cwd)
      : this.workspaceRootAbsolute;
    const targetTokens = getShellTargetOperands(commandName, tokens);

    if (["sudo", "su", "doas", "runas"].includes(commandName)) {
      return {
        ok: false,
        shell,
        tokens,
        risk: "high",
        reason: "run_shell blocks privilege-escalation commands.",
        notes: ["Privilege escalation is not allowed."],
      };
    }

    if (
      ["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(commandName)
    ) {
      return {
        ok: false,
        shell,
        tokens,
        risk: "high",
        reason: "run_shell blocks download-oriented commands in v1.",
        notes: ["Network download commands are treated as high risk."],
      };
    }

    if (
      SHELL_DELETE_COMMANDS.has(commandName) &&
      hasRecursiveForceFlags(commandName, tokens) &&
      targetTokens.some(token => isRootLikeShellTarget(token))
    ) {
      return {
        ok: false,
        shell,
        tokens,
        risk: "high",
        reason: "run_shell blocked a dangerous root deletion pattern.",
        notes: ["High-risk recursive deletion was detected."],
      };
    }

    if (targetTokens.some(token => looksLikeUrl(token))) {
      return {
        ok: false,
        shell,
        tokens,
        risk: "high",
        reason: "run_shell does not allow URL targets in workspace-mutating commands.",
        notes: ["Workspace-targeted shell actions must stay local."],
      };
    }

    if (
      targetTokens.some(token => {
        if (!looksLikePathToken(token) || isShellNonFileSystemTarget(token)) {
          return false;
        }
        return !this.isShellTargetInsideWorkspace(cwd, token);
      })
    ) {
      return {
        ok: false,
        shell,
        tokens,
        risk: "high",
        reason: SHELL_MUTATING_COMMANDS.has(commandName)
          ? "run_shell blocked a write or delete target outside the workspace root."
          : "run_shell blocked a file target outside the workspace root.",
        notes: ["Shell command targets must stay inside the workspace root."],
      };
    }

    const risk = SHELL_MUTATING_COMMANDS.has(commandName) ? "medium" : "low";
    return {
      ok: true,
      shell,
      tokens,
      risk,
      notes: [
        "Only a safe single-command shell subset is allowed.",
        risk === "medium"
          ? "This command may mutate workspace files and still requires review."
          : "This command is read-only or low-impact, but still requires review.",
      ],
    };
  }

  private auditSingleShellSessionInput(rawInput: string): ShellSessionWriteAuditResult {
    const session = this.shellSession;
    const shell = session?.shell ?? (process.platform === "win32" ? "pwsh" : "bash");
    const tokenized = tokenizeSafeShellCommand(rawInput);
    if (!tokenized.ok) {
      return {
        ok: false,
        shell,
        tokens: [],
        policy: "blocked",
        risk: "high",
        reason: tokenized.reason.replace(/^run_shell\b/, "write_shell"),
        notes: ["Only a safe reviewed shell subset is allowed."],
      };
    }

    const tokens = tokenized.tokens;
    const commandName = (tokens[0] ?? "").toLowerCase();
    const cwd = session?.cwd ?? this.workspaceRootAbsolute;
    const targetTokens = getShellTargetOperands(commandName, tokens);

    if (session && !this.canAccessAbsolutePathInsideWorkspaceRoot(cwd)) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason:
          "write_shell blocked because the persistent shell cwd escaped the workspace root. Use close_shell and open_shell again.",
        notes: ["Persistent shell state must stay inside the workspace root."],
      };
    }

    if (["sudo", "su", "doas", "runas"].includes(commandName)) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: "write_shell blocks privilege-escalation commands.",
        notes: ["Privilege escalation is not allowed."],
      };
    }

    if (["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(commandName)) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: "write_shell blocks download-oriented commands in v1.",
        notes: ["Network download commands are treated as high risk."],
      };
    }

    if (["exit", "logout", "quit"].includes(commandName)) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "medium",
        reason: "write_shell does not allow exit-style commands. Use close_shell instead.",
        notes: ["Close the persistent shell through the dedicated action."],
      };
    }

    if (
      SHELL_DELETE_COMMANDS.has(commandName) &&
      hasRecursiveForceFlags(commandName, tokens) &&
      targetTokens.some(token => isRootLikeShellTarget(token))
    ) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: "write_shell blocked a dangerous root deletion pattern.",
        notes: ["High-risk recursive deletion was detected."],
      };
    }

    if (targetTokens.some(token => looksLikeUrl(token))) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: "write_shell does not allow URL targets in workspace-mutating commands.",
        notes: ["Workspace-targeted shell actions must stay local."],
      };
    }

    if (
      targetTokens.some(token => {
        if (!looksLikePathToken(token) || isShellNonFileSystemTarget(token)) {
          return false;
        }
        return !this.isShellTargetInsideWorkspace(cwd, token);
      })
    ) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: SHELL_MUTATING_COMMANDS.has(commandName)
          ? "write_shell blocked a write or delete target outside the workspace root."
          : "write_shell blocked a file target outside the workspace root.",
        notes: ["Shell command targets must stay inside the workspace root."],
      };
    }

    const targetsStayInWorkspace = (targets: string[]) =>
      targets.every(token => this.isShellTargetInsideWorkspace(cwd, token));

    if (commandName === "cd") {
      if (targetTokens.length !== 1) {
        return {
          ok: false,
          shell,
          tokens,
          policy: "blocked",
          risk: "medium",
          reason: "write_shell requires an explicit path for cd.",
          notes: ["Use a workspace-relative directory path."],
        };
      }
      if (!targetsStayInWorkspace(targetTokens)) {
        return {
          ok: false,
          shell,
          tokens,
          policy: "blocked",
          risk: "high",
          reason: "write_shell blocked a cd target outside the workspace root.",
          notes: ["Persistent shell navigation must stay inside the workspace root."],
        };
      }
      return {
        ok: true,
        shell,
        tokens,
        policy: "direct",
        risk: "low",
        notes: [
          "Persistent shell navigation is allowlisted for direct execution inside the workspace root.",
        ],
      };
    }

    if (commandName === "." || commandName === "source") {
      if (targetTokens.length !== 1) {
        return {
          ok: false,
          shell,
          tokens,
          policy: "blocked",
          risk: "medium",
          reason: "write_shell requires an explicit path for source commands.",
          notes: ["Use a workspace-relative activation script path."],
        };
      }
      if (!targetsStayInWorkspace(targetTokens)) {
        return {
          ok: false,
          shell,
          tokens,
          policy: "blocked",
          risk: "high",
          reason: "write_shell blocked a source target outside the workspace root.",
          notes: ["Sourced scripts must stay inside the workspace root."],
        };
      }
      return {
        ok: true,
        shell,
        tokens,
        policy: "review",
        risk: "medium",
        notes: [
          "Sourcing a script executes arbitrary shell code, so it always requires review.",
        ],
      };
    }

    if (tokens.length === 1 && looksLikeVenvActivationTarget(rawInput)) {
      if (!targetsStayInWorkspace([rawInput])) {
        return {
          ok: false,
          shell,
          tokens,
          policy: "blocked",
          risk: "high",
          reason: "write_shell blocked a venv activation target outside the workspace root.",
          notes: ["Activation scripts must stay inside the workspace root."],
        };
      }
      return {
        ok: true,
        shell,
        tokens,
        policy: "review",
        risk: "medium",
        notes: [
          "Virtual-environment activation executes shell script content, so it always requires review.",
        ],
      };
    }

    if (
      SHELL_SESSION_DIRECT_PATH_COMMANDS.has(commandName) &&
      (!targetTokens.length || targetsStayInWorkspace(targetTokens))
    ) {
      return {
        ok: true,
        shell,
        tokens,
        policy: "direct",
        risk: "low",
        notes: [
          "This read-only shell command is on the persistent-shell direct allowlist.",
        ],
      };
    }

    if (
      SHELL_SESSION_DIRECT_READ_COMMANDS.has(commandName) &&
      targetTokens.length > 0 &&
      targetsStayInWorkspace(targetTokens)
    ) {
      return {
        ok: true,
        shell,
        tokens,
        policy: "direct",
        risk: "low",
        notes: [
          "This read-only shell command is on the persistent-shell direct allowlist.",
        ],
      };
    }

    if (
      (SHELL_SESSION_DIRECT_PATH_COMMANDS.has(commandName) ||
        SHELL_SESSION_DIRECT_READ_COMMANDS.has(commandName)) &&
      targetTokens.length > 0
    ) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: "write_shell blocked a read target outside the workspace root.",
        notes: ["Direct persistent-shell read commands must stay inside the workspace root."],
      };
    }

    if (
      SHELL_SESSION_DIRECT_LITERAL_COMMANDS.has(commandName) &&
      ((commandName === "pwd" || commandName === "get-location")
        ? targetTokens.length === 0
        : true)
    ) {
      return {
        ok: true,
        shell,
        tokens,
        policy: "direct",
        risk: "low",
        notes: [
          "This low-risk environment or discovery command is allowlisted for direct execution.",
        ],
      };
    }

    if (
      (commandName === "python" && (tokens[1] === "--version" || tokens[1] === "-V") && tokens.length === 2) ||
      ((commandName === "node" || commandName === "bun" || commandName === "npm") &&
        tokens[1] === "--version" &&
        tokens.length === 2) ||
      (commandName === "pip" &&
        ((tokens[1] === "--version" && tokens.length === 2) ||
          (tokens[1] === "list" && tokens.length === 2))) ||
      (commandName === "git" && tokens[1] === "status" && tokens.length === 2)
    ) {
      return {
        ok: true,
        shell,
        tokens,
        policy: "direct",
        risk: "low",
        notes: [
          "This allowlisted version or status command can execute directly in the persistent shell.",
        ],
      };
    }

    if (
      SHELL_MUTATING_COMMANDS.has(commandName) &&
      targetTokens.some(token => {
        if (!looksLikePathToken(token) || isShellNonFileSystemTarget(token)) {
          return false;
        }
        return !this.isShellTargetInsideWorkspace(cwd, token);
      })
    ) {
      return {
        ok: false,
        shell,
        tokens,
        policy: "blocked",
        risk: "high",
        reason: "write_shell blocked a write or delete target outside the workspace root.",
        notes: ["Shell mutations must stay inside the workspace root."],
      };
    }

    return {
      ok: true,
      shell,
      tokens,
      policy: "review",
      risk: SHELL_MUTATING_COMMANDS.has(commandName) ? "medium" : "low",
      notes: [
        "Only a safe reviewed shell subset is allowed.",
        SHELL_MUTATING_COMMANDS.has(commandName)
          ? "This shell input may mutate workspace files and still requires review."
          : "This shell input is not in the low-risk direct allowlist, so it requires review.",
      ],
    };
  }

  private auditShellSessionWrite(request: WriteShellToolRequest): ShellSessionWriteAuditResult {
    const inputs = splitShellInputBlock(request.input);
    const shell = this.shellSession?.shell ?? (process.platform === "win32" ? "pwsh" : "bash");

    if (inputs.length === 0) {
      return {
        ok: false,
        shell,
        tokens: [],
        policy: "blocked",
        risk: "high",
        reason: "write_shell requires `input`.",
        notes: ["Provide at least one shell line to execute."],
      };
    }

    const audits = inputs.map(input => this.auditSingleShellSessionInput(input));
    const blocked = audits.find(audit => !audit.ok || audit.policy === "blocked");
    if (blocked) {
      return {
        ...blocked,
        notes:
          inputs.length > 1
            ? [`Multiline shell block with ${inputs.length} lines failed audit.`, ...blocked.notes]
            : blocked.notes,
      };
    }

    const review = audits.find(audit => audit.policy === "review");
    if (review) {
      return {
        ...review,
        notes:
          inputs.length > 1
            ? [
                `Multiline shell block with ${inputs.length} lines will be reviewed as one unit.`,
                ...review.notes,
              ]
            : review.notes,
      };
    }

    return {
      ...audits[audits.length - 1]!,
      notes:
        inputs.length > 1
          ? [
              `Multiline shell block with ${inputs.length} lines is allowlisted for direct execution.`,
              ...audits[audits.length - 1]!.notes,
            ]
          : audits[audits.length - 1]!.notes,
    };
  }

  private getShellSettleMs() {
    const value = this.options.shellSettleMs;
    if (!Number.isFinite(value) || typeof value !== "number" || value < 0) {
      return DEFAULT_SHELL_SETTLE_MS;
    }
    return Math.floor(value);
  }

  private toWorkspaceDisplayPath(inputPath: string) {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      return ".";
    }

    if (isAbsolute(trimmed)) {
      const absolute = resolve(trimmed);
      if (!this.canAccessAbsolutePathInsideWorkspaceRoot(absolute)) {
        try {
          return this.resolveAbsolutePathForContainment(absolute).replace(/\\/g, "/");
        } catch {
          return absolute.replace(/\\/g, "/");
        }
      }
      const normalized = relative(this.workspaceRootAbsolute, absolute)
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "");
      return normalized || ".";
    }

    try {
      return this.normalizeWorkspacePath(trimmed);
    } catch {
      return trimmed.replace(/\\/g, "/");
    }
  }

  private getShellSessionCwdDisplay(session: ActiveShellSession | null) {
    if (!session) {
      return ".";
    }
    return this.toWorkspaceDisplayPath(session.cwd);
  }

  private formatShellSessionState(
    session: ActiveShellSession | null,
    output?: string,
    outputTruncated = false
  ) {
    const status = getShellSessionStatus(session);
    const outputText = output?.trim() ? output : "(no new output)";
    return [
      `status: ${status}`,
      `shell: ${session?.shell ?? "none"}`,
      `cwd: ${this.getShellSessionCwdDisplay(session)}`,
      `busy: ${session?.busy ? "true" : "false"}`,
      `alive: ${session?.alive ? "true" : "false"}`,
      `pending_output: ${session?.unreadOutputBuffer.trim() ? "true" : "false"}`,
      `last_exit: ${formatShellExitCode(session?.lastExitCode ?? null)}`,
      output !== undefined
        ? `output_truncated: ${outputTruncated ? `true (bounded to ${MAX_COMMAND_OUTPUT_CHARS} chars)` : "false"}`
        : "",
      output !== undefined ? "output:" : "",
      output !== undefined ? outputText : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private consumeShellControlBuffer(session: ActiveShellSession) {
    const normalized = session.controlBuffer.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    session.controlBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (
        session.pendingCommandId &&
        line.startsWith(`${SHELL_STATUS_MARKER_PREFIX}${session.pendingCommandId}__`)
      ) {
        const rawExit = line.slice(
          `${SHELL_STATUS_MARKER_PREFIX}${session.pendingCommandId}__`.length
        );
        const parsedExit = Number(rawExit);
        session.pendingExitCode = Number.isFinite(parsedExit) ? parsedExit : null;
        continue;
      }

      if (
        session.pendingCommandId &&
        line.startsWith(`${SHELL_CWD_MARKER_PREFIX}${session.pendingCommandId}__`)
      ) {
        session.pendingCwd = line.slice(
          `${SHELL_CWD_MARKER_PREFIX}${session.pendingCommandId}__`.length
        );
        session.cwd = session.pendingCwd || session.cwd;
        session.lastExitCode = session.pendingExitCode;
        session.busy = false;
        session.pendingCommandId = null;
        session.pendingCwd = null;
        session.pendingExitCode = null;
        continue;
      }

      const next = appendBoundedOutput(
        session.unreadOutputBuffer,
        `${line}\n`,
        MAX_COMMAND_OUTPUT_CHARS
      );
      session.unreadOutputBuffer = next.text;
      session.unreadOutputTruncated =
        session.unreadOutputTruncated || next.truncated;
    }
  }

  private flushUnreadShellOutput(session: ActiveShellSession) {
    this.consumeShellControlBuffer(session);
    let output = session.unreadOutputBuffer;
    let truncated = session.unreadOutputTruncated;
    if (
      session.controlBuffer &&
      !session.controlBuffer.startsWith(SHELL_STATUS_MARKER_PREFIX) &&
      !session.controlBuffer.startsWith(SHELL_CWD_MARKER_PREFIX)
    ) {
      const next = appendBoundedOutput(output, session.controlBuffer, MAX_COMMAND_OUTPUT_CHARS);
      output = next.text;
      truncated = truncated || next.truncated;
      session.controlBuffer = "";
    }
    session.unreadOutputBuffer = "";
    session.unreadOutputTruncated = false;
    return {
      output: output.trimEnd(),
      truncated,
    };
  }

  private async waitForShellSettle() {
    await new Promise(resolvePromise => {
      setTimeout(resolvePromise, this.getShellSettleMs());
    });
  }

  private async loadPtyFactory(): Promise<PtyFactory> {
    if (this.options.ptyFactory) {
      return this.options.ptyFactory;
    }
    this.ptyFactoryPromise ??= (async () => {
      try {
        const module = await import("node-pty");
        return options => {
          const handle = module.spawn(options.file, options.args, {
            cwd: options.cwd,
            env: options.env,
            name: options.name,
            cols: options.cols,
            rows: options.rows,
          });
          return {
            write: data => handle.write(data),
            kill: signal => handle.kill(signal),
            onData: listener => {
              const disposable = handle.onData(listener);
              return { dispose: () => disposable.dispose() };
            },
            onExit: listener => {
              const disposable = handle.onExit(event =>
                listener({
                  exitCode: event.exitCode,
                  signal: event.signal,
                })
              );
              return { dispose: () => disposable.dispose() };
            },
          } satisfies PtyProcess;
        };
      } catch (error) {
        this.ptyFactoryPromise = null;
        throw new Error(
          `Persistent shell support requires node-pty. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();
    return await this.ptyFactoryPromise;
  }

  private prewarmPersistentShellRuntime() {
    this.persistentShellFlavorPromise ??= getPersistentShellFlavor();
    void this.loadPtyFactory().catch(() => undefined);
  }

  private async resolvePersistentShellFlavor() {
    this.persistentShellFlavorPromise ??= getPersistentShellFlavor();
    return await this.persistentShellFlavorPromise;
  }

  dispose() {
    this.pendingApprovalGuards.clear();
    const session = this.shellSession;
    if (!session) {
      this.tsServerClient?.dispose();
      this.tsServerClient = null;
      void this.lspManager?.dispose();
      this.lspManager = null;
      return;
    }
    session.dataSubscription?.dispose();
    session.exitSubscription?.dispose();
    try {
      session.handle.kill("SIGTERM");
    } catch {
      // Best effort cleanup on exit.
    }
    this.shellSession = null;
    this.tsServerClient?.dispose();
    this.tsServerClient = null;
    void this.lspManager?.dispose();
    this.lspManager = null;
  }

  private buildShellSpawnArgs(shell: PersistentShellFlavor) {
    if (shell === "pwsh") {
      return ["-NoLogo", "-NoProfile"];
    }
    if (shell === "bash") {
      return ["--noprofile", "--norc"];
    }
    return [];
  }

  private buildPtyEnvironment() {
    return buildRestrictedSubprocessEnvFromBase();
  }

  private async openPersistentShell(request: OpenShellToolRequest) {
    const requestedCwd = request.cwd
      ? this.resolvePath(request.cwd)
      : resolve(this.rules.workspaceRoot);
    const existingSession = this.shellSession;
    if (existingSession) {
      if (
        existingSession.alive &&
        !existingSession.exited &&
        existingSession.cwd === requestedCwd
      ) {
        return { session: existingSession, reused: true as const };
      }
      throw new Error(
        `Persistent shell session already exists (${getShellSessionStatus(existingSession)}). Use close_shell before opening another session.`
      );
    }

    const shell = await this.resolvePersistentShellFlavor();
    const program = getPersistentShellProgram(shell);
    const ptyFactory = await this.loadPtyFactory();
    const handle = await ptyFactory({
      file: program,
      args: this.buildShellSpawnArgs(shell),
      cwd: requestedCwd,
      env: this.buildPtyEnvironment(),
      name: "xterm-256color",
      cols: 120,
      rows: 32,
    });

    const session: ActiveShellSession = {
      shell,
      program,
      cwd: requestedCwd,
      busy: false,
      alive: true,
      exited: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastExitCode: null,
      unreadOutputBuffer: "",
      unreadOutputTruncated: false,
      controlBuffer: "",
      pendingCommandId: null,
      pendingExitCode: null,
      pendingCwd: null,
      handle,
    };

    session.dataSubscription = handle.onData(data => {
      const next = appendBoundedOutput(session.controlBuffer, data, MAX_COMMAND_OUTPUT_CHARS * 2);
      session.controlBuffer = next.text;
      session.lastActivityAt = new Date().toISOString();
      this.consumeShellControlBuffer(session);
    }) ?? undefined;

    session.exitSubscription = handle.onExit(event => {
      session.alive = false;
      session.exited = true;
      session.busy = false;
      session.pendingCommandId = null;
      session.pendingCwd = null;
      session.pendingExitCode = null;
      session.lastExitCode = Number.isFinite(event.exitCode)
        ? event.exitCode
        : session.lastExitCode;
      session.lastActivityAt = new Date().toISOString();
      this.consumeShellControlBuffer(session);
    }) ?? undefined;

    this.shellSession = session;
    await this.waitForShellSettle();
    return { session, reused: false as const };
  }

  private async executeOpenShell(request: OpenShellToolRequest): Promise<string> {
    const { session, reused } = await this.openPersistentShell(request);
    const { output, truncated } = this.flushUnreadShellOutput(session);
    return [
      `status: ${reused ? "reused" : "opened"}`,
      `program: ${session.program}`,
      this.formatShellSessionState(session, output, truncated),
    ].join("\n");
  }

  private getActiveShellSession() {
    const session = this.shellSession;
    if (!session) {
      throw new Error("No active persistent shell session. Use open_shell first.");
    }
    if (!session.alive || session.exited) {
      throw new Error(
        "Persistent shell session has already exited. Use close_shell, then open_shell again."
      );
    }
    return session;
  }

  private async executeSingleShellInput(
    session: ActiveShellSession,
    input: string
  ): Promise<{ status: "completed" | "running"; output: string; truncated: boolean }> {
    const commandId = crypto.randomUUID().slice(0, 8);
    session.busy = true;
    session.pendingCommandId = commandId;
    session.pendingExitCode = null;
    session.pendingCwd = null;
    session.lastActivityAt = new Date().toISOString();
    session.handle.write(buildShellCommandWrapper(session.shell, input, commandId));
    await this.waitForShellSettle();
    this.consumeShellControlBuffer(session);
    const { output, truncated } = this.flushUnreadShellOutput(session);
    return {
      status: session.busy ? "running" : "completed",
      output,
      truncated,
    };
  }

  private async executeShellInputBlock(
    session: ActiveShellSession,
    inputs: string[]
  ): Promise<{ status: "completed" | "running"; output: string; truncated: boolean }> {
    return await this.executeSingleShellInput(session, inputs.join("\n"));
  }

  private async executeWriteShell(request: WriteShellToolRequest): Promise<string> {
    const session = this.getActiveShellSession();
    if (session.busy) {
      throw new Error(
        "Persistent shell session is busy. Use read_shell, shell_status, or interrupt_shell before sending more input."
      );
    }

    const audit = this.auditShellSessionWrite(request);
    if (!audit.ok) {
      throw new Error(audit.reason ?? "write_shell blocked by shell auditor.");
    }

    const inputs = splitShellInputBlock(request.input);
    const result = await this.executeShellInputBlock(session, inputs);
    const transcriptLines = inputs.map(input => `$ ${input}`);
    transcriptLines.push(result.output.trim() ? result.output : "(no new output)");

    return [
      `status: ${result.status}`,
      `input: ${request.input}`,
      this.formatShellSessionState(
        session,
        transcriptLines.join("\n"),
        result.truncated
      ),
    ].join("\n");
  }

  private async executeReadShell(): Promise<string> {
    const session = this.shellSession;
    if (!session) {
      return this.formatShellSessionState(null, "", false);
    }
    this.consumeShellControlBuffer(session);
    const { output, truncated } = this.flushUnreadShellOutput(session);
    return this.formatShellSessionState(session, output, truncated);
  }

  private async executeShellStatus(): Promise<string> {
    const session = this.shellSession;
    if (!session) {
      return this.formatShellSessionState(null);
    }
    this.consumeShellControlBuffer(session);
    return this.formatShellSessionState(session);
  }

  private async executeInterruptShell(): Promise<string> {
    const session = this.shellSession;
    if (!session) {
      return [
        "status: no_session",
        this.formatShellSessionState(null, "", false),
      ].join("\n");
    }

    try {
      session.handle.write("\u0003");
    } catch {
      try {
        session.handle.kill("SIGINT");
      } catch {
        // Best effort interrupt only.
      }
    }

    session.busy = false;
    session.pendingCommandId = null;
    session.pendingCwd = null;
    session.pendingExitCode = null;
    session.lastExitCode = 130;
    session.lastActivityAt = new Date().toISOString();
    await this.waitForShellSettle();
    const { output, truncated } = this.flushUnreadShellOutput(session);
    return [
      "status: interrupted",
      this.formatShellSessionState(session, output, truncated),
    ].join("\n");
  }

  private async executeCloseShell(): Promise<string> {
    const session = this.shellSession;
    if (!session) {
      return [
        "status: closed",
        this.formatShellSessionState(null),
      ].join("\n");
    }

    const { output, truncated } = this.flushUnreadShellOutput(session);
    const summary = [
      "status: closed",
      `shell: ${session.shell}`,
      `cwd: ${this.getShellSessionCwdDisplay(session)}`,
      `alive: false`,
      `busy: false`,
      `pending_output: false`,
      `last_exit: ${formatShellExitCode(session.lastExitCode)}`,
      "output_truncated: " +
        (truncated ? `true (bounded to ${MAX_COMMAND_OUTPUT_CHARS} chars)` : "false"),
      "output:",
      output.trim() ? output : "(no new output)",
    ].join("\n");
    this.dispose();
    return summary;
  }

  private noteFilesystemMutation() {
    this.filesystemMutationVersion += 1;
    this.recentListDir.clear();
    this.invalidateTsServer();
    this.invalidateLsp();
  }

  private pushUndoEntry(entry: UndoEntry) {
    if (this.suppressUndoRecording) {
      return;
    }
    this.undoHistory.push(entry);
    if (this.undoHistory.length > MAX_UNDO_HISTORY) {
      this.undoHistory.splice(0, this.undoHistory.length - MAX_UNDO_HISTORY);
    }
  }

  private async moveAbsolutePath(source: string, destination: string) {
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(source, destination);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EXDEV") {
        throw error;
      }
      const info = await stat(source);
      if (info.isDirectory()) {
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
        await rm(source, { recursive: true, force: false });
      } else {
        await copyFile(source, destination);
        await rm(source, { recursive: false, force: false });
      }
    }
  }

  private async applyUndoEntry(entry: UndoEntry) {
    if (entry.kind === "restore_file") {
      const absolute = this.resolvePath(entry.path);
      if (!entry.existedBefore) {
        try {
          await rm(absolute, { recursive: false, force: false });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        return `reverted ${entry.sourceAction}: removed ${entry.path}`;
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, entry.content);
      return `reverted ${entry.sourceAction}: restored ${entry.path}`;
    }

    if (entry.kind === "restore_workspace") {
      for (const file of entry.files) {
        const absolute = this.resolvePath(file.path);
        if (!file.existedBefore) {
          try {
            await rm(absolute, { recursive: false, force: false });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
          continue;
        }
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, file.content);
      }
      return `reverted ${entry.sourceAction}: restored ${entry.files.length} file(s)`;
    }

    if (entry.kind === "delete_path") {
      const absolute = this.resolvePath(entry.path);
      try {
        const info = await stat(absolute);
        await rm(absolute, {
          recursive: info.isDirectory(),
          force: false,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return `reverted ${entry.sourceAction}: removed ${entry.path}`;
    }

    if (await this.pathExists(entry.to)) {
      throw new Error(`undo target already exists: ${entry.to}`);
    }
    const from = this.resolvePath(entry.from);
    const to = this.resolvePath(entry.to);
    await this.moveAbsolutePath(from, to);
    return `reverted ${entry.sourceAction}: moved ${entry.from} -> ${entry.to}`;
  }

  private getRecentListDirSnapshot(inputPath: string) {
    const normalizedPath = this.normalizeWorkspacePath(inputPath);
    const snapshot = this.recentListDir.get(normalizedPath);
    if (!snapshot) {
      return null;
    }
    if (
      snapshot.mutationVersion !== this.filesystemMutationVersion ||
      Date.now() - snapshot.listedAt > RECENT_LIST_DIR_WINDOW_MS
    ) {
      this.recentListDir.delete(normalizedPath);
      return null;
    }
    return snapshot;
  }

  private storeRecentListDirSnapshot(inputPath: string, output: string) {
    const normalizedPath = this.normalizeWorkspacePath(inputPath);
    this.recentListDir.set(normalizedPath, {
      output,
      listedAt: Date.now(),
      mutationVersion: this.filesystemMutationVersion,
    });
  }

  private formatListDirToolResult(inputPath: string, output: string, cached = false) {
    const normalizedPath = this.normalizeWorkspacePath(inputPath);
    const confirmation = cached
      ? `[confirmed directory state] ${normalizedPath} (cached; no mutation since last check)`
      : `[confirmed directory state] ${normalizedPath}`;
    return `[tool result] list_dir ${inputPath}\n${confirmation}\n${output}`;
  }

  private async buildReviewDetails(
    request: ToolRequest,
    mode: "summary" | "full"
  ): Promise<string> {
    if (request.action === "open_shell") {
      const shell = await getPersistentShellFlavor();
      return [
        "[shell session preview]",
        `shell: ${shell}`,
        `cwd: ${request.cwd ?? "."}`,
        `existing_session: ${getShellSessionStatus(this.shellSession)}`,
        "policy: direct",
        "risk: low",
        "note: Persistent shell state is kept in memory for this CLI process only.",
        "note: open_shell now opens directly after local validation succeeds.",
        "note: Use write_shell when environment or cwd must persist.",
        `mode: ${mode}`,
      ].join("\n");
    }

    if (request.action === "write_shell") {
      const audit = this.auditShellSessionWrite(request);
      return [
        "[shell session preview]",
        `shell: ${audit.shell}`,
        `cwd: ${this.getShellSessionCwdDisplay(this.shellSession)}`,
        `input: ${request.input}`,
        `policy: ${audit.policy}`,
        `risk: ${audit.risk}`,
        `tokens: ${audit.tokens.length > 0 ? audit.tokens.join(" ") : "(none)"}`,
        ...audit.notes.map(note => `note: ${note}`),
        audit.reason ? `reason: ${audit.reason}` : "",
        `mode: ${mode}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (request.action === "run_command") {
      return [
        "[process preview]",
        `command: ${request.command}`,
        request.args.length > 0 ? `args: ${request.args.join(" ")}` : "",
        `cwd: ${request.cwd ?? "."}`,
        `mode: ${mode}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (request.action === "run_shell") {
      const audit = this.auditShellRequest(request);
      return [
        "[shell preview]",
        `shell: ${audit.shell}`,
        `command: ${request.command}`,
        `cwd: ${request.cwd ?? "."}`,
        `risk: ${audit.risk}`,
        `tokens: ${audit.tokens.length > 0 ? audit.tokens.join(" ") : "(none)"}`,
        ...audit.notes.map(note => `note: ${note}`),
        audit.reason ? `reason: ${audit.reason}` : "",
        `mode: ${mode}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (request.action === "copy_path" || request.action === "move_path") {
      return [
        `[${request.action === "copy_path" ? "copy" : "move"} preview]`,
        `source: ${request.path}`,
        `destination: ${request.destination}`,
      ].join("\n");
    }

    if (request.action === "lsp_rename") {
      const resolved = await this.resolveLspRenamePlan(request);
      return this.formatResolvedLspRenameReviewDetails(request, resolved, mode);
    }

    if (request.action === "lsp_code_actions" && request.title?.trim()) {
      const resolved = await this.resolveLspCodeActionPlan(request);
      return this.formatResolvedLspCodeActionReviewDetails(request, resolved, mode);
    }

    if (request.action === "lsp_format_document") {
      const resolved = await this.resolveLspFormatDocumentPlan(request);
      return this.formatResolvedLspFormatDocumentReviewDetails(request, resolved, mode);
    }

    const abs = this.resolvePath(request.path);
    const maxLines = mode === "summary" ? MAX_PREVIEW_SUMMARY_LINES : undefined;
    if (request.action === "delete_file") {
      try {
        const before = await readFile(abs, "utf8");
        return [
          "[delete preview]",
          formatDiffLines("-", before, 1, maxLines),
        ].join("\n");
      } catch {
        return "[delete preview]\nPath will be removed after approval.";
      }
    }

    if (request.action === "create_dir") {
      return "[directory preview]\nDirectory will be created after approval.";
    }

    if (
      request.action !== "create_file" &&
      request.action !== "write_file" &&
      request.action !== "edit_file" &&
      request.action !== "apply_patch"
    ) {
      return "";
    }

    if (request.action === "create_file") {
      return [
        "[create preview | new only]",
        formatDiffLines(
          "+",
          mode === "summary" ? clip(request.content ?? "", 6000) : request.content ?? "",
          1,
          maxLines
        ),
      ].join("\n");
    }

    if (request.action === "write_file") {
      const nextContent =
        mode === "summary" ? clip(request.content ?? "", 6000) : request.content ?? "";
      try {
        const before = await readFile(abs, "utf8");
        return [
          "[write preview | overwrite]",
          "[new + to be written]",
          formatDiffLines("+", nextContent, 1, maxLines),
          "[old - to be overwritten]",
          formatDiffLines("-", mode === "summary" ? clip(before, 6000) : before, 1, maxLines),
        ].join("\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return [
          "[write preview | new file]",
          formatDiffLines("+", nextContent, 1, maxLines),
        ].join("\n");
      }
    }

    const find = request.find ?? "";
    const replace = request.replace ?? "";
    const previewLabel = request.action === "apply_patch" ? "[patch preview]" : "[edit preview]";
    try {
      const before = await readFile(abs, "utf8");
      const hit = before.indexOf(find);
      const startLine = hit >= 0 ? lineNumberAtIndex(before, hit) : 1;
      return [
        previewLabel,
        "[new + to be written]",
        formatDiffLines(
          "+",
          mode === "summary" ? clip(replace, 3000) : replace,
          startLine,
          maxLines
        ),
        "[old - to be removed]",
        formatDiffLines(
          "-",
          mode === "summary" ? clip(find, 3000) : find,
          startLine,
          maxLines
        ),
      ].join("\n");
    } catch {
      return [
        previewLabel,
        "[new + to be written]",
        formatDiffLines(
          "+",
          mode === "summary" ? clip(replace, 3000) : replace,
          1,
          maxLines
        ),
        "[old - to be removed]",
        formatDiffLines(
          "-",
          mode === "summary" ? clip(find, 3000) : find,
          1,
          maxLines
        ),
      ].join("\n");
    }
  }

  private buildPreparedPendingReview(
    request: ToolRequest,
    detailsSummary: string,
    detailsFull: string,
    guard?: PendingApprovalGuard
  ): PreparedPendingReview {
    return {
      previewSummary: [this.formatPreview(request), detailsSummary]
        .filter(Boolean)
        .join("\n"),
      previewFull: [this.formatPreview(request), detailsFull]
        .filter(Boolean)
        .join("\n"),
      ...(guard ? { guard } : {}),
    };
  }

  private async preparePendingReview(request: ToolRequest): Promise<PreparedPendingReview> {
    if (request.action === "write_shell") {
      const detailsSummary = await this.buildReviewDetails(request, "summary");
      const detailsFull = await this.buildReviewDetails(request, "full");
      const session = this.getActiveShellSession();
      return this.buildPreparedPendingReview(request, detailsSummary, detailsFull, {
        kind: "write_shell",
        sessionCreatedAt: session.createdAt,
        cwd: session.cwd,
      });
    }

    if (request.action === "lsp_rename") {
      const resolved = await this.resolveLspRenamePlan(request);
      return this.buildPreparedPendingReview(
        request,
        this.formatResolvedLspRenameReviewDetails(request, resolved, "summary"),
        this.formatResolvedLspRenameReviewDetails(request, resolved, "full"),
        {
          kind: "lsp_rename",
          resolved,
        }
      );
    }

    if (isLspCodeActionApplyRequest(request)) {
      const resolved = await this.resolveLspCodeActionPlan(request);
      return this.buildPreparedPendingReview(
        request,
        this.formatResolvedLspCodeActionReviewDetails(request, resolved, "summary"),
        this.formatResolvedLspCodeActionReviewDetails(request, resolved, "full"),
        {
          kind: "lsp_code_actions",
          resolved,
        }
      );
    }

    if (request.action === "lsp_format_document") {
      const resolved = await this.resolveLspFormatDocumentPlan(request);
      return this.buildPreparedPendingReview(
        request,
        this.formatResolvedLspFormatDocumentReviewDetails(request, resolved, "summary"),
        this.formatResolvedLspFormatDocumentReviewDetails(request, resolved, "full"),
        {
          kind: "lsp_format_document",
          resolved,
        }
      );
    }

    const detailsSummary = await this.buildReviewDetails(request, "summary");
    const detailsFull = await this.buildReviewDetails(request, "full");
    return this.buildPreparedPendingReview(request, detailsSummary, detailsFull);
  }

  private ensureWriteShellApprovalGuardFresh(
    guard: Extract<PendingApprovalGuard, { kind: "write_shell" }>
  ) {
    const session = this.getActiveShellSession();
    if (session.createdAt !== guard.sessionCreatedAt || session.cwd !== guard.cwd) {
      throw new Error(
        "write_shell review is stale: shell cwd/session changed after preview. Reject this pending item and re-run the command before approving."
      );
    }
  }

  private formatPreview(request: ToolRequest) {
    const chunks = [`action=${request.action}`, `path=${request.path}`];
    if (request.action === "run_command") {
      chunks.push(`command=${request.command}`);
      if (request.args.length > 0) {
        chunks.push(`args=${request.args.join(" ")}`);
      }
      if (request.cwd) {
        chunks.push(`cwd=${request.cwd}`);
      }
      return chunks.join(" | ");
    }
    if (request.action === "run_shell") {
      chunks.push(`shell=${getShellFlavor()}`);
      chunks.push(`command=${request.command}`);
      if (request.cwd) {
        chunks.push(`cwd=${request.cwd}`);
      }
      return chunks.join(" | ");
    }
    if (request.action === "open_shell") {
      chunks.push(`shell=${process.platform === "win32" ? "pwsh" : "bash/sh"}`);
      if (request.cwd) {
        chunks.push(`cwd=${request.cwd}`);
      }
      return chunks.join(" | ");
    }
    if (request.action === "write_shell") {
      chunks.push(`input=${clip(request.input, 120)}`);
      chunks.push(`cwd=${this.getShellSessionCwdDisplay(this.shellSession)}`);
      return chunks.join(" | ");
    }
    if (
      request.action === "read_shell" ||
      request.action === "shell_status" ||
      request.action === "interrupt_shell" ||
      request.action === "close_shell"
    ) {
      chunks.push(`cwd=${this.getShellSessionCwdDisplay(this.shellSession)}`);
      return chunks.join(" | ");
    }
    if ("destination" in request) {
      chunks.push(`destination=${request.destination}`);
    }
    if ("pattern" in request) {
      chunks.push(`pattern=${request.pattern}`);
      chunks.push(`maxResults=${request.maxResults ?? DEFAULT_SEARCH_RESULTS}`);
      if (typeof request.caseSensitive === "boolean") {
        chunks.push(`caseSensitive=${request.caseSensitive}`);
      }
    }
    if ("symbol" in request) {
      chunks.push(`symbol=${request.symbol}`);
      chunks.push(`maxResults=${request.maxResults ?? DEFAULT_SEARCH_RESULTS}`);
      if (typeof request.caseSensitive === "boolean") {
        chunks.push(`caseSensitive=${request.caseSensitive}`);
      }
    }
    if ("query" in request) {
      chunks.push(`query=${clip(request.query, 80)}`);
      chunks.push(`maxResults=${request.maxResults ?? DEFAULT_SEARCH_RESULTS}`);
      if ("caseSensitive" in request && typeof request.caseSensitive === "boolean") {
        chunks.push(`caseSensitive=${request.caseSensitive}`);
      }
    }
    if ("jsonPath" in request && request.jsonPath) {
      chunks.push(`jsonPath=${request.jsonPath}`);
    }
    if ("yamlPath" in request && request.yamlPath) {
      chunks.push(`yamlPath=${request.yamlPath}`);
    }
    if ("startLine" in request && typeof request.startLine === "number") {
      chunks.push(`startLine=${request.startLine}`);
    }
    if ("endLine" in request && typeof request.endLine === "number") {
      chunks.push(`endLine=${request.endLine}`);
    }
    if ("line" in request && typeof request.line === "number") {
      chunks.push(`line=${request.line}`);
    }
    if ("column" in request && typeof request.column === "number") {
      chunks.push(`column=${request.column}`);
    }
    if ("newName" in request && request.newName) {
      chunks.push(`newName=${request.newName}`);
    }
    if ("title" in request && request.title) {
      chunks.push(`title=${clip(request.title, 80)}`);
    }
    if ("kind" in request && request.kind) {
      chunks.push(`kind=${request.kind}`);
    }
    if ("serverId" in request && request.serverId) {
      chunks.push(`serverId=${request.serverId}`);
    }
    if ("tabSize" in request && typeof request.tabSize === "number") {
      chunks.push(`tabSize=${request.tabSize}`);
    }
    if ("insertSpaces" in request && typeof request.insertSpaces === "boolean") {
      chunks.push(`insertSpaces=${request.insertSpaces}`);
    }
    if ("find" in request && request.find) {
      chunks.push(`find=${request.find}`);
    }
    if ("replace" in request && typeof request.replace === "string") {
      chunks.push(`replace=${request.replace}`);
    }
    if ("content" in request && typeof request.content === "string") {
      chunks.push(`content_bytes=${Buffer.byteLength(request.content, "utf8")}`);
    }
    return chunks.join(" | ");
  }

  private formatExecutionResult(
    request: CommandToolRequest | ShellToolRequest,
    result: CommandExecutionResult,
    shell?: ShellFlavor
  ) {
    const outputSections: string[] = [];

    if (typeof result.output === "string" && result.output.trim()) {
      outputSections.push(result.output.trim());
    } else {
      if (result.stdout?.trim()) {
        outputSections.push("[stdout]");
        outputSections.push(result.stdout.trim());
      }
      if (result.stderr?.trim()) {
        outputSections.push("[stderr]");
        outputSections.push(result.stderr.trim());
      }
    }

    const fallbackOutput =
      result.status === "completed"
        ? "(command completed with no output)"
        : "(command failed with no output)";
    const outputBody = outputSections.length > 0 ? outputSections.join("\n") : fallbackOutput;
    const boundedOutput = appendBoundedOutput("", outputBody, MAX_COMMAND_OUTPUT_CHARS);
    const outputTruncated = Boolean(result.truncated) || boundedOutput.truncated;

    const exitDisplay =
      result.status === "timed_out"
        ? "timeout"
        : result.exitCode === null
          ? "unknown"
          : String(result.exitCode);

    return [
      `status: ${result.status}`,
      shell ? `shell: ${shell}` : "",
      `command: ${request.command}`,
      request.action === "run_command"
        ? `args: ${request.args.length > 0 ? request.args.join(" ") : "(none)"}`
        : "",
      `cwd: ${request.cwd ?? "."}`,
      `exit: ${exitDisplay}`,
      `output_truncated: ${outputTruncated ? `true (bounded to ${MAX_COMMAND_OUTPUT_CHARS} chars)` : "false"}`,
      "output:",
      boundedOutput.text,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private normalizeExecutionResult(
    request: CommandToolRequest | ShellToolRequest,
    runnerResult: string | CommandExecutionResult,
    shell?: ShellFlavor
  ) {
    if (typeof runnerResult === "string") {
      const bounded = appendBoundedOutput("", runnerResult, MAX_COMMAND_OUTPUT_CHARS);
      return this.formatExecutionResult(request, {
        status: "completed",
        exitCode: 0,
        output: bounded.text,
        truncated: bounded.truncated,
      }, shell);
    }

    const output =
      typeof runnerResult.output === "string" && runnerResult.output.length > 0
        ? appendBoundedOutput("", runnerResult.output, MAX_COMMAND_OUTPUT_CHARS)
        : null;
    const stdout =
      typeof runnerResult.stdout === "string" && runnerResult.stdout.length > 0
        ? appendBoundedOutput("", runnerResult.stdout, MAX_COMMAND_OUTPUT_CHARS)
        : null;
    const stderr =
      typeof runnerResult.stderr === "string" && runnerResult.stderr.length > 0
        ? appendBoundedOutput("", runnerResult.stderr, MAX_COMMAND_OUTPUT_CHARS)
        : null;

    return this.formatExecutionResult(request, {
      ...runnerResult,
      output: output?.text,
      stdout: stdout?.text,
      stderr: stderr?.text,
      truncated:
        Boolean(runnerResult.truncated) ||
        Boolean(output?.truncated) ||
        Boolean(stdout?.truncated) ||
        Boolean(stderr?.truncated),
    }, shell);
  }

  private async executeCommand(request: CommandToolRequest): Promise<string> {
    const cwd = request.cwd
      ? this.resolvePath(request.cwd)
      : resolve(this.rules.workspaceRoot);

    if (this.options.commandRunner) {
      try {
        const result = await this.options.commandRunner(request, cwd);
        return this.normalizeExecutionResult(request, result);
      } catch (error) {
        return this.formatExecutionResult(request, {
          status: "failed",
          exitCode: null,
          stderr: error instanceof Error ? error.message : String(error),
          truncated: false,
        });
      }
    }

    const timeoutMs = getCommandTimeoutMs(request);

    return await new Promise<string>(resolvePromise => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(request.command, request.args, {
          cwd,
          shell: false,
        });
      } catch (error) {
        resolvePromise(
          this.formatExecutionResult(request, {
            status: "failed",
            exitCode: null,
            stderr: error instanceof Error ? error.message : String(error),
            truncated: false,
          })
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputTruncated = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        resolvePromise(
          this.formatExecutionResult(request, {
            status: "timed_out",
            exitCode: null,
            stderr: `Command timed out after ${timeoutMs}ms.`,
            stdout,
            truncated: outputTruncated,
          })
        );
      }, timeoutMs);

      const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "stdout") {
          const next = appendBoundedOutput(stdout, text, MAX_COMMAND_OUTPUT_CHARS);
          stdout = next.text;
          outputTruncated = outputTruncated || next.truncated;
        } else {
          const next = appendBoundedOutput(stderr, text, MAX_COMMAND_OUTPUT_CHARS);
          stderr = next.text;
          outputTruncated = outputTruncated || next.truncated;
        }
      };

      child.stdout?.on("data", chunk => appendChunk("stdout", chunk));
      child.stderr?.on("data", chunk => appendChunk("stderr", chunk));
      child.on("error", error => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise(
          this.formatExecutionResult(request, {
            status: "failed",
            exitCode: null,
            stderr: error.message,
            stdout,
            truncated: outputTruncated,
          })
        );
      });
      child.on("close", code => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise(
          this.formatExecutionResult(request, {
            status: code === 0 ? "completed" : "failed",
            exitCode: code ?? null,
            stdout,
            stderr,
            truncated: outputTruncated,
          })
        );
      });
    });
  }

  private async executeShell(request: ShellToolRequest): Promise<string> {
    const audit = this.auditShellRequest(request);
    if (!audit.ok) {
      throw new Error(audit.reason ?? "run_shell blocked by shell auditor.");
    }

    const cwd = request.cwd
      ? this.resolvePath(request.cwd)
      : resolve(this.rules.workspaceRoot);

    if (this.options.shellRunner) {
      try {
        const result = await this.options.shellRunner(request, cwd, audit.shell);
        return this.normalizeExecutionResult(request, result, audit.shell);
      } catch (error) {
        return this.formatExecutionResult(request, {
          status: "failed",
          exitCode: null,
          stderr: error instanceof Error ? error.message : String(error),
          truncated: false,
        }, audit.shell);
      }
    }

    const program =
      audit.shell === "pwsh"
        ? "pwsh"
        : audit.shell === "cmd"
          ? "cmd.exe"
          : "/bin/sh";
    const args =
      audit.shell === "pwsh"
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command]
        : audit.shell === "cmd"
          ? ["/d", "/s", "/c", request.command]
          : ["-lc", request.command];

    const timeoutMs = getCommandTimeoutMs(request);

    return await new Promise<string>(resolvePromise => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(program, args, {
          cwd,
          shell: false,
        });
      } catch (error) {
        resolvePromise(
          this.formatExecutionResult(request, {
            status: "failed",
            exitCode: null,
            stderr: error instanceof Error ? error.message : String(error),
            truncated: false,
          }, audit.shell)
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputTruncated = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        resolvePromise(
          this.formatExecutionResult(request, {
            status: "timed_out",
            exitCode: null,
            stderr: `Command timed out after ${timeoutMs}ms.`,
            stdout,
            truncated: outputTruncated,
          }, audit.shell)
        );
      }, timeoutMs);

      const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "stdout") {
          const next = appendBoundedOutput(stdout, text, MAX_COMMAND_OUTPUT_CHARS);
          stdout = next.text;
          outputTruncated = outputTruncated || next.truncated;
        } else {
          const next = appendBoundedOutput(stderr, text, MAX_COMMAND_OUTPUT_CHARS);
          stderr = next.text;
          outputTruncated = outputTruncated || next.truncated;
        }
      };

      child.stdout?.on("data", chunk => appendChunk("stdout", chunk));
      child.stderr?.on("data", chunk => appendChunk("stderr", chunk));
      child.on("error", error => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise(
          this.formatExecutionResult(request, {
            status: "failed",
            exitCode: null,
            stderr: error.message,
            stdout,
            truncated: outputTruncated,
          }, audit.shell)
        );
      });
      child.on("close", code => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise(
          this.formatExecutionResult(request, {
            status: code === 0 ? "completed" : "failed",
            exitCode: code ?? null,
            stdout,
            stderr,
            truncated: outputTruncated,
          }, audit.shell)
        );
      });
    });
  }

  private shouldSkipSearchDirectory(
    directoryName: string,
    absolutePath: string,
    startAbsolute: string
  ) {
    return (
      absolutePath !== startAbsolute &&
      DEFAULT_IGNORED_SEARCH_DIRECTORY_NAMES.has(directoryName)
    );
  }

  private formatWalkFilesNotes(result: WalkFilesResult) {
    const notes: string[] = [];
    const skippedDirectoryNames = uniqueSorted(result.skippedDirectoryNames);
    if (skippedDirectoryNames.length > 0) {
      notes.push(
        `note: skipped common large directories: ${skippedDirectoryNames.join(", ")}`
      );
    }
    if (result.fileLimitHit) {
      notes.push(
        `note: file scan capped at ${MAX_SEARCHABLE_FILES} files; narrow \`path\` for a deeper search`
      );
    }
    return notes;
  }

  private async walkFiles(startPath: string): Promise<WalkFilesResult> {
    const startAbsolute = this.resolvePath(startPath);
    const startWorkspace = this.normalizeWorkspacePath(startPath);
    const info = await stat(startAbsolute);

    if (!info.isDirectory()) {
      return {
        files: [{
          absolutePath: startAbsolute,
          workspacePath: startWorkspace,
          relativeToStart: basename(startAbsolute).replace(/\\/g, "/"),
        }],
        skippedDirectoryNames: [],
        fileLimitHit: false,
      };
    }

    const files: SearchableFile[] = [];
    const skippedDirectoryNames: string[] = [];
    const queue: Array<{ absolutePath: string }> = [{ absolutePath: startAbsolute }];
    let fileLimitHit = false;

    while (queue.length > 0 && !fileLimitHit) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const entries = await readdir(current.absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = resolve(current.absolutePath, entry.name);
        const workspacePath = relative(resolve(this.rules.workspaceRoot), absolutePath)
          .replace(/\\/g, "/")
          .replace(/^\.\/+/, "") || ".";
        if (entry.isDirectory()) {
          if (this.shouldSkipSearchDirectory(entry.name, absolutePath, startAbsolute)) {
            skippedDirectoryNames.push(entry.name);
            continue;
          }
          queue.push({ absolutePath });
          continue;
        }
        files.push({
          absolutePath,
          workspacePath,
          relativeToStart:
            relative(startAbsolute, absolutePath).replace(/\\/g, "/") || entry.name,
        });
        if (files.length >= MAX_SEARCHABLE_FILES) {
          fileLimitHit = true;
          break;
        }
      }
    }

    return {
      files,
      skippedDirectoryNames,
      fileLimitHit,
    };
  }

  private async executeFindFiles(request: FindFilesToolRequest): Promise<string> {
    const walkResult = await this.walkFiles(request.path);
    const matcher = globToRegExp(request.pattern, request.caseSensitive ?? false);
    const patternIncludesDirectory = /[\\/]/.test(request.pattern);
    const matches = walkResult.files
      .filter(file => {
        if (
          matcher.test(file.relativeToStart) ||
          matcher.test(file.workspacePath)
        ) {
          return true;
        }
        if (patternIncludesDirectory) {
          return false;
        }
        return matcher.test(basename(file.workspacePath));
      })
      .slice(0, request.maxResults ?? DEFAULT_SEARCH_RESULTS)
      .map(file => file.workspacePath);
    const notes = this.formatWalkFilesNotes(walkResult);

    if (matches.length === 0) {
      return [`(no matches for pattern: ${request.pattern})`, ...notes]
        .filter(Boolean)
        .join("\n");
    }

    return [`Found ${matches.length} file(s):`, ...notes, ...matches].join("\n");
  }

  private async executeSearchText(request: SearchTextToolRequest): Promise<string> {
    const walkResult = await this.walkFiles(request.path);
    const files = walkResult.files;
    const limit = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    const caseSensitive = request.caseSensitive ?? false;
    const query = caseSensitive ? request.query : request.query.toLowerCase();
    const matches: string[] = [];
    let scannedOversizedFiles = 0;
    let partialScanCount = 0;
    const walkNotes = this.formatWalkFilesNotes(walkResult);

    for (const file of files) {
      const info = await stat(file.absolutePath);
      if (info.size > this.rules.maxReadBytes) {
        scannedOversizedFiles += 1;
        const scanBytes = this.getLargeFileScanByteLimit(info.size);
        if (scanBytes < info.size) {
          partialScanCount += 1;
        }
        await this.scanTextFileLines(
          file.absolutePath,
          scanBytes,
          (line, lineNumber) => {
            const haystack = caseSensitive ? line : line.toLowerCase();
            if (!haystack.includes(query)) {
              return false;
            }
            matches.push(`${file.workspacePath}:${lineNumber} | ${clipSnippet(line)}`);
            return matches.length >= limit;
          }
        );
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n");
        }
        continue;
      }
      const content = await readFile(file.absolutePath, "utf8");
      const lines = splitFileLines(content);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
        matches.push(`${file.workspacePath}:${index + 1} | ${clipSnippet(line)}`);
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n");
        }
      }
    }

    const note = this.formatLargeFileSearchNote(
      scannedOversizedFiles,
      partialScanCount
    );
    if (matches.length === 0) {
      return [`(no text matches for query: ${request.query})`, ...walkNotes, note]
        .filter(Boolean)
        .join("\n");
    }

    return [
      `Found ${matches.length} match(es):`,
      ...walkNotes,
      ...(note ? [note] : []),
      ...matches,
    ].join("\n");
  }

  private async executeSearchTextContext(
    request: SearchTextContextToolRequest
  ): Promise<string> {
    const walkResult = await this.walkFiles(request.path);
    const files = walkResult.files;
    const limit = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    const caseSensitive = request.caseSensitive ?? false;
    const query = caseSensitive ? request.query : request.query.toLowerCase();
    const before = request.before ?? 2;
    const after = request.after ?? 2;
    const matches: string[] = [];
    let scannedOversizedFiles = 0;
    let partialScanCount = 0;
    const walkNotes = this.formatWalkFilesNotes(walkResult);

    for (const file of files) {
      const info = await stat(file.absolutePath);
      if (info.size > this.rules.maxReadBytes) {
        scannedOversizedFiles += 1;
        const scanBytes = this.getLargeFileScanByteLimit(info.size);
        if (scanBytes < info.size) {
          partialScanCount += 1;
        }

        const recentLines: Array<{ lineNumber: number; text: string }> = [];
        const pendingWindows: Array<{
          header: string;
          body: string[];
          remainingAfter: number;
        }> = [];
        let createdMatchCount = matches.length;
        let stopCreatingNewMatches = false;

        await this.scanTextFileLines(
          file.absolutePath,
          scanBytes,
          (line, lineNumber) => {
            for (let index = pendingWindows.length - 1; index >= 0; index -= 1) {
              const pending = pendingWindows[index];
              if (!pending) {
                continue;
              }
              pending.body.push(formatContextLineAtNumber(lineNumber, line, " "));
              pending.remainingAfter -= 1;
              if (pending.remainingAfter <= 0) {
                matches.push([pending.header, ...pending.body].join("\n"));
                pendingWindows.splice(index, 1);
              }
            }

            const haystack = caseSensitive ? line : line.toLowerCase();
            if (!stopCreatingNewMatches && haystack.includes(query)) {
              const body = [
                ...recentLines.map(item =>
                  formatContextLineAtNumber(item.lineNumber, item.text, " ")
                ),
                formatContextLineAtNumber(lineNumber, line, ">"),
              ];
              createdMatchCount += 1;
              if (after <= 0) {
                matches.push([`[match] ${file.workspacePath}:${lineNumber}`, ...body].join("\n"));
              } else {
                pendingWindows.push({
                  header: `[match] ${file.workspacePath}:${lineNumber}`,
                  body,
                  remainingAfter: after,
                });
              }
              if (createdMatchCount >= limit) {
                stopCreatingNewMatches = true;
              }
            }

            recentLines.push({ lineNumber, text: line });
            if (recentLines.length > before) {
              recentLines.shift();
            }

            return stopCreatingNewMatches && pendingWindows.length === 0;
          }
        );

        for (const pending of pendingWindows) {
          matches.push([pending.header, ...pending.body].join("\n"));
        }

        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} contextual match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n\n");
        }
        continue;
      }

      const content = await readFile(file.absolutePath, "utf8");
      const lines = splitFileLines(content);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }

        matches.push(
          [`[match] ${file.workspacePath}:${index + 1}`, formatContextWindow(lines, index, before, after)].join(
            "\n"
          )
        );
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} contextual match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n\n");
        }
      }
    }

    const note = this.formatLargeFileSearchNote(
      scannedOversizedFiles,
      partialScanCount
    );
    if (matches.length === 0) {
      return [`(no text matches for query: ${request.query})`, ...walkNotes, note]
        .filter(Boolean)
        .join("\n");
    }

    return [
      `Found ${matches.length} contextual match(es):`,
      ...walkNotes,
      ...(note ? [note] : []),
      ...matches,
    ].join("\n\n");
  }

  private async executeMovePath(request: Extract<ToolRequest, { action: "move_path" }>) {
    const source = this.resolvePath(request.path);
    const destination = this.resolvePath(request.destination);
    await this.moveAbsolutePath(source, destination);
    this.pushUndoEntry({
      kind: "move_path",
      from: this.normalizeWorkspacePath(request.destination),
      to: this.normalizeWorkspacePath(request.path),
      sourceAction: request.action,
    });
    this.noteFilesystemMutation();
    return `Moved path: ${request.path} -> ${request.destination}`;
  }

  private async executeCopyPath(request: Extract<ToolRequest, { action: "copy_path" }>) {
    const source = this.resolvePath(request.path);
    const destination = this.resolvePath(request.destination);
    const info = await stat(source);
    await mkdir(dirname(destination), { recursive: true });
    if (info.isDirectory()) {
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    } else {
      await copyFile(source, destination);
    }
    this.pushUndoEntry({
      kind: "delete_path",
      path: this.normalizeWorkspacePath(request.destination),
      sourceAction: request.action,
    });
    this.noteFilesystemMutation();
    return `Copied path: ${request.path} -> ${request.destination}`;
  }

  private getReadFilesTargets(request: ReadFilesToolRequest) {
    return buildReadFilesTargets(request.path, request.paths);
  }

  private getStatPathsTargets(request: StatPathsToolRequest) {
    return buildStatPathsTargets(request.path, request.paths);
  }

  private async executeReadFiles(request: ReadFilesToolRequest) {
    const outputs: string[] = [];

    for (const target of this.getReadFilesTargets(request)) {
      const abs = this.resolvePath(target);
      const info = await stat(abs);
      if (!info.isFile()) {
        throw new Error(`read_files only supports files: ${target}`);
      }
      if (info.size > this.rules.maxReadBytes) {
        throw new Error(
          `read_files target too large: ${target} (${info.size} bytes). max_read_bytes=${this.rules.maxReadBytes}`
        );
      }
      const content = await readFile(abs, "utf8");
      outputs.push(`[file] ${target}`);
      outputs.push(content.length > 0 ? content : "(empty file)");
    }

    return outputs.join("\n\n");
  }

  private async executeReadRange(request: ReadRangeToolRequest) {
    const abs = this.resolvePath(request.path);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`read_range only supports files: ${request.path}`);
    }
    let selectedLines: string[];
    const usedLargeFileMode = info.size > this.rules.maxReadBytes;

    if (usedLargeFileMode) {
      selectedLines = [];
      await this.scanTextFileLines(abs, info.size, (line, lineNumber) => {
        if (lineNumber < request.startLine) {
          return false;
        }
        if (lineNumber > request.endLine) {
          return true;
        }
        selectedLines.push(clipContextLine(line));
        return lineNumber >= request.endLine;
      });
    } else {
      const content = await readFile(abs, "utf8");
      const allLines = splitFileLines(content);
      selectedLines = allLines
        .slice(request.startLine - 1, request.endLine)
        .map(line => clipContextLine(line));
    }

    return [
      `path: ${request.path}`,
      `lines: ${request.startLine}-${request.endLine}`,
      ...(usedLargeFileMode
        ? [
            `note: large-file mode streamed requested lines from oversized file (${info.size} bytes)`,
          ]
        : []),
      selectedLines.length > 0
        ? formatNumberedLines(selectedLines, request.startLine)
        : "(no lines in requested range)",
    ].join("\n");
  }

  private async executeReadJson(request: ReadJsonToolRequest) {
    const abs = this.resolvePath(request.path);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`read_json only supports files: ${request.path}`);
    }
    if (info.size > this.rules.maxReadBytes) {
      throw new Error(
        `read_json target too large: ${request.path} (${info.size} bytes). max_read_bytes=${this.rules.maxReadBytes}`
      );
    }

    const content = await readFile(abs, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(
        `read_json requires valid JSON in ${request.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let value = parsed;
    if (request.jsonPath) {
      for (const segment of parseStructuredPathSegments(request.jsonPath)) {
        if (Array.isArray(value)) {
          const index = Number(segment);
          if (!Number.isInteger(index) || index < 0 || index >= value.length) {
            throw new Error(`read_json jsonPath not found: ${request.jsonPath}`);
          }
          value = value[index];
          continue;
        }
        if (!value || typeof value !== "object" || !(segment in (value as Record<string, unknown>))) {
          throw new Error(`read_json jsonPath not found: ${request.jsonPath}`);
        }
        value = (value as Record<string, unknown>)[segment];
      }
    }

    return [
      `path: ${request.path}`,
      request.jsonPath ? `jsonPath: ${request.jsonPath}` : "",
      "value:",
      formatStructuredValue(value),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async executeReadYaml(request: ReadYamlToolRequest) {
    const abs = this.resolvePath(request.path);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`read_yaml only supports files: ${request.path}`);
    }
    if (info.size > this.rules.maxReadBytes) {
      throw new Error(
        `read_yaml target too large: ${request.path} (${info.size} bytes). max_read_bytes=${this.rules.maxReadBytes}`
      );
    }

    const content = await readFile(abs, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYamlDocument(content);
    } catch (error) {
      throw new Error(
        `read_yaml requires supported YAML in ${request.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let value = parsed;
    if (request.yamlPath) {
      for (const segment of parseStructuredPathSegments(request.yamlPath)) {
        if (Array.isArray(value)) {
          const index = Number(segment);
          if (!Number.isInteger(index) || index < 0 || index >= value.length) {
            throw new Error(`read_yaml yamlPath not found: ${request.yamlPath}`);
          }
          value = value[index];
          continue;
        }
        if (!value || typeof value !== "object" || !(segment in (value as Record<string, unknown>))) {
          throw new Error(`read_yaml yamlPath not found: ${request.yamlPath}`);
        }
        value = (value as Record<string, unknown>)[segment];
      }
    }

    return [
      `path: ${request.path}`,
      request.yamlPath ? `yamlPath: ${request.yamlPath}` : "",
      "value:",
      formatStructuredValue(value),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async executeStatPaths(request: StatPathsToolRequest) {
    const targets = this.getStatPathsTargets(request);
    const outputs: string[] = [`Stat ${targets.length} path(s):`];

    for (const target of targets) {
      const normalizedTarget = this.normalizeWorkspacePath(target);
      try {
        const info = await stat(this.resolvePath(target));
        const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
        outputs.push(
          [
            `[path] ${normalizedTarget}`,
            "exists: true",
            `kind: ${kind}`,
            `size: ${info.size}`,
            `mtime: ${info.mtime.toISOString()}`,
          ].join("\n")
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        outputs.push(
          [`[path] ${normalizedTarget}`, "exists: false", "kind: missing", "size: -", "mtime: -"].join(
            "\n"
          )
        );
      }
    }

    return outputs.join("\n\n");
  }

  private async executeOutlineFile(request: OutlineFileToolRequest) {
    const abs = this.resolvePath(request.path);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`outline_file only supports files: ${request.path}`);
    }

    let entries: string[] = [];
    let partialScan = false;
    let entryLimitHit = false;
    let scanBytes = info.size;

    if (info.size <= this.rules.maxReadBytes) {
      const content = await readFile(abs, "utf8");
      entries = splitFileLines(content)
        .map((line, index) => {
          const entry = getOutlineEntry(line);
          if (!entry) {
            return null;
          }
          return formatOutlineEntry(entry, index + 1);
        })
        .filter((entry): entry is string => Boolean(entry));
      if (entries.length > MAX_OUTLINE_ENTRIES) {
        entries = entries.slice(0, MAX_OUTLINE_ENTRIES);
        entryLimitHit = true;
      }
    } else {
      scanBytes = this.getLargeFileScanByteLimit(info.size);
      partialScan = scanBytes < info.size;
      const scanned = await this.scanOutlineEntries(abs, scanBytes);
      entries = scanned.entries;
      entryLimitHit = scanned.entryLimitHit;
    }

    const header = [`Outline for ${request.path}`];
    if (info.size > this.rules.maxReadBytes) {
      header.push(
        `large-file mode: scanned ${scanBytes} of ${info.size} bytes (max_read_bytes=${this.rules.maxReadBytes})`
      );
      if (partialScan) {
        header.push("note: partial scan; use find_symbol/search_text_context for deeper targeting");
      }
    }
    if (entryLimitHit) {
      header.push(`note: showing first ${entries.length} outline entries`);
    }

    if (entries.length === 0) {
      return [...header, "(no outline symbols found)"].join("\n");
    }

    return [...header, ...entries].join("\n");
  }

  private getLargeFileScanByteLimit(fileSize: number) {
    return Math.min(
      fileSize,
      Math.max(this.rules.maxReadBytes, MIN_STREAM_SCAN_BYTES),
      MAX_STREAM_SCAN_BYTES
    );
  }

  private async scanTextFileLines(
    absolutePath: string,
    byteLimit: number,
    onLine: (line: string, lineNumber: number) => boolean | void | Promise<boolean | void>
  ) {
    const stream = createReadStream(absolutePath, {
      encoding: "utf8",
      start: 0,
      end: Math.max(0, byteLimit - 1),
    });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;

    try {
      for await (const line of lines) {
        lineNumber += 1;
        const shouldStop = await onLine(line, lineNumber);
        if (shouldStop) {
          break;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private async scanOutlineEntries(
    absolutePath: string,
    byteLimit: number
  ): Promise<{ entries: string[]; entryLimitHit: boolean }> {
    const entries: string[] = [];
    let entryLimitHit = false;

    await this.scanTextFileLines(absolutePath, byteLimit, (line, lineNumber) => {
      const entry = getOutlineEntry(line);
      if (!entry) {
        return false;
      }
      entries.push(formatOutlineEntry(entry, lineNumber));
      if (entries.length >= MAX_OUTLINE_ENTRIES) {
        entryLimitHit = true;
        return true;
      }
      return false;
    });

    return {
      entries,
      entryLimitHit,
    };
  }

  private formatLargeFileSearchNote(
    scannedOversizedFiles: number,
    partialScanCount: number
  ) {
    if (scannedOversizedFiles <= 0) {
      return "";
    }
    if (partialScanCount > 0) {
      return `note: large-file mode scanned ${scannedOversizedFiles} oversized file(s); ${partialScanCount} partial scan(s) may omit deeper matches`;
    }
    return `note: large-file mode scanned ${scannedOversizedFiles} oversized file(s)`;
  }

  private async executeFindSymbol(request: FindSymbolToolRequest) {
    const walkResult = await this.walkFiles(request.path);
    const files = walkResult.files;
    const caseSensitive = request.caseSensitive ?? false;
    const flags = caseSensitive ? "" : "i";
    const symbol = escapeRegExp(request.symbol);
    const limit = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    const patterns = buildSymbolDefinitionPatterns(symbol, flags);
    const matches: string[] = [];
    let scannedOversizedFiles = 0;
    let partialScanCount = 0;
    const walkNotes = this.formatWalkFilesNotes(walkResult);

    for (const file of files) {
      const info = await stat(file.absolutePath);
      if (info.size > this.rules.maxReadBytes) {
        scannedOversizedFiles += 1;
        const scanBytes = this.getLargeFileScanByteLimit(info.size);
        if (scanBytes < info.size) {
          partialScanCount += 1;
        }
        await this.scanTextFileLines(
          file.absolutePath,
          scanBytes,
          (line, lineNumber) => {
            const trimmed = line.trim();
            if (!trimmed) {
              return false;
            }
            if (!patterns.some(pattern => pattern.test(trimmed))) {
              return false;
            }
            matches.push(
              `${file.workspacePath}:${lineNumber} | ${clipSnippet(trimmed)}`
            );
            return matches.length >= limit;
          }
        );
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} symbol match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n");
        }
        continue;
      }
      const content = await readFile(file.absolutePath, "utf8");
      const lines = splitFileLines(content);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (!patterns.some(pattern => pattern.test(trimmed))) {
          continue;
        }
        matches.push(`${file.workspacePath}:${index + 1} | ${clipSnippet(trimmed)}`);
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} symbol match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n");
        }
      }
    }

    const note = this.formatLargeFileSearchNote(
      scannedOversizedFiles,
      partialScanCount
    );
    if (matches.length === 0) {
      return [`(no symbol matches for: ${request.symbol})`, ...walkNotes, note]
        .filter(Boolean)
        .join("\n");
    }

    return [
      `Found ${matches.length} symbol match(es):`,
      ...walkNotes,
      ...(note ? [note] : []),
      ...matches,
    ].join("\n");
  }

  private async executeFindReferences(request: FindReferencesToolRequest) {
    const walkResult = await this.walkFiles(request.path);
    const files = walkResult.files;
    const caseSensitive = request.caseSensitive ?? false;
    const flags = caseSensitive ? "" : "i";
    const escapedSymbol = escapeRegExp(request.symbol);
    const definitionPatterns = buildSymbolDefinitionPatterns(escapedSymbol, flags);
    const referencePattern = buildSymbolReferencePattern(escapedSymbol, caseSensitive);
    const limit = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    const matches: string[] = [];
    let scannedOversizedFiles = 0;
    let partialScanCount = 0;
    const walkNotes = this.formatWalkFilesNotes(walkResult);

    for (const file of files) {
      const info = await stat(file.absolutePath);
      if (info.size > this.rules.maxReadBytes) {
        scannedOversizedFiles += 1;
        const scanBytes = this.getLargeFileScanByteLimit(info.size);
        if (scanBytes < info.size) {
          partialScanCount += 1;
        }
        await this.scanTextFileLines(
          file.absolutePath,
          scanBytes,
          (line, lineNumber) => {
            const trimmed = line.trim();
            if (!trimmed) {
              return false;
            }
            if (definitionPatterns.some(pattern => pattern.test(trimmed))) {
              return false;
            }
            if (!referencePattern.test(line)) {
              return false;
            }
            matches.push(
              `${file.workspacePath}:${lineNumber} | ${clipSnippet(trimmed)}`
            );
            return matches.length >= limit;
          }
        );
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} reference match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n");
        }
        continue;
      }
      const content = await readFile(file.absolutePath, "utf8");
      const lines = splitFileLines(content);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (definitionPatterns.some(pattern => pattern.test(trimmed))) {
          continue;
        }
        if (!referencePattern.test(line)) {
          continue;
        }
        matches.push(`${file.workspacePath}:${index + 1} | ${clipSnippet(trimmed)}`);
        if (matches.length >= limit) {
          const note = this.formatLargeFileSearchNote(
            scannedOversizedFiles,
            partialScanCount
          );
          return [
            `Found ${matches.length} reference match(es):`,
            ...walkNotes,
            ...(note ? [note] : []),
            ...matches,
          ].join("\n");
        }
      }
    }

    const note = this.formatLargeFileSearchNote(
      scannedOversizedFiles,
      partialScanCount
    );
    if (matches.length === 0) {
      return [`(no reference matches for symbol: ${request.symbol})`, ...walkNotes, note]
        .filter(Boolean)
        .join("\n");
    }

    return [
      `Found ${matches.length} reference match(es):`,
      ...walkNotes,
      ...(note ? [note] : []),
      ...matches,
    ].join("\n");
  }

  private async executeTsHover(request: TsHoverToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureTypescriptLanguageFile(request.path, absolutePath);
    const info = await this.getTsServerClient().hover(
      absolutePath,
      request.line,
      request.column
    );
    if (!info) {
      return `(no TypeScript quick info at: ${request.path}:${request.line}:${request.column})`;
    }

    const sections = [
      `kind: ${info.kind}${info.kindModifiers ? ` (${info.kindModifiers})` : ""}`,
      `range: ${request.path}:${this.formatTsLocation(info.start)}-${this.formatTsLocation(info.end)}`,
      info.displayString ? `display: ${info.displayString}` : "",
      info.documentation ? `documentation:\n${info.documentation}` : "",
      info.tags.length > 0 ? ["tags:", ...info.tags.map(tag => this.formatTsTag(tag))].join("\n") : "",
    ].filter(Boolean);
    return sections.join("\n");
  }

  private async executeTsDefinition(request: TsDefinitionToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureTypescriptLanguageFile(request.path, absolutePath);
    const result = await this.getTsServerClient().definition(
      absolutePath,
      request.line,
      request.column
    );
    if (!result || result.definitions.length === 0) {
      return `(no TypeScript definitions at: ${request.path}:${request.line}:${request.column})`;
    }

    const formattedDefinitions = await Promise.all(
      result.definitions.map(definition => this.formatTsFileSpan(definition))
    );
    return [
      `Found ${formattedDefinitions.length} TypeScript definition(s):`,
      ...formattedDefinitions,
    ].join("\n");
  }

  private async executeTsReferences(request: TsReferencesToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureTypescriptLanguageFile(request.path, absolutePath);
    const result = await this.getTsServerClient().references(
      absolutePath,
      request.line,
      request.column
    );
    const refs = result?.refs ?? [];
    const limitedRefs = refs.slice(0, request.maxResults ?? DEFAULT_SEARCH_RESULTS);
    if (limitedRefs.length === 0) {
      return `(no TypeScript references at: ${request.path}:${request.line}:${request.column})`;
    }

    return [
      `Found ${limitedRefs.length} TypeScript reference(s):`,
      ...(result?.symbolDisplayString
        ? [`symbol: ${result.symbolDisplayString}`]
        : result?.symbolName
          ? [`symbol: ${result.symbolName}`]
          : []),
      ...limitedRefs.map(reference => {
        const workspacePath = this.formatTsWorkspacePath(reference.file);
        return [
          `${workspacePath}:${this.formatTsLocation(reference.start)}-${this.formatTsLocation(reference.end)}`,
          reference.isDefinition ? "[definition]" : "",
          reference.isWriteAccess ? "[write]" : "[read]",
          reference.lineText ? `| ${clipSnippet(reference.lineText)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      }),
    ].join("\n");
  }

  private async executeTsDiagnostics(request: TsDiagnosticsToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureTypescriptLanguageFile(request.path, absolutePath);
    const result = await this.getTsServerClient().diagnostics(absolutePath);
    const entries = [
      ...result.syntactic.map(diagnostic =>
        this.formatTsDiagnostic(diagnostic, "syntactic")
      ),
      ...result.semantic.map(diagnostic =>
        this.formatTsDiagnostic(diagnostic, "semantic")
      ),
      ...result.suggestion.map(diagnostic =>
        this.formatTsDiagnostic(diagnostic, "suggestion")
      ),
    ];
    const limitedEntries = entries.slice(0, request.maxResults ?? DEFAULT_SEARCH_RESULTS);
    if (limitedEntries.length === 0) {
      return [
        `(no TypeScript diagnostics for: ${request.path})`,
        ...((result.warnings ?? []).length > 0
          ? ["notes:", ...(result.warnings ?? []).map(warning => `- ${warning}`)]
          : []),
      ].join("\n");
    }

    return [
      `Found ${limitedEntries.length} TypeScript diagnostic(s):`,
      ...((result.warnings ?? []).length > 0
        ? ["notes:", ...(result.warnings ?? []).map(warning => `- ${warning}`)]
        : []),
      ...limitedEntries,
    ].join("\n");
  }

  private async executeTsPrepareRename(request: TsPrepareRenameToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureTypescriptLanguageFile(request.path, absolutePath);
    const result = await this.getTsServerClient().rename(
      absolutePath,
      request.line,
      request.column,
      {
        findInComments: request.findInComments,
        findInStrings: request.findInStrings,
      }
    );

    if (!result) {
      return `(TypeScript rename preview unavailable at: ${request.path}:${request.line}:${request.column})`;
    }
    if (!result.info.canRename) {
      return `TypeScript rename unavailable: ${result.info.localizedErrorMessage}`;
    }

    const allLocations = result.locs.flatMap(group =>
      group.locs.map(location => ({ file: group.file, location }))
    );
    const limitedLocations = allLocations.slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    const formattedLocations = await Promise.all(
      limitedLocations.map(entry =>
        this.formatTsRenameLocation(entry.file, entry.location, request.newName)
      )
    );
    const workspacePlanBlocks: string[] = [];
    const skippedPlanPaths: string[] = [];
    for (const group of result.locs) {
      const groupAbsolutePath = resolve(group.file);
      if (!this.canAccessAbsolutePathInsideWorkspaceRoot(groupAbsolutePath)) {
        skippedPlanPaths.push(this.formatTsWorkspacePath(groupAbsolutePath));
        continue;
      }
      const before = await readFile(groupAbsolutePath, "utf8");
      const after = this.applyTsRenameLocationsToContent(
        before,
        group.locs,
        request.newName
      );
      if (before === after) {
        continue;
      }
      workspacePlanBlocks.push(
        this.formatApplyPatchPlan(
          this.normalizeWorkspacePathFromAbsolute(groupAbsolutePath),
          before,
          after
        )
      );
    }

    const baseBody = [
      `Prepared TypeScript rename preview:`,
      `symbol: ${result.info.fullDisplayName || result.info.displayName}`,
      `rename_to: ${request.newName}`,
      `occurrences: ${allLocations.length}`,
      `files: ${new Set(allLocations.map(entry => this.formatTsWorkspacePath(resolve(entry.file)))).size}`,
      ...(typeof request.findInComments === "boolean"
        ? [`include_comments: ${request.findInComments}`]
        : []),
      ...(typeof request.findInStrings === "boolean"
        ? [`include_strings: ${request.findInStrings}`]
        : []),
      formattedLocations.length > 0 ? "edits:" : "",
      ...formattedLocations,
      `apply_patch_plan_files: ${workspacePlanBlocks.length}`,
      `apply_patch_plan_inline: 0/${workspacePlanBlocks.length}`,
      ...(skippedPlanPaths.length > 0
        ? [
            `apply_patch_plan_skipped_outside_workspace: ${skippedPlanPaths.length}`,
            ...skippedPlanPaths.slice(0, 5).map(path => `- ${path}`),
            ...(skippedPlanPaths.length > 5
              ? [`- ... ${skippedPlanPaths.length - 5} more path(s)`]
              : []),
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n");

    let inlinePlanCount = 0;
    let omittedPlanCount = 0;
    let body = baseBody.replace(
      `apply_patch_plan_inline: 0/${workspacePlanBlocks.length}`,
      `apply_patch_plan_inline: ${inlinePlanCount}/${workspacePlanBlocks.length}`
    );
    for (const planBlock of workspacePlanBlocks) {
      const nextBody = `${body}\n${planBlock}`;
      if (nextBody.length > MAX_COMMAND_OUTPUT_CHARS) {
        omittedPlanCount += 1;
        continue;
      }
      body = nextBody;
      inlinePlanCount += 1;
    }
    body = body.replace(
      `apply_patch_plan_inline: 0/${workspacePlanBlocks.length}`,
      `apply_patch_plan_inline: ${inlinePlanCount}/${workspacePlanBlocks.length}`
    );
    if (omittedPlanCount > 0) {
      const omissionLine = `apply_patch_plan_omitted_for_size: ${omittedPlanCount}`;
      if (`${body}\n${omissionLine}`.length <= MAX_COMMAND_OUTPUT_CHARS) {
        body = `${body}\n${omissionLine}`;
      }
    }
    return body;
  }

  private async executeLspHover(request: LspHoverToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const info = await session.hover(absolutePath, request.line, request.column);
    if (!info) {
      return `(no LSP hover at: ${request.path}:${request.line}:${request.column})`;
    }

    return [
      `server: ${session.getInfo().serverId}`,
      info.range ? `range: ${request.path}:${this.formatLspRange(info.range)}` : "",
      `contents:\n${info.contents}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async executeLspDefinition(request: LspDefinitionToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const definitions = await session.definition(absolutePath, request.line, request.column);
    const limitedDefinitions = definitions.slice(0, DEFAULT_SEARCH_RESULTS);
    if (limitedDefinitions.length === 0) {
      return `(no LSP definitions at: ${request.path}:${request.line}:${request.column})`;
    }
    const formattedDefinitions = await Promise.all(
      limitedDefinitions.map(definition => this.formatLspLocation(definition))
    );
    return [
      `Found ${formattedDefinitions.length} LSP definition(s):`,
      `server: ${session.getInfo().serverId}`,
      ...formattedDefinitions,
    ].join("\n");
  }

  private async executeLspImplementation(request: LspImplementationToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const implementations = await session.implementation(
      absolutePath,
      request.line,
      request.column
    );
    const limitedImplementations = implementations.slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    if (limitedImplementations.length === 0) {
      return `(no LSP implementations at: ${request.path}:${request.line}:${request.column})`;
    }
    const formattedImplementations = await Promise.all(
      limitedImplementations.map(implementation =>
        this.formatLspLocation(implementation)
      )
    );
    return [
      `Found ${formattedImplementations.length} LSP implementation(s):`,
      `server: ${session.getInfo().serverId}`,
      ...formattedImplementations,
    ].join("\n");
  }

  private async executeLspTypeDefinition(request: LspTypeDefinitionToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const typeDefinitions = await session.typeDefinition(
      absolutePath,
      request.line,
      request.column
    );
    const limitedTypeDefinitions = typeDefinitions.slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    if (limitedTypeDefinitions.length === 0) {
      return `(no LSP type definitions at: ${request.path}:${request.line}:${request.column})`;
    }
    const formattedTypeDefinitions = await Promise.all(
      limitedTypeDefinitions.map(typeDefinition =>
        this.formatLspLocation(typeDefinition)
      )
    );
    return [
      `Found ${formattedTypeDefinitions.length} LSP type definition(s):`,
      `server: ${session.getInfo().serverId}`,
      ...formattedTypeDefinitions,
    ].join("\n");
  }

  private async executeLspReferences(request: LspReferencesToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const references = await session.references(absolutePath, request.line, request.column);
    const limitedReferences = references.slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    if (limitedReferences.length === 0) {
      return `(no LSP references at: ${request.path}:${request.line}:${request.column})`;
    }
    const formattedReferences = await Promise.all(
      limitedReferences.map(reference => this.formatLspLocation(reference))
    );
    return [
      `Found ${formattedReferences.length} LSP reference(s):`,
      `server: ${session.getInfo().serverId}`,
      ...formattedReferences,
    ].join("\n");
  }

  private async executeLspWorkspaceSymbols(request: LspWorkspaceSymbolsToolRequest) {
    const session = await this.getLspSessionForWorkspaceQuery(
      request.path,
      request.serverId
    );
    const symbols = await session.workspaceSymbols(request.query);
    const limitedSymbols = symbols.slice(0, request.maxResults ?? DEFAULT_SEARCH_RESULTS);
    if (limitedSymbols.length === 0) {
      return `(no LSP workspace symbols for: ${request.query})`;
    }
    const formattedSymbols = await Promise.all(
      limitedSymbols.map(symbol => this.formatLspWorkspaceSymbolEntry(symbol))
    );
    return [
      `Found ${formattedSymbols.length} LSP workspace symbol(s):`,
      `server: ${session.getInfo().serverId}`,
      `query: ${request.query}`,
      ...formattedSymbols,
    ].join("\n");
  }

  private async executeLspDocumentSymbols(request: LspDocumentSymbolsToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const symbols = await session.documentSymbols(absolutePath);
    const flattened = this.flattenLspDocumentSymbols(symbols).slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    if (flattened.length === 0) {
      return `(no LSP document symbols for: ${request.path})`;
    }
    return [
      `Found ${flattened.length} LSP document symbol(s):`,
      `server: ${session.getInfo().serverId}`,
      ...flattened.map(entry =>
        this.formatLspDocumentSymbolEntry(entry.symbol, entry.depth)
      ),
    ].join("\n");
  }

  private async executeLspDiagnostics(request: LspDiagnosticsToolRequest) {
    const absolutePath = this.resolvePath(request.path);
    await this.ensureRegularFile(request.path, absolutePath, "LSP tools");
    const session = await this.getLspManager().getSession(absolutePath, {
      serverId: request.serverId,
    });
    const diagnostics = await session.diagnostics(absolutePath);
    const limitedDiagnostics = diagnostics.slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    if (limitedDiagnostics.length === 0) {
      return `(no LSP diagnostics for: ${request.path})`;
    }
    return [
      `Found ${limitedDiagnostics.length} LSP diagnostic(s):`,
      `server: ${session.getInfo().serverId}`,
      ...limitedDiagnostics.map(diagnostic =>
        this.formatLspDiagnostic(absolutePath, diagnostic)
      ),
    ].join("\n");
  }

  private async executeLspPrepareRename(request: LspPrepareRenameToolRequest) {
    const resolved = await this.resolveLspRenamePlan(request);
    const { session, prepare, workspaceEdit, plan } = resolved;
    if (!prepare) {
      return `(LSP rename preview unavailable at: ${request.path}:${request.line}:${request.column})`;
    }
    if (!workspaceEdit) {
      return `LSP rename unavailable: no workspace edit was returned.`;
    }

    const groupedEdits = this.collectLspWorkspaceEdits(workspaceEdit);
    const allLocations = groupedEdits.flatMap(group =>
      group.edits.map(edit => ({ uri: group.uri, edit }))
    );
    const limitedLocations = allLocations.slice(
      0,
      request.maxResults ?? DEFAULT_SEARCH_RESULTS
    );
    const formattedLocations = await Promise.all(
      limitedLocations.map(entry => this.formatLspRenameEdit(entry.uri, entry.edit))
    );

    const workspacePlanBlocks = plan ? this.formatLspWorkspaceApplyPlanBlocks(plan) : [];
    const skippedPlanPaths = plan?.skippedPaths ?? [];

    const baseBody = [
      `Prepared LSP rename preview:`,
      `server: ${session.getInfo().serverId}`,
      `symbol: ${prepare.placeholder || "(unknown symbol)"}`,
      `rename_to: ${request.newName}`,
      `occurrences: ${allLocations.length}`,
      `files: ${new Set(
        allLocations.map(entry => {
          const absolutePath = this.getAbsolutePathFromLspUri(entry.uri);
          return absolutePath ? this.formatTsWorkspacePath(absolutePath) : entry.uri;
        })
      ).size}`,
      formattedLocations.length > 0 ? "edits:" : "",
      ...formattedLocations,
      `apply_patch_plan_files: ${workspacePlanBlocks.length}`,
      `apply_patch_plan_inline: 0/${workspacePlanBlocks.length}`,
      ...(skippedPlanPaths.length > 0
        ? [
            `apply_patch_plan_skipped_outside_workspace: ${skippedPlanPaths.length}`,
            ...skippedPlanPaths.slice(0, 5).map(path => `- ${path}`),
            ...(skippedPlanPaths.length > 5
              ? [`- ... ${skippedPlanPaths.length - 5} more path(s)`]
              : []),
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n");

    let inlinePlanCount = 0;
    let omittedPlanCount = 0;
    let body = baseBody.replace(
      `apply_patch_plan_inline: 0/${workspacePlanBlocks.length}`,
      `apply_patch_plan_inline: ${inlinePlanCount}/${workspacePlanBlocks.length}`
    );
    for (const planBlock of workspacePlanBlocks) {
      const nextBody = `${body}\n${planBlock}`;
      if (nextBody.length > MAX_COMMAND_OUTPUT_CHARS) {
        omittedPlanCount += 1;
        continue;
      }
      body = nextBody;
      inlinePlanCount += 1;
    }
    body = body.replace(
      `apply_patch_plan_inline: 0/${workspacePlanBlocks.length}`,
      `apply_patch_plan_inline: ${inlinePlanCount}/${workspacePlanBlocks.length}`
    );
    if (omittedPlanCount > 0) {
      const omissionLine = `apply_patch_plan_omitted_for_size: ${omittedPlanCount}`;
      if (`${body}\n${omissionLine}`.length <= MAX_COMMAND_OUTPUT_CHARS) {
        body = `${body}\n${omissionLine}`;
      }
    }
    return body;
  }

  private async executeResolvedLspRename(
    request: LspRenameToolRequest,
    resolved: ResolvedLspRenamePlan,
    options?: { ensureFresh?: boolean }
  ) {
    const { session, prepare, workspaceEdit, plan } = resolved;
    if (!prepare) {
      throw new Error(
        `LSP rename unavailable at: ${request.path}:${request.line}:${request.column}`
      );
    }
    if (!workspaceEdit || !plan) {
      throw new Error("LSP rename unavailable: no workspace edit was returned.");
    }
    if (options?.ensureFresh) {
      await this.ensureLspWorkspaceEditPlanFresh(plan);
    }
    if (plan.skippedPaths.length > 0) {
      await this.applyLspWorkspaceEditPlan(request, plan);
    }
    if (plan.files.length === 0) {
      return [
        "Applied LSP rename:",
        `server: ${session.getInfo().serverId}`,
        `symbol: ${prepare.placeholder || "(unknown symbol)"}`,
        `rename_to: ${request.newName}`,
        "changes: none",
      ].join("\n");
    }

    await this.applyLspWorkspaceEditPlan(request, plan);
    return [
      "Applied LSP rename:",
      `server: ${session.getInfo().serverId}`,
      `symbol: ${prepare.placeholder || "(unknown symbol)"}`,
      `rename_to: ${request.newName}`,
      `files: ${plan.files.length}`,
      `occurrences: ${plan.totalEdits}`,
      ...plan.files.map(file => {
        const diff = summarizeMutationDiff(file.before, file.after);
        return `- ${file.workspacePath} (+${diff.additions} -${diff.deletions})`;
      }),
    ].join("\n");
  }

  private async executeLspRename(request: LspRenameToolRequest) {
    return this.executeResolvedLspRename(
      request,
      await this.resolveLspRenamePlan(request)
    );
  }

  private formatLspCodeActionListEntry(action: LspCodeAction) {
    const details = [
      action.kind ? `[${action.kind}]` : "",
      action.isPreferred ? "[preferred]" : "",
      action.disabledReason ? `[disabled: ${action.disabledReason}]` : "",
      action.edit ? "[edit]" : "",
      action.hasCommand ? "[command]" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `- ${action.title}${details ? ` ${details}` : ""}`;
  }

  private async executeResolvedLspCodeAction(
    request: LspCodeActionsToolRequest,
    resolved: ResolvedLspCodeActionPlan,
    options?: { ensureFresh?: boolean }
  ) {
    const { session, actions, selectedAction, plan } = resolved;
    if (!selectedAction) {
      const available = actions.slice(0, 8).map(action => `- ${action.title}`);
      throw new Error(
        [
          `LSP code action not found: ${request.title}`,
          available.length > 0 ? "available_titles:" : "",
          ...available,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    if (selectedAction.disabledReason) {
      throw new Error(
        `LSP code action is disabled: ${selectedAction.title} (${selectedAction.disabledReason})`
      );
    }
    if (!selectedAction.edit) {
      if (selectedAction.hasCommand) {
        throw new Error(
          `LSP code action requires command execution and is not supported yet: ${selectedAction.title}`
        );
      }
      throw new Error(`LSP code action has no editable workspace changes: ${selectedAction.title}`);
    }
    if (!plan) {
      throw new Error(`LSP code action has no editable workspace changes: ${selectedAction.title}`);
    }
    if (options?.ensureFresh) {
      await this.ensureLspWorkspaceEditPlanFresh(plan);
    }
    if (plan.skippedPaths.length > 0) {
      await this.applyLspWorkspaceEditPlan(request, plan);
    }
    if (plan.files.length === 0) {
      return [
        "Applied LSP code action:",
        `server: ${session.getInfo().serverId}`,
        `title: ${selectedAction.title}`,
        selectedAction.kind ? `kind: ${selectedAction.kind}` : "",
        "changes: none",
      ]
        .filter(Boolean)
        .join("\n");
    }

    await this.applyLspWorkspaceEditPlan(request, plan);
    return [
      "Applied LSP code action:",
      `server: ${session.getInfo().serverId}`,
      `title: ${selectedAction.title}`,
      selectedAction.kind ? `kind: ${selectedAction.kind}` : "",
      `files: ${plan.files.length}`,
      `edits: ${plan.totalEdits}`,
      ...plan.files.map(file => {
        const diff = summarizeMutationDiff(file.before, file.after);
        return `- ${file.workspacePath} (+${diff.additions} -${diff.deletions})`;
      }),
      selectedAction.hasCommand ? "note: command side effects were not executed." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async executeLspCodeActions(request: LspCodeActionsToolRequest) {
    if (!request.title?.trim()) {
      const { session, actions } = await this.listLspCodeActions(request);
      const limitedActions = actions.slice(0, request.maxResults ?? DEFAULT_SEARCH_RESULTS);
      if (limitedActions.length === 0) {
        return `(no LSP code actions at: ${request.path}:${request.line}:${request.column})`;
      }
      return [
        `Found ${limitedActions.length} LSP code action(s):`,
        `server: ${session.getInfo().serverId}`,
        request.kind ? `kind_filter: ${request.kind}` : "",
        ...limitedActions.map(action => this.formatLspCodeActionListEntry(action)),
      ]
        .filter(Boolean)
        .join("\n");
    }

    return this.executeResolvedLspCodeAction(
      request,
      await this.resolveLspCodeActionPlan(request)
    );
  }

  private async executeResolvedLspFormatDocument(
    request: LspFormatDocumentToolRequest,
    resolved: ResolvedLspFormatDocumentPlan,
    options?: { ensureFresh?: boolean }
  ) {
    const { session, plan } = resolved;
    if (options?.ensureFresh) {
      await this.ensureLspWorkspaceEditPlanFresh(plan);
    }
    if (plan.skippedPaths.length > 0) {
      await this.applyLspWorkspaceEditPlan(request, plan);
    }
    if (plan.files.length === 0) {
      return [
        "Applied LSP document format:",
        `server: ${session.getInfo().serverId}`,
        "changes: none",
      ].join("\n");
    }

    await this.applyLspWorkspaceEditPlan(request, plan);
    return [
      "Applied LSP document format:",
      `server: ${session.getInfo().serverId}`,
      typeof request.tabSize === "number" ? `tab_size: ${request.tabSize}` : "",
      typeof request.insertSpaces === "boolean"
        ? `insert_spaces: ${request.insertSpaces}`
        : "",
      `files: ${plan.files.length}`,
      `edits: ${plan.totalEdits}`,
      ...plan.files.map(file => {
        const diff = summarizeMutationDiff(file.before, file.after);
        return `- ${file.workspacePath} (+${diff.additions} -${diff.deletions})`;
      }),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async executeLspFormatDocument(request: LspFormatDocumentToolRequest) {
    return this.executeResolvedLspFormatDocument(
      request,
      await this.resolveLspFormatDocumentPlan(request)
    );
  }

  private async findGitRepoRoot(inputPath: string) {
    const workspaceRoot = resolve(this.rules.workspaceRoot);
    let current = this.resolvePath(inputPath);

    try {
      const info = await stat(current);
      if (info.isFile()) {
        current = dirname(current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        current = dirname(current);
      } else {
        throw error;
      }
    }

    while (true) {
      try {
        await stat(resolve(current, ".git"));
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (current === workspaceRoot) {
        break;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    throw new Error(`git repository not found for path: ${inputPath}`);
  }

  private getGitScopePath(repoRoot: string, inputPath: string) {
    const absolute = this.resolvePath(inputPath);
    const relativePath = relative(repoRoot, absolute).replace(/\\/g, "/");
    return relativePath && relativePath !== "." ? relativePath : null;
  }

  private formatGitOutput(label: string, result: CommandExecutionResult) {
    const sections: string[] = [];
    if (typeof result.output === "string" && result.output.trim()) {
      sections.push(result.output.trim());
    } else {
      if (result.stdout?.trim()) {
        sections.push(result.stdout.trim());
      }
      if (result.stderr?.trim()) {
        sections.push(result.stderr.trim());
      }
    }

    const body = sections.join("\n").trim();
    const bounded = appendBoundedOutput("", body, MAX_COMMAND_OUTPUT_CHARS);
    if (result.status !== "completed" || result.exitCode !== 0) {
      const exitDisplay =
        result.status === "timed_out"
          ? "timeout"
          : result.exitCode === null
            ? "unknown"
            : String(result.exitCode);
      throw new Error(body || `${label} failed with exit ${exitDisplay}`);
    }

    if (!bounded.text.trim()) {
      return "";
    }

    return bounded.truncated
      ? `${bounded.text}\n... output truncated at ${MAX_COMMAND_OUTPUT_CHARS} chars`
      : bounded.text;
  }

  private async runGit(
    args: string[],
    cwd: string
  ): Promise<CommandExecutionResult> {
    if (this.options.gitRunner) {
      try {
        const result = await this.options.gitRunner(args, cwd);
        if (typeof result === "string") {
          const bounded = appendBoundedOutput("", result, MAX_COMMAND_OUTPUT_CHARS);
          return {
            status: "completed",
            exitCode: 0,
            output: bounded.text,
            truncated: bounded.truncated,
          };
        }
        return result;
      } catch (error) {
        return {
          status: "failed",
          exitCode: null,
          stderr: error instanceof Error ? error.message : String(error),
          truncated: false,
        };
      }
    }

    return await new Promise<CommandExecutionResult>(resolvePromise => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("git", args, {
          cwd,
          shell: false,
        });
      } catch (error) {
        resolvePromise({
          status: "failed",
          exitCode: null,
          stderr: error instanceof Error ? error.message : String(error),
          truncated: false,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputTruncated = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        resolvePromise({
          status: "timed_out",
          exitCode: null,
          stderr: `Command timed out after ${COMMAND_TIMEOUT_MS}ms.`,
          stdout,
          truncated: outputTruncated,
        });
      }, COMMAND_TIMEOUT_MS);

      const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "stdout") {
          const next = appendBoundedOutput(stdout, text, MAX_COMMAND_OUTPUT_CHARS);
          stdout = next.text;
          outputTruncated = outputTruncated || next.truncated;
        } else {
          const next = appendBoundedOutput(stderr, text, MAX_COMMAND_OUTPUT_CHARS);
          stderr = next.text;
          outputTruncated = outputTruncated || next.truncated;
        }
      };

      child.stdout?.on("data", chunk => appendChunk("stdout", chunk));
      child.stderr?.on("data", chunk => appendChunk("stderr", chunk));
      child.on("error", error => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          status: "failed",
          exitCode: null,
          stderr: error.message,
          stdout,
          truncated: outputTruncated,
        });
      });
      child.on("close", code => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          status: code === 0 ? "completed" : "failed",
          exitCode: code ?? null,
          stdout,
          stderr,
          truncated: outputTruncated,
        });
      });
    });
  }

  private async executeGitStatus(request: GitStatusToolRequest) {
    const repoRoot = await this.findGitRepoRoot(request.path);
    const scopePath = this.getGitScopePath(repoRoot, request.path);
    const args = ["status", "--short", "--branch"];
    if (scopePath) {
      args.push("--", scopePath);
    }
    const statusOutput = this.formatGitOutput(
      "git status",
      await this.runGit(args, repoRoot)
    );
    return [
      `repo: ${this.normalizeWorkspacePath(relative(this.rules.workspaceRoot, repoRoot) || ".")}`,
      `scope: ${scopePath ?? "."}`,
      statusOutput || "(clean working tree)",
    ].join("\n");
  }

  private async executeGitDiff(request: GitDiffToolRequest) {
    const repoRoot = await this.findGitRepoRoot(request.path);
    const scopePath = this.getGitScopePath(repoRoot, request.path);
    const repoLabel = this.normalizeWorkspacePath(relative(this.rules.workspaceRoot, repoRoot) || ".");
    const scopeArgs = scopePath ? ["--", scopePath] : [];
    const unstaged = this.formatGitOutput(
      "git diff",
      await this.runGit(["diff", "--no-ext-diff", "--minimal", ...scopeArgs], repoRoot)
    );
    const staged = this.formatGitOutput(
      "git diff --cached",
      await this.runGit(["diff", "--cached", "--no-ext-diff", "--minimal", ...scopeArgs], repoRoot)
    );

    return [
      `repo: ${repoLabel}`,
      `scope: ${scopePath ?? "."}`,
      "[unstaged]",
      unstaged || "(none)",
      "",
      "[staged]",
      staged || "(none)",
    ].join("\n");
  }

  private async executeGitLog(request: GitLogToolRequest) {
    const repoRoot = await this.findGitRepoRoot(request.path);
    const scopePath = this.getGitScopePath(repoRoot, request.path);
    const repoLabel = this.normalizeWorkspacePath(relative(this.rules.workspaceRoot, repoRoot) || ".");
    const args = [
      "log",
      `-n${normalizeGitLogLimit(request.maxResults)}`,
      "--date=short",
      "--pretty=format:%h %ad %s",
    ];
    if (scopePath) {
      args.push("--", scopePath);
    }
    const output = this.formatGitOutput("git log", await this.runGit(args, repoRoot));

    return [
      `repo: ${repoLabel}`,
      `scope: ${scopePath ?? "."}`,
      output || "(no commits found)",
    ].join("\n");
  }

  private async executeGitShow(request: GitShowToolRequest) {
    const repoRoot = await this.findGitRepoRoot(request.path);
    const scopePath = this.getGitScopePath(repoRoot, request.path);
    const repoLabel = this.normalizeWorkspacePath(relative(this.rules.workspaceRoot, repoRoot) || ".");
    const args = [
      "show",
      "--stat",
      "--patch",
      "--no-ext-diff",
      "--minimal",
      request.revision,
    ];
    if (scopePath) {
      args.push("--", scopePath);
    }
    const output = this.formatGitOutput("git show", await this.runGit(args, repoRoot));

    return [
      `repo: ${repoLabel}`,
      `scope: ${scopePath ?? "."}`,
      `revision: ${request.revision}`,
      output || "(no output for revision in scope)",
    ].join("\n");
  }

  private async executeGitBlame(request: GitBlameToolRequest) {
    const absolute = this.resolvePath(request.path);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`git_blame only supports files: ${request.path}`);
    }

    const repoRoot = await this.findGitRepoRoot(request.path);
    const scopePath = this.getGitScopePath(repoRoot, request.path);
    if (!scopePath) {
      throw new Error(`git_blame requires a file path inside the repository: ${request.path}`);
    }

    const repoLabel = this.normalizeWorkspacePath(relative(this.rules.workspaceRoot, repoRoot) || ".");
    const startLine = request.startLine ?? request.endLine;
    const endLine = request.endLine ?? request.startLine;
    const args = ["blame", "--date=short"];
    if (typeof startLine === "number" && typeof endLine === "number") {
      args.push("-L", `${startLine},${endLine}`);
    }
    args.push("--", scopePath);

    const output = this.formatGitOutput("git blame", await this.runGit(args, repoRoot));

    return [
      `repo: ${repoLabel}`,
      `scope: ${scopePath}`,
      typeof startLine === "number" && typeof endLine === "number"
        ? `lines: ${startLine}-${endLine}`
        : "",
      output || "(no blame output)",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async execute(request: ToolRequest): Promise<string> {
    if (request.action === "run_command") {
      return this.executeCommand(request);
    }
    if (request.action === "run_shell") {
      return this.executeShell(request);
    }
    if (request.action === "open_shell") {
      return this.executeOpenShell(request);
    }
    if (request.action === "write_shell") {
      return this.executeWriteShell(request);
    }
    if (request.action === "read_shell") {
      return this.executeReadShell();
    }
    if (request.action === "shell_status") {
      return this.executeShellStatus();
    }
    if (request.action === "interrupt_shell") {
      return this.executeInterruptShell();
    }
    if (request.action === "close_shell") {
      return this.executeCloseShell();
    }

    const abs = this.resolvePath(request.path);

    switch (request.action) {
      case "read_file": {
        const info = await stat(abs);
        if (info.size > this.rules.maxReadBytes) {
          throw new Error(
            `File too large (${info.size} bytes). max_read_bytes=${this.rules.maxReadBytes}`
          );
        }
        const content = await readFile(abs, "utf8");
        return content.length > 0 ? content : "(empty file)";
      }
      case "read_files":
        return this.executeReadFiles(request);
      case "read_range":
        return this.executeReadRange(request);
      case "read_json":
        return this.executeReadJson(request);
      case "read_yaml":
        return this.executeReadYaml(request);
      case "list_dir": {
        const entries = await readdir(abs, { withFileTypes: true });
        if (entries.length === 0) {
          return "(empty directory)";
        }
        return entries
          .map(entry => `${entry.isDirectory() ? "[D]" : "[F]"} ${entry.name}`)
          .join("\n");
      }
      case "stat_path": {
        const info = await stat(abs);
        const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
        return [
          `path: ${request.path}`,
          `kind: ${kind}`,
          `size: ${info.size}`,
          `mtime: ${info.mtime.toISOString()}`,
        ].join("\n");
      }
      case "stat_paths":
        return this.executeStatPaths(request);
      case "outline_file":
        return this.executeOutlineFile(request);
      case "find_files":
        return this.executeFindFiles(request);
      case "find_symbol":
        return this.executeFindSymbol(request);
      case "find_references":
        return this.executeFindReferences(request);
      case "search_text":
        return this.executeSearchText(request);
      case "search_text_context":
        return this.executeSearchTextContext(request);
      case "git_status":
        return this.executeGitStatus(request);
      case "git_diff":
        return this.executeGitDiff(request);
      case "git_log":
        return this.executeGitLog(request);
      case "git_show":
        return this.executeGitShow(request);
      case "git_blame":
        return this.executeGitBlame(request);
      case "ts_hover":
        return this.executeTsHover(request);
      case "ts_definition":
        return this.executeTsDefinition(request);
      case "ts_references":
        return this.executeTsReferences(request);
      case "ts_diagnostics":
        return this.executeTsDiagnostics(request);
      case "ts_prepare_rename":
        return this.executeTsPrepareRename(request);
      case "lsp_hover":
        return this.executeLspHover(request);
      case "lsp_definition":
        return this.executeLspDefinition(request);
      case "lsp_implementation":
        return this.executeLspImplementation(request);
      case "lsp_type_definition":
        return this.executeLspTypeDefinition(request);
      case "lsp_references":
        return this.executeLspReferences(request);
      case "lsp_workspace_symbols":
        return this.executeLspWorkspaceSymbols(request);
      case "lsp_document_symbols":
        return this.executeLspDocumentSymbols(request);
      case "lsp_diagnostics":
        return this.executeLspDiagnostics(request);
      case "lsp_prepare_rename":
        return this.executeLspPrepareRename(request);
      case "lsp_rename":
        return this.executeLspRename(request);
      case "lsp_code_actions":
        return this.executeLspCodeActions(request);
      case "lsp_format_document":
        return this.executeLspFormatDocument(request);
      case "create_file": {
        const content = request.content ?? "";
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, { flag: "wx" });
        this.pushUndoEntry({
          kind: "delete_path",
          path: this.normalizeWorkspacePath(request.path),
          sourceAction: request.action,
        });
        this.noteFilesystemMutation();
        return formatConfirmedFileMutationReceipt(
          request.action,
          request.path,
          "",
          content,
          "file now exists and content was written successfully"
        );
      }
      case "create_dir": {
        const existedBefore = await this.pathExists(request.path);
        await mkdir(abs, { recursive: true });
        if (!existedBefore) {
          this.pushUndoEntry({
            kind: "delete_path",
            path: this.normalizeWorkspacePath(request.path),
            sourceAction: request.action,
          });
        }
        this.noteFilesystemMutation();
        return `Created directory: ${request.path}`;
      }
      case "write_file": {
        const existedBefore = await this.pathExists(request.path);
        const before = existedBefore ? await readFile(abs) : new Uint8Array();
        const content = request.content ?? "";
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        this.pushUndoEntry({
          kind: "restore_file",
          path: this.normalizeWorkspacePath(request.path),
          existedBefore,
          content: before,
          sourceAction: request.action,
        });
        this.noteFilesystemMutation();
        return formatConfirmedFileMutationReceipt(
          request.action,
          request.path,
          existedBefore ? Buffer.from(before).toString("utf8") : "",
          content,
          existedBefore
            ? "file content was overwritten successfully"
            : "new file was created and written successfully"
        );
      }
      case "edit_file": {
        const before = await readFile(abs, "utf8");
        if (!request.find) {
          throw new Error("edit_file requires `find`.");
        }
        if (typeof request.replace !== "string") {
          throw new Error("edit_file requires `replace`.");
        }
        if (!before.includes(request.find)) {
          throw new Error("edit_file find text not found.");
        }
        const after = before.replace(request.find, request.replace);
        await writeFile(abs, after, "utf8");
        this.pushUndoEntry({
          kind: "restore_file",
          path: this.normalizeWorkspacePath(request.path),
          existedBefore: true,
          content: Buffer.from(before, "utf8"),
          sourceAction: request.action,
        });
        this.noteFilesystemMutation();
        return formatConfirmedFileMutationReceipt(
          request.action,
          request.path,
          before,
          after,
          "file content was updated successfully"
        );
      }
      case "apply_patch": {
        const before = await readFile(abs, "utf8");
        if (!request.find) {
          throw new Error("apply_patch requires `find`.");
        }
        if (typeof request.replace !== "string") {
          throw new Error("apply_patch requires `replace`.");
        }
        if (!before.includes(request.find)) {
          throw new Error("apply_patch find text not found.");
        }
        const after = before.replace(request.find, request.replace);
        await writeFile(abs, after, "utf8");
        this.pushUndoEntry({
          kind: "restore_file",
          path: this.normalizeWorkspacePath(request.path),
          existedBefore: true,
          content: Buffer.from(before, "utf8"),
          sourceAction: request.action,
        });
        this.noteFilesystemMutation();
        return formatConfirmedFileMutationReceipt(
          request.action,
          request.path,
          before,
          after,
          "patch was applied successfully and file content was updated"
        );
      }
      case "delete_file": {
        const before = await readFile(abs);
        await rm(abs, { force: false, recursive: false });
        this.pushUndoEntry({
          kind: "restore_file",
          path: this.normalizeWorkspacePath(request.path),
          existedBefore: true,
          content: before,
          sourceAction: request.action,
        });
        this.noteFilesystemMutation();
        return `Deleted file: ${request.path}`;
      }
      case "copy_path":
        return this.executeCopyPath(request);
      case "move_path":
        return this.executeMovePath(request);
    }
  }

  private async executePendingApproval(
    request: ToolRequest,
    guard?: PendingApprovalGuard
  ): Promise<string> {
    if (!guard) {
      return this.execute(request);
    }

    switch (guard.kind) {
      case "write_shell":
        this.ensureWriteShellApprovalGuardFresh(guard);
        return this.execute(request);
      case "lsp_rename":
        return this.executeResolvedLspRename(request as LspRenameToolRequest, guard.resolved, {
          ensureFresh: true,
        });
      case "lsp_code_actions":
        return this.executeResolvedLspCodeAction(
          request as LspCodeActionsToolRequest,
          guard.resolved,
          {
            ensureFresh: true,
          }
        );
      case "lsp_format_document":
        return this.executeResolvedLspFormatDocument(
          request as LspFormatDocumentToolRequest,
          guard.resolved,
          {
            ensureFresh: true,
          }
        );
    }
  }

  async handleToolCall(toolName: string, input: unknown): Promise<HandleResult> {
    const normalizedName = toolName.trim().toLowerCase();
    if (
      ![
        "file",
        "fs",
        "mcp.file",
      ].includes(normalizedName)
    ) {
      return {
        ok: false,
        message: `Unsupported tool: ${toolName}`,
      };
    }

    const request = normalizeToolInput(normalizedName, input);
    if (!request) {
      return {
        ok: false,
        message:
          describeInvalidToolInput(normalizedName, input) ??
          `Invalid tool input. Expected { action, path, content?, paths?, startLine?, endLine?, line?, column?, newName?, serverId?, title?, kind?, tabSize?, insertSpaces?, jsonPath?, yamlPath?, find?, replace?, pattern?, symbol?, query?, before?, after?, maxResults?, caseSensitive?, findInComments?, findInStrings?, destination?, revision?, command?, input?, args?, cwd? }. Received: ${summarizeInput(input)}.`,
      };
    }
    const validationError = validateRequest(request);
    if (validationError) {
      return {
        ok: false,
        message: `Invalid tool input for ${request.action}: ${validationError}`,
      };
    }

    let shellWriteAudit: ShellSessionWriteAuditResult | null = null;

    if (request.action === "run_shell") {
      try {
        const audit = this.auditShellRequest(request);
        if (audit.ok) {
          // continue
        } else {
          return {
            ok: false,
            message: `run_shell blocked: ${audit.reason ?? "Command rejected by shell auditor."}`,
          };
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (request.action === "open_shell") {
      let requestedCwd = resolve(this.rules.workspaceRoot);
      if (request.cwd) {
        try {
          requestedCwd = this.resolvePath(request.cwd);
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (
        this.shellSession &&
        !(
          this.shellSession.alive &&
          !this.shellSession.exited &&
          this.shellSession.cwd === requestedCwd
        )
      ) {
        return {
          ok: false,
          message: `open_shell blocked: persistent shell session already exists (${getShellSessionStatus(this.shellSession)}). Use close_shell first.`,
        };
      }
    }

    if (request.action === "write_shell") {
      const session = this.shellSession;
      if (!session) {
        return {
          ok: false,
          message: "write_shell blocked: no active persistent shell session. Use open_shell first.",
        };
      }
      if (!session.alive || session.exited) {
        return {
          ok: false,
          message:
            "write_shell blocked: the persistent shell session has exited. Use close_shell, then open_shell again.",
        };
      }
      if (session.busy) {
        return {
          ok: false,
          message:
            "write_shell blocked: the persistent shell session is busy. Use read_shell, shell_status, or interrupt_shell first.",
        };
      }
      shellWriteAudit = this.auditShellSessionWrite(request);
      if (!shellWriteAudit.ok) {
        return {
          ok: false,
          message: `write_shell blocked: ${shellWriteAudit.reason ?? "Shell input rejected by shell auditor."}`,
        };
      }
    }

    if (
      request.action !== "run_command" &&
      request.action !== "run_shell" &&
      !isPersistentShellAction(request.action)
    ) {
      try {
        const conflict = this.getPendingConflict(request);
        if (conflict) {
          return {
            ok: false,
            message: `Pending conflict: ${conflict.action} ${conflict.path} is already queued.`,
          };
        }

        const pendingValidationError = await this.validatePendingRequest(request);
        if (pendingValidationError) {
          return {
            ok: false,
            message: pendingValidationError,
          };
        }
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (
      request.action === "run_command" ||
      request.action === "run_shell" ||
      (request.action === "write_shell" && shellWriteAudit?.policy === "review") ||
      isMutatingLspRequest(request) ||
      (request.action !== "create_dir" &&
        !isPersistentShellAction(request.action) &&
        !isReadOnlyRequest(request) &&
        this.rules.requireReview.includes(request.action))
    ) {
      const id = crypto.randomUUID().slice(0, 8);
      const prepared = await this.preparePendingReview(request);
      const pending: PendingReviewItem = {
        id,
        request,
        preview: prepared.previewSummary,
        previewSummary: prepared.previewSummary,
        previewFull: prepared.previewFull,
        createdAt: new Date().toISOString(),
      };
      this.pending.set(id, pending);
      if (prepared.guard) {
        this.pendingApprovalGuards.set(id, prepared.guard);
      }
      return {
        ok: true,
        message: `[review required] ${id}\n${pending.previewSummary}`,
        pending,
      };
    }

    if (request.action === "read_shell" || request.action === "shell_status") {
      try {
        const output = await this.execute(request);
        return {
          ok: true,
          message: `[tool result] ${request.action} ${request.path}\n${output}`,
        };
      } catch (error) {
        return {
          ok: false,
          message: `[tool error] ${request.action} ${request.path}\n${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    if (request.action === "list_dir") {
      const cachedSnapshot = this.getRecentListDirSnapshot(request.path);
      if (cachedSnapshot) {
        return {
          ok: true,
          message: this.formatListDirToolResult(
            request.path,
            cachedSnapshot.output,
            true
          ),
        };
      }
    }

    try {
      const output = await this.execute(request);
      if (request.action === "list_dir") {
        this.storeRecentListDirSnapshot(request.path, output);
        return {
          ok: true,
          message: this.formatListDirToolResult(request.path, output),
        };
      }
      return {
        ok: true,
        message: `[tool result] ${request.action} ${request.path}\n${output}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `[tool error] ${request.action} ${request.path}\n${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  listPending(): PendingReviewItem[] {
    return [...this.pending.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
  }

  async undoLastMutation(): Promise<HandleResult> {
    const entry = this.undoHistory.pop();
    if (!entry) {
      return {
        ok: false,
        message: "Nothing to undo.",
      };
    }

    this.suppressUndoRecording = true;
    try {
      const summary = await this.applyUndoEntry(entry);
      this.noteFilesystemMutation();
      return {
        ok: true,
        message: `[undo] ${summary}`,
      };
    } catch (error) {
      this.undoHistory.push(entry);
      return {
        ok: false,
        message: `[undo failed] ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      this.suppressUndoRecording = false;
    }
  }

  async approve(id: string): Promise<HandleResult> {
    const pending = this.pending.get(id);
    if (!pending) {
      return {
        ok: false,
        message: `Pending operation not found: ${id}`,
      };
    }
    try {
      const output = await this.executePendingApproval(
        pending.request,
        this.pendingApprovalGuards.get(id)
      );
      this.pending.delete(id);
      this.pendingApprovalGuards.delete(id);
      return {
        ok: true,
        message: `[approved] ${id}\n${output}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `[approve failed] ${id}\n${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  reject(id: string): HandleResult {
    const pending = this.pending.get(id);
    if (!pending) {
      return {
        ok: false,
        message: `Pending operation not found: ${id}`,
      };
    }
    this.pending.delete(id);
    this.pendingApprovalGuards.delete(id);
    return {
      ok: true,
      message: `[rejected] ${id}`,
    };
  }
}
