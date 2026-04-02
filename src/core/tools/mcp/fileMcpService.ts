import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import type {
  FileAction,
  ToolRequest,
  PendingReviewItem,
  RuleConfig,
  CommandToolRequest,
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
  ) => Promise<string>;
};

const READ_ONLY_ACTIONS: FileAction[] = ["read_file", "list_dir"];
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_OUTPUT_CHARS = 24_000;

const formatPreview = (request: ToolRequest) => {
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
  if (request.find) chunks.push(`find=${request.find}`);
  if (request.replace) chunks.push(`replace=${request.replace}`);
  if (typeof request.content === "string") {
    chunks.push(`content_bytes=${Buffer.byteLength(request.content, "utf8")}`);
  }
  return chunks.join(" | ");
};

const clip = (text: string, max = 320) =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

const writeLike = (action: FileAction) =>
  action === "create_file" || action === "write_file" || action === "edit_file";

const MAX_PREVIEW_SUMMARY_LINES = 24;
const lineNoWidth = 4;

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
    case "run":
    case "run_command":
    case "command":
    case "exec":
    case "terminal":
    case "shell":
      return "run_command";
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

const normalizeFromRecord = (
  record: Record<string, unknown>,
  toolName: string
): ToolRequest | null => {
  let action =
    normalizeAction(record.action) ??
    normalizeAction(record.operation) ??
    normalizeAction(record.op) ??
    normalizeAction(record.command) ??
    normalizeAction(record.method) ??
    normalizeAction(record.name) ??
    normalizeAction(toolName);
  const path = pickString(record, [
    "path",
    "file",
    "file_path",
    "filepath",
    "target",
    "dir",
    "directory",
  ]);

  const content = pickString(record, ["content", "text", "data", "value"]);
  const find = pickString(record, ["find", "search", "from", "old", "before"]);
  const replace = pickString(record, ["replace", "to", "new", "after"]);
  const cwd = pickString(record, ["cwd", "working_directory", "workdir", "directory"]);
  const rawArgs = pickStringArray(record, ["args", "argv", "arguments"]);
  const rawCommand = pickString(record, ["command", "cmd", "program", "executable"]);

  if (action === "run_command" || ["shell", "terminal", "command", "mcp.shell"].includes(toolName)) {
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
      path: display || command,
    };
  }

  // Heuristic fallback for providers that omit explicit action.
  if (!action) {
    if (path && find && typeof replace === "string") {
      action = "edit_file";
    } else if (path && typeof content === "string") {
      action = "write_file";
    } else if (path) {
      action = "read_file";
    }
  }

  if (!action || !path) {
    return null;
  }

  return {
    action,
    path,
    content,
    find,
    replace,
  };
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
    const commandScore =
      normalized.action === "run_command"
        ? 2 +
          (normalized.command ? 2 : 0) +
          normalized.args.length
        : 0;
    const score =
      normalized.action === "run_command"
        ? commandScore
        : (normalized.action ? 2 : 0) +
          (normalized.path ? 2 : 0) +
          (typeof normalized.content === "string" ? 1 : 0) +
          (typeof normalized.find === "string" ? 1 : 0) +
          (typeof normalized.replace === "string" ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = normalized;
    }
  }

  return best;
};

const validateRequest = (request: ToolRequest): string | null => {
  if (request.action === "run_command") {
    if (!request.command.trim()) {
      return "run_command requires `command`.";
    }
    return null;
  }

  switch (request.action) {
    case "create_file":
    case "create_dir":
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
    case "read_file":
    case "list_dir":
    case "delete_file":
      return null;
  }
};

