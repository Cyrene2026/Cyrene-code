import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  FileAction,
  FileToolRequest,
  PendingReviewItem,
  RuleConfig,
} from "./types";

type HandleResult = {
  ok: boolean;
  message: string;
  pending?: PendingReviewItem;
};

const READ_ONLY_ACTIONS: FileAction[] = ["read_file", "list_dir"];

const formatPreview = (request: FileToolRequest) => {
  const chunks = [`action=${request.action}`, `path=${request.path}`];
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

const normalizeAction = (raw: unknown): FileAction | null => {
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

const normalizeToolInput = (
  toolName: string,
  input: unknown
): FileToolRequest | null => {
  const first = toRecord(input);
  if (!first) {
    return null;
  }

  const nestedRaw =
    first.arguments ??
    first.args ??
    first.parameters ??
    first.params ??
    first.input;
  const nested = toRecord(nestedRaw);
  const obj = nested ?? first;

  let action =
    normalizeAction(obj.action) ??
    normalizeAction(obj.operation) ??
    normalizeAction(obj.op) ??
    normalizeAction(obj.command) ??
    normalizeAction(toolName);
  const path = pickString(obj, [
    "path",
    "file",
    "file_path",
    "target",
    "dir",
    "directory",
  ]);

  const content = pickString(obj, ["content", "text", "data"]);
  const find = pickString(obj, ["find", "search", "from"]);
  const replace = pickString(obj, ["replace", "to"]);

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

const validateRequest = (request: FileToolRequest): string | null => {
  switch (request.action) {
    case "create_file":
    case "write_file":
      if (typeof request.content !== "string") {
        return `${request.action} requires \`content\`.`;
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

  constructor(private readonly rules: RuleConfig) {}

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
    request: FileToolRequest,
    mode: "summary" | "full"
  ): Promise<string> {
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

  private async execute(request: FileToolRequest): Promise<string> {
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
    if (!["file", "fs", "mcp.file"].includes(normalizedName)) {
      return {
        ok: false,
        message: `Unsupported tool: ${toolName}`,
      };
    }

    const request = normalizeToolInput(normalizedName, input);
    if (!request) {
      let preview = "";
      try {
        preview = JSON.stringify(input);
      } catch {
        preview = String(input);
      }
      const clipped =
        preview.length > 240 ? `${preview.slice(0, 240)}...` : preview;
      return {
        ok: false,
        message:
          `Invalid tool input. Expected { action, path, content?, find?, replace? }. Received: ${clipped}`,
      };
    }
    const validationError = validateRequest(request);
    if (validationError) {
      return {
        ok: false,
        message: `Invalid tool input for ${request.action}: ${validationError}`,
      };
    }

    if (!READ_ONLY_ACTIONS.includes(request.action) &&
        this.rules.requireReview.includes(request.action)) {
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
    this.pending.delete(id);
    try {
      const output = await this.execute(pending.request);
      return {
        ok: true,
        message: `[approved] ${id}\n${pending.previewSummary}\n${output}`,
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
      message: `[rejected] ${id}\n${pending.previewSummary}`,
    };
  }
}
