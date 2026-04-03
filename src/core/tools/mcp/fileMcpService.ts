import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  CommandToolRequest,
  FileAction,
  FindFilesToolRequest,
  PendingReviewItem,
  RuleConfig,
  SearchTextToolRequest,
  ShellToolRequest,
  ToolRequest,
} from "./types";

type HandleResult = {
  ok: boolean;
  message: string;
  pending?: PendingReviewItem;
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
};

type CommandExecutionResult = {
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  output?: string;
  truncated?: boolean;
};

type SearchableFile = {
  absolutePath: string;
  workspacePath: string;
  relativeToStart: string;
};

type PathConflict = {
  action: ToolRequest["action"];
  path: string;
};

type ShellFlavor = "pwsh" | "sh";

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
  "list_dir",
  "stat_path",
  "find_files",
  "search_text",
];
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
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_SNIPPET_CHARS = 160;
const RECENT_LIST_DIR_WINDOW_MS = 5_000;
const PENDING_CONFLICT_ACTIONS: FileAction[] = [
  "create_file",
  "write_file",
  "edit_file",
  "delete_file",
  "copy_path",
  "move_path",
];
const MAX_PREVIEW_SUMMARY_LINES = 24;
const lineNoWidth = 4;

const clip = (text: string, max = 320) =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

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
    case "delete":
    case "delete_file":
    case "remove":
    case "rm":
      return "delete_file";
    case "stat":
    case "stat_path":
    case "info":
      return "stat_path";
    case "find":
    case "find_files":
    case "glob":
      return "find_files";
    case "search":
    case "search_text":
    case "grep":
      return "search_text";
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
    case "run_shell":
    case "shell_command":
    case "terminal":
    case "shell":
      return "run_shell";
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

const normalizeSearchLimit = (value: number | undefined) => {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_SEARCH_RESULTS;
  }
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(value)));
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

const getShellFlavor = (): ShellFlavor =>
  process.platform === "win32" ? "pwsh" : "sh";

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

const looksLikeUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

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
  action: "find_files" | "search_text",
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
  rawArgs: string[] | undefined
): ToolRequest | null => {
  const destination = pickString(record, ["destination", "dest", "to", "target_path"]);
  const pattern =
    pickString(record, ["pattern", "glob"]) ?? pickFirstNonEmptyValue(rawArgs);
  const query = pickString(record, ["query", "needle"]) ?? pickFirstNonEmptyValue(rawArgs);
  const maxResults = normalizeSearchLimit(
    pickNumber(record, ["maxResults", "max_results", "limit"])
  );
  const caseSensitive = pickBoolean(record, ["caseSensitive", "case_sensitive"]);

  switch (action) {
    case "read_file":
    case "list_dir":
    case "create_dir":
    case "delete_file":
    case "stat_path":
      if (!path) {
        return null;
      }
      return { action, path };
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

  const content = pickString(record, ["content", "value", "data"]);
  const find = pickString(record, ["find", "from", "old", "before"]);
  const replace = pickString(record, ["replace", "new", "after"]);
  const cwd = pickString(record, ["cwd", "working_directory", "workdir"]);
  const rawArgs = pickStringArray(record, ["args", "argv", "arguments"]);
  const rawCommand = pickString(record, ["command", "cmd", "program", "executable"]);

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

  if (!action) {
    if (path && pickString(record, ["destination", "dest", "to", "target_path"])) {
      action = "move_path";
    } else if (path && pickString(record, ["pattern", "glob"])) {
      action = "find_files";
    } else if (path && pickString(record, ["query", "needle"])) {
      action = "search_text";
    } else if (path && find && typeof replace === "string") {
      action = "edit_file";
    } else if (path && typeof content === "string") {
      action = "write_file";
    } else if (path) {
      action = "read_file";
    }
  }

  if (!action) {
    return null;
  }

  return buildNormalizedFileRequest(
    action as FileAction,
    record,
    path,
    content,
    find,
    replace,
    rawArgs
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
        : 2 +
          (normalized.path ? 2 : 0) +
          ("content" in normalized ? 1 : 0) +
          ("find" in normalized ? 1 : 0) +
          ("replace" in normalized ? 1 : 0) +
          ("destination" in normalized ? 2 : 0) +
          ("pattern" in normalized ? 2 : 0) +
          ("query" in normalized ? 2 : 0);
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
    return null;
  }

  switch (request.action) {
    case "create_file":
    case "create_dir":
    case "read_file":
    case "list_dir":
    case "delete_file":
    case "stat_path":
      return null;
    case "write_file":
      if (typeof request.content !== "string") {
        return "write_file requires `content`.";
      }
      return null;
    case "edit_file":
      if (!request.find) {
        return "edit_file requires `find`.";
      }
      if (typeof request.replace !== "string") {
        return "edit_file requires `replace`.";
      }
      return null;
    case "find_files":
      if (!request.pattern.trim()) {
        return "find_files requires `pattern`.";
      }
      return null;
    case "search_text":
      if (!request.query.trim()) {
        return "search_text requires `query`.";
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

export class FileMcpService {
  private pending = new Map<string, PendingReviewItem>();
  private recentListDir = new Map<
    string,
    { output: string; listedAt: number; mutationVersion: number }
  >();
  private filesystemMutationVersion = 0;

  constructor(
    private readonly rules: RuleConfig,
    private readonly options: FileMcpServiceOptions = {}
  ) {}

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

  private resolvePath(inputPath: string) {
    const normalized = this.toWorkspaceRelativePath(inputPath);
    const absolute = resolve(this.rules.workspaceRoot, normalized);
    const root = resolve(this.rules.workspaceRoot);
    if (!isPathInsideWorkspaceRoot(absolute, root)) {
      throw new Error(
        `Path escapes workspace root: ${inputPath}. Use workspace-relative paths such as "test_files/...".`
      );
    }
    return absolute;
  }

  private normalizeWorkspacePath(inputPath: string) {
    const absolute = this.resolvePath(inputPath);
    const normalized = relative(resolve(this.rules.workspaceRoot), absolute)
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    return normalized || ".";
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
      request.action === "create_dir" ||
      READ_ONLY_ACTIONS.includes(request.action)
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
      request.action === "create_dir"
    ) {
      return null;
    }

    if (READ_ONLY_ACTIONS.includes(request.action)) {
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
      case "edit_file": {
        if (!(await this.pathExists(request.path))) {
          return `edit_file target does not exist: ${normalizedPath}`;
        }
        const before = await readFile(this.resolvePath(request.path), "utf8");
        if (!request.find || !before.includes(request.find)) {
          return `edit_file find text not found: ${normalizedPath}`;
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
    }

    return null;
  }

  private auditShellRequest(request: ShellToolRequest): ShellAuditResult {
    const shell = getShellFlavor();
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
      : resolve(this.rules.workspaceRoot);
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
      SHELL_MUTATING_COMMANDS.has(commandName) &&
      targetTokens.some(token => {
        if (!looksLikePathToken(token)) {
          return false;
        }
        const resolvedTarget = resolve(cwd, token);
        return !isPathInsideWorkspaceRoot(resolvedTarget, this.rules.workspaceRoot);
      })
    ) {
      return {
        ok: false,
        shell,
        tokens,
        risk: "high",
        reason: "run_shell blocked a write or delete target outside the workspace root.",
        notes: ["Shell mutations must stay inside the workspace root."],
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

  private noteFilesystemMutation() {
    this.filesystemMutationVersion += 1;
    this.recentListDir.clear();
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
      request.action !== "edit_file"
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
          "[old - to be overwritten]",
          formatDiffLines("-", mode === "summary" ? clip(before, 6000) : before, 1, maxLines),
          "[new + to be written]",
          formatDiffLines("+", nextContent, 1, maxLines),
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
    try {
      const before = await readFile(abs, "utf8");
      const hit = before.indexOf(find);
      const startLine = hit >= 0 ? lineNumberAtIndex(before, hit) : 1;
      return [
        "[edit preview]",
        "[old - to be removed]",
        formatDiffLines(
          "-",
          mode === "summary" ? clip(find, 3000) : find,
          startLine,
          maxLines
        ),
        "[new + to be written]",
        formatDiffLines(
          "+",
          mode === "summary" ? clip(replace, 3000) : replace,
          startLine,
          maxLines
        ),
      ].join("\n");
    } catch {
      return [
        "[edit preview]",
        "[old - to be removed]",
        formatDiffLines(
          "-",
          mode === "summary" ? clip(find, 3000) : find,
          1,
          maxLines
        ),
        "[new + to be written]",
        formatDiffLines(
          "+",
          mode === "summary" ? clip(replace, 3000) : replace,
          1,
          maxLines
        ),
      ].join("\n");
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
    if ("query" in request) {
      chunks.push(`query=${clip(request.query, 80)}`);
      chunks.push(`maxResults=${request.maxResults ?? DEFAULT_SEARCH_RESULTS}`);
      if (typeof request.caseSensitive === "boolean") {
        chunks.push(`caseSensitive=${request.caseSensitive}`);
      }
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
            stderr: `Command timed out after ${COMMAND_TIMEOUT_MS}ms.`,
            stdout,
            truncated: outputTruncated,
          })
        );
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

    const program = audit.shell === "pwsh" ? "pwsh" : "/bin/sh";
    const args =
      audit.shell === "pwsh"
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command]
        : ["-lc", request.command];

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
            stderr: `Command timed out after ${COMMAND_TIMEOUT_MS}ms.`,
            stdout,
            truncated: outputTruncated,
          }, audit.shell)
        );
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

  private async walkFiles(startPath: string): Promise<SearchableFile[]> {
    const startAbsolute = this.resolvePath(startPath);
    const startWorkspace = this.normalizeWorkspacePath(startPath);
    const info = await stat(startAbsolute);

    if (!info.isDirectory()) {
      return [{
        absolutePath: startAbsolute,
        workspacePath: startWorkspace,
        relativeToStart: basename(startAbsolute).replace(/\\/g, "/"),
      }];
    }

    const files: SearchableFile[] = [];
    const queue: Array<{ absolutePath: string }> = [{ absolutePath: startAbsolute }];

    while (queue.length > 0) {
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
          queue.push({ absolutePath });
          continue;
        }
        files.push({
          absolutePath,
          workspacePath,
          relativeToStart:
            relative(startAbsolute, absolutePath).replace(/\\/g, "/") || entry.name,
        });
      }
    }

    return files;
  }

  private async executeFindFiles(request: FindFilesToolRequest): Promise<string> {
    const files = await this.walkFiles(request.path);
    const matcher = globToRegExp(request.pattern, request.caseSensitive ?? false);
    const matches = files
      .filter(file => matcher.test(file.relativeToStart) || matcher.test(file.workspacePath))
      .slice(0, request.maxResults ?? DEFAULT_SEARCH_RESULTS)
      .map(file => file.workspacePath);

    if (matches.length === 0) {
      return `(no matches for pattern: ${request.pattern})`;
    }

    return [`Found ${matches.length} file(s):`, ...matches].join("\n");
  }

  private async executeSearchText(request: SearchTextToolRequest): Promise<string> {
    const files = await this.walkFiles(request.path);
    const limit = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    const caseSensitive = request.caseSensitive ?? false;
    const query = caseSensitive ? request.query : request.query.toLowerCase();
    const matches: string[] = [];

    for (const file of files) {
      const info = await stat(file.absolutePath);
      if (info.size > this.rules.maxReadBytes) {
        continue;
      }
      const content = await readFile(file.absolutePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
        matches.push(`${file.workspacePath}:${index + 1} | ${clipSnippet(line)}`);
        if (matches.length >= limit) {
          return [`Found ${matches.length} match(es):`, ...matches].join("\n");
        }
      }
    }

    if (matches.length === 0) {
      return `(no text matches for query: ${request.query})`;
    }

    return [`Found ${matches.length} match(es):`, ...matches].join("\n");
  }

  private async executeMovePath(request: Extract<ToolRequest, { action: "move_path" }>) {
    const source = this.resolvePath(request.path);
    const destination = this.resolvePath(request.destination);
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
    this.noteFilesystemMutation();
    return `Copied path: ${request.path} -> ${request.destination}`;
  }

  private async execute(request: ToolRequest): Promise<string> {
    if (request.action === "run_command") {
      return this.executeCommand(request);
    }
    if (request.action === "run_shell") {
      return this.executeShell(request);
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
      case "find_files":
        return this.executeFindFiles(request);
      case "search_text":
        return this.executeSearchText(request);
      case "create_file": {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, request.content ?? "", { flag: "wx" });
        this.noteFilesystemMutation();
        return `Created file: ${request.path}`;
      }
      case "create_dir": {
        await mkdir(abs, { recursive: true });
        this.noteFilesystemMutation();
        return `Created directory: ${request.path}`;
      }
      case "write_file": {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, request.content ?? "", "utf8");
        this.noteFilesystemMutation();
        return `Wrote file: ${request.path}`;
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
        this.noteFilesystemMutation();
        return `Edited file: ${request.path}`;
      }
      case "delete_file": {
        await rm(abs, { force: false, recursive: false });
        this.noteFilesystemMutation();
        return `Deleted file: ${request.path}`;
      }
      case "copy_path":
        return this.executeCopyPath(request);
      case "move_path":
        return this.executeMovePath(request);
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
          `Invalid tool input. Expected { action, path, content?, find?, replace?, pattern?, query?, maxResults?, caseSensitive?, destination?, command?, args?, cwd? }. Received: ${summarizeInput(input)}.`,
      };
    }
    const validationError = validateRequest(request);
    if (validationError) {
      return {
        ok: false,
        message: `Invalid tool input for ${request.action}: ${validationError}`,
      };
    }

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

    if (request.action !== "run_command" && request.action !== "run_shell") {
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
      (request.action !== "create_dir" &&
        !READ_ONLY_ACTIONS.includes(request.action) &&
        this.rules.requireReview.includes(request.action))
    ) {
      const id = crypto.randomUUID().slice(0, 8);
      const detailsSummary = await this.buildReviewDetails(request, "summary");
      const detailsFull = await this.buildReviewDetails(request, "full");
      const previewSummary = [this.formatPreview(request), detailsSummary]
        .filter(Boolean)
        .join("\n");
      const previewFull = [this.formatPreview(request), detailsFull]
        .filter(Boolean)
        .join("\n");
      const pending: PendingReviewItem = {
        id,
        request,
        preview: previewSummary,
        previewSummary,
        previewFull,
        createdAt: new Date().toISOString(),
      };
      this.pending.set(id, pending);
      return {
        ok: true,
        message: `[review required] ${id}\n${pending.previewSummary}`,
        pending,
      };
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

  async approve(id: string): Promise<HandleResult> {
    const pending = this.pending.get(id);
    if (!pending) {
      return {
        ok: false,
        message: `Pending operation not found: ${id}`,
      };
    }
    try {
      const output = await this.execute(pending.request);
      this.pending.delete(id);
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
    return {
      ok: true,
      message: `[rejected] ${id}`,
    };
  }
}