export class FileMcpService {
  private pending = new Map<string, PendingReviewItem>();

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
    const rootWithSep = root.endsWith("\\") || root.endsWith("/")
      ? root
      : `${root}\\`;
    if (absolute !== root && !absolute.startsWith(rootWithSep)) {
      throw new Error(
        `Path escapes workspace root: ${inputPath}. Use workspace-relative paths such as "test_files/...".`
      );
    }
    return absolute;
  }

  private async buildReviewDetails(
    request: ToolRequest,
    mode: "summary" | "full"
  ): Promise<string> {
    if (request.action === "run_command") {
      return [
        "[command preview]",
        `command: ${request.command}`,
        request.args.length > 0 ? `args: ${request.args.join(" ")}` : "",
        `cwd: ${request.cwd ?? "."}`,
        `mode: ${mode}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    const abs = this.resolvePath(request.path);
    const maxLines =
      mode === "summary" ? MAX_PREVIEW_SUMMARY_LINES : undefined;
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

    if (!writeLike(request.action)) {
      return "";
    }

    if (request.action === "create_file" || request.action === "write_file") {
      return [
        "[write preview]",
        formatDiffLines(
          "+",
          mode === "summary" ? clip(request.content ?? "", 6000) : request.content ?? "",
          1,
          maxLines
        ),
      ].join("\n");
    }

    if (request.action === "edit_file") {
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

    return "";
  }

  private async executeCommand(request: CommandToolRequest): Promise<string> {
    const cwd = request.cwd
      ? this.resolvePath(request.cwd)
      : resolve(this.rules.workspaceRoot);

    if (this.options.commandRunner) {
      return this.options.commandRunner(request, cwd);
    }

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(request.command, request.args, {
        cwd,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        rejectPromise(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
      }, COMMAND_TIMEOUT_MS);

      const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "stdout") {
          stdout = `${stdout}${text}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
        } else {
          stderr = `${stderr}${text}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
        }
      };

      child.stdout.on("data", chunk => appendChunk("stdout", chunk));
      child.stderr.on("data", chunk => appendChunk("stderr", chunk));
      child.on("error", error => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on("close", code => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        if (code === 0) {
          resolvePromise(output || "(command completed with no output)");
          return;
        }
        rejectPromise(
          new Error(output || `Command exited with code ${code ?? "unknown"}.`)
        );
      });
    });
  }

  private async execute(request: ToolRequest): Promise<string> {
    if (request.action === "run_command") {
      return this.executeCommand(request);
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
        return content;
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
      case "create_file": {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, request.content ?? "", { flag: "wx" });
        return `Created file: ${request.path}`;
      }
      case "create_dir": {
        await mkdir(abs, { recursive: true });
        return `Created directory: ${request.path}`;
      }
      case "write_file": {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, request.content ?? "", "utf8");
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
        return `Edited file: ${request.path}`;
      }
      case "delete_file": {
        await rm(abs, { force: false, recursive: false });
        return `Deleted file: ${request.path}`;
      }
    }
  }

  async handleToolCall(toolName: string, input: unknown): Promise<HandleResult> {
    const normalizedName = toolName.trim().toLowerCase();
    if (
      ![
        "file",
        "fs",
        "mcp.file",
        "shell",
        "terminal",
        "command",
        "mcp.shell",
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
          `Invalid tool input. Expected { action, path, content?, find?, replace? }. Received: ${summarizeInput(input)}.`,
      };
    }
    const validationError = validateRequest(request);
    if (validationError) {
      return {
        ok: false,
        message: `Invalid tool input for ${request.action}: ${validationError}`,
      };
    }

    if (
      request.action === "run_command" ||
      (request.action !== "create_dir" &&
        !READ_ONLY_ACTIONS.includes(request.action as FileAction) &&
        this.rules.requireReview.includes(request.action))
    ) {
      const id = crypto.randomUUID().slice(0, 8);
      const detailsSummary = await this.buildReviewDetails(request, "summary");
      const detailsFull = await this.buildReviewDetails(request, "full");
      const previewSummary = [formatPreview(request), detailsSummary]
        .filter(Boolean)
        .join("\n");
      const previewFull = [formatPreview(request), detailsFull]
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
