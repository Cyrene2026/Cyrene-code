import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, extname, resolve } from "node:path";

const require = createRequire(import.meta.url);

type TsServerResponseMessage = {
  type?: string;
  request_seq?: number;
  success?: boolean;
  command?: string;
  message?: string;
  body?: unknown;
};

export type TsServerLocation = {
  line: number;
  offset: number;
};

export type TsServerTextSpan = {
  start: TsServerLocation;
  end: TsServerLocation;
};

export type TsServerFileSpan = TsServerTextSpan & {
  file: string;
  contextStart?: TsServerLocation;
  contextEnd?: TsServerLocation;
  unverified?: boolean;
};

export type TsServerTag = {
  name: string;
  text?: string;
};

export type TsServerQuickInfo = {
  kind: string;
  kindModifiers: string;
  start: TsServerLocation;
  end: TsServerLocation;
  displayString: string;
  documentation: string;
  tags: TsServerTag[];
  canIncreaseVerbosityLevel?: boolean;
};

export type TsServerDefinitionResult = {
  definitions: TsServerFileSpan[];
  textSpan?: TsServerTextSpan;
};

export type TsServerReferenceEntry = TsServerFileSpan & {
  lineText?: string;
  isWriteAccess: boolean;
  isDefinition?: boolean;
};

export type TsServerReferencesResult = {
  refs: TsServerReferenceEntry[];
  symbolName: string;
  symbolDisplayString: string;
  symbolStartOffset?: number;
};

export type TsServerDiagnostic = {
  file: string;
  start?: TsServerLocation;
  end?: TsServerLocation;
  code: number;
  category: string;
  text: string;
  source?: string;
};

export type TsServerDiagnosticsResult = {
  syntactic: TsServerDiagnostic[];
  semantic: TsServerDiagnostic[];
  suggestion: TsServerDiagnostic[];
};

export type TsServerRenameInfo =
  | {
      canRename: true;
      displayName: string;
      fullDisplayName: string;
      kind: string;
      kindModifiers: string;
      triggerSpan: TsServerTextSpan;
      fileToRename?: string;
    }
  | {
      canRename: false;
      localizedErrorMessage: string;
    };

export type TsServerRenameLocation = TsServerTextSpan & {
  contextStart?: TsServerLocation;
  contextEnd?: TsServerLocation;
  prefixText?: string;
  suffixText?: string;
};

export type TsServerRenameSpanGroup = {
  file: string;
  locs: TsServerRenameLocation[];
};

export type TsServerRenameResult = {
  info: TsServerRenameInfo;
  locs: TsServerRenameSpanGroup[];
};

export interface TsServerClientLike {
  open(filePath: string): Promise<void>;
  reload(filePath: string): Promise<void>;
  hover(
    filePath: string,
    line: number,
    column: number
  ): Promise<TsServerQuickInfo | null>;
  definition(
    filePath: string,
    line: number,
    column: number
  ): Promise<TsServerDefinitionResult | null>;
  references(
    filePath: string,
    line: number,
    column: number
  ): Promise<TsServerReferencesResult | null>;
  rename(
    filePath: string,
    line: number,
    column: number,
    options?: {
      findInComments?: boolean;
      findInStrings?: boolean;
    }
  ): Promise<TsServerRenameResult | null>;
  diagnostics(filePath: string): Promise<TsServerDiagnosticsResult>;
  invalidate(filePath?: string): void;
  dispose(): void;
}

export type TsServerClientOptions = {
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  tsserverPath?: string;
  args?: string[];
  spawnProcess?: typeof spawn;
};

const detectScriptKindName = (filePath: string) => {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx":
      return "TSX";
    case ".jsx":
      return "JSX";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "JS";
    case ".ts":
    case ".mts":
    case ".cts":
      return "TS";
    default:
      return undefined;
  }
};

const stringifyDisplayText = (value: unknown): string => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map(item =>
      item && typeof item === "object" && "text" in item && typeof item.text === "string"
        ? item.text
        : ""
    )
    .join("")
    .trim();
};

const normalizeLocation = (value: unknown): TsServerLocation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const line = "line" in value && typeof value.line === "number" ? value.line : undefined;
  const offset =
    "offset" in value && typeof value.offset === "number" ? value.offset : undefined;
  if (!line || !offset) {
    return null;
  }
  return { line, offset };
};

const normalizeTextSpan = (value: unknown): TsServerTextSpan | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const start = normalizeLocation("start" in value ? value.start : undefined);
  const end = normalizeLocation("end" in value ? value.end : undefined);
  if (!start || !end) {
    return null;
  }
  return { start, end };
};

const normalizeFileSpan = (value: unknown): TsServerFileSpan | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const file = "file" in value && typeof value.file === "string" ? value.file : undefined;
  const span = normalizeTextSpan(value);
  if (!file || !span) {
    return null;
  }
  const contextStart = normalizeLocation(
    "contextStart" in value ? value.contextStart : undefined
  );
  const contextEnd = normalizeLocation("contextEnd" in value ? value.contextEnd : undefined);
  return {
    file,
    start: span.start,
    end: span.end,
    ...(contextStart ? { contextStart } : {}),
    ...(contextEnd ? { contextEnd } : {}),
    ...(typeof (value as { unverified?: unknown }).unverified === "boolean"
      ? { unverified: Boolean((value as { unverified?: unknown }).unverified) }
      : {}),
  };
};

const normalizeTagArray = (value: unknown): TsServerTag[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const name = "name" in item && typeof item.name === "string" ? item.name.trim() : "";
      if (!name) {
        return null;
      }
      const text =
        "text" in item
          ? stringifyDisplayText(item.text)
          : "";
      return {
        name,
        ...(text ? { text } : {}),
      } satisfies TsServerTag;
    })
    .filter((item): item is TsServerTag => item !== null);
};

const normalizeQuickInfo = (value: unknown): TsServerQuickInfo | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const start = normalizeLocation("start" in value ? value.start : undefined);
  const end = normalizeLocation("end" in value ? value.end : undefined);
  if (!start || !end) {
    return null;
  }
  return {
    kind: "kind" in value && typeof value.kind === "string" ? value.kind : "unknown",
    kindModifiers:
      "kindModifiers" in value && typeof value.kindModifiers === "string"
        ? value.kindModifiers
        : "",
    start,
    end,
    displayString: stringifyDisplayText(
      "displayString" in value ? value.displayString : undefined
    ),
    documentation: stringifyDisplayText(
      "documentation" in value ? value.documentation : undefined
    ),
    tags: normalizeTagArray("tags" in value ? value.tags : undefined),
    ...(typeof (value as { canIncreaseVerbosityLevel?: unknown }).canIncreaseVerbosityLevel ===
    "boolean"
      ? {
          canIncreaseVerbosityLevel: Boolean(
            (value as { canIncreaseVerbosityLevel?: unknown }).canIncreaseVerbosityLevel
          ),
        }
      : {}),
  };
};

const normalizeDefinitionResult = (value: unknown): TsServerDefinitionResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rawDefinitions = (value as { definitions?: unknown }).definitions;
  const definitions = Array.isArray(rawDefinitions)
    ? rawDefinitions
        .map((entry: unknown) => normalizeFileSpan(entry))
        .filter((entry): entry is TsServerFileSpan => entry !== null)
    : [];
  const textSpan = normalizeTextSpan((value as { textSpan?: unknown }).textSpan);
  if (definitions.length === 0 && !textSpan) {
    return null;
  }
  return {
    definitions,
    ...(textSpan ? { textSpan } : {}),
  };
};

const normalizeReferenceEntry = (value: unknown): TsServerReferenceEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const span = normalizeFileSpan(value);
  if (!span) {
    return null;
  }
  return {
    ...span,
    ...(typeof (value as { lineText?: unknown }).lineText === "string"
      ? { lineText: (value as { lineText?: string }).lineText?.trim() }
      : {}),
    isWriteAccess: Boolean((value as { isWriteAccess?: unknown }).isWriteAccess),
    ...(typeof (value as { isDefinition?: unknown }).isDefinition === "boolean"
      ? { isDefinition: Boolean((value as { isDefinition?: unknown }).isDefinition) }
      : {}),
  };
};

const normalizeReferencesResult = (value: unknown): TsServerReferencesResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rawRefs = (value as { refs?: unknown }).refs;
  const refs = Array.isArray(rawRefs)
    ? rawRefs
        .map((entry: unknown) => normalizeReferenceEntry(entry))
        .filter((entry): entry is TsServerReferenceEntry => entry !== null)
    : [];
  return {
    refs,
    symbolName:
      "symbolName" in value && typeof value.symbolName === "string"
        ? value.symbolName
        : "",
    symbolDisplayString:
      "symbolDisplayString" in value && typeof value.symbolDisplayString === "string"
        ? value.symbolDisplayString
        : "",
    ...(
      typeof (value as { symbolStartOffset?: unknown }).symbolStartOffset === "number"
        ? { symbolStartOffset: (value as { symbolStartOffset: number }).symbolStartOffset }
        : {}
    ),
  };
};

const normalizeRenameInfo = (value: unknown): TsServerRenameInfo | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const canRename = Boolean((value as { canRename?: unknown }).canRename);
  if (!canRename) {
    const localizedErrorMessage =
      "localizedErrorMessage" in value &&
      typeof value.localizedErrorMessage === "string"
        ? value.localizedErrorMessage
        : "Rename is unavailable at the requested position.";
    return {
      canRename: false,
      localizedErrorMessage,
    };
  }

  const triggerSpan = normalizeTextSpan((value as { triggerSpan?: unknown }).triggerSpan);
  if (!triggerSpan) {
    return null;
  }
  return {
    canRename: true,
    displayName:
      "displayName" in value && typeof value.displayName === "string"
        ? value.displayName
        : "",
    fullDisplayName:
      "fullDisplayName" in value && typeof value.fullDisplayName === "string"
        ? value.fullDisplayName
        : "",
    kind: "kind" in value && typeof value.kind === "string" ? value.kind : "unknown",
    kindModifiers:
      "kindModifiers" in value && typeof value.kindModifiers === "string"
        ? value.kindModifiers
        : "",
    triggerSpan,
    ...(typeof (value as { fileToRename?: unknown }).fileToRename === "string"
      ? { fileToRename: (value as { fileToRename: string }).fileToRename }
      : {}),
  };
};

const normalizeRenameLocation = (value: unknown): TsServerRenameLocation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const span = normalizeTextSpan(value);
  if (!span) {
    return null;
  }
  return {
    ...span,
    ...(normalizeLocation((value as { contextStart?: unknown }).contextStart)
      ? {
          contextStart: normalizeLocation(
            (value as { contextStart?: unknown }).contextStart
          ) as TsServerLocation,
        }
      : {}),
    ...(normalizeLocation((value as { contextEnd?: unknown }).contextEnd)
      ? {
          contextEnd: normalizeLocation(
            (value as { contextEnd?: unknown }).contextEnd
          ) as TsServerLocation,
        }
      : {}),
    ...(typeof (value as { prefixText?: unknown }).prefixText === "string"
      ? { prefixText: (value as { prefixText: string }).prefixText }
      : {}),
    ...(typeof (value as { suffixText?: unknown }).suffixText === "string"
      ? { suffixText: (value as { suffixText: string }).suffixText }
      : {}),
  };
};

const normalizeRenameResult = (value: unknown): TsServerRenameResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const info = normalizeRenameInfo((value as { info?: unknown }).info);
  if (!info) {
    return null;
  }
  const rawLocs = (value as { locs?: unknown }).locs;
  const locs = Array.isArray(rawLocs)
    ? rawLocs
        .map((group: unknown) => {
          if (!group || typeof group !== "object" || Array.isArray(group)) {
            return null;
          }
          const file =
            "file" in group && typeof group.file === "string" ? group.file : undefined;
          const rawGroupLocs = (group as { locs?: unknown }).locs;
          const groupLocs = Array.isArray(rawGroupLocs)
            ? rawGroupLocs
                .map((location: unknown) => normalizeRenameLocation(location))
                .filter(
                  (location): location is TsServerRenameLocation => location !== null
                )
            : [];
          if (!file) {
            return null;
          }
          return {
            file,
            locs: groupLocs,
          } satisfies TsServerRenameSpanGroup;
        })
        .filter((group): group is TsServerRenameSpanGroup => group !== null)
    : [];
  return {
    info,
    locs,
  };
};

const normalizeDiagnostic = (
  value: unknown,
  filePath: string
): TsServerDiagnostic | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const start = normalizeLocation(
    "startLocation" in value ? value.startLocation : "start" in value ? value.start : undefined
  );
  const end = normalizeLocation(
    "endLocation" in value ? value.endLocation : "end" in value ? value.end : undefined
  );
  const code = "code" in value && typeof value.code === "number" ? value.code : undefined;
  if (typeof code !== "number") {
    return null;
  }
  const text =
    ("text" in value && typeof value.text === "string" ? value.text : undefined) ??
    ("message" in value && typeof value.message === "string" ? value.message : undefined) ??
    stringifyDisplayText("messageText" in value ? value.messageText : undefined);
  return {
    file: filePath,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    code,
    category:
      "category" in value && typeof value.category === "string"
        ? value.category
        : "unknown",
    text: text.trim(),
    ...(typeof (value as { source?: unknown }).source === "string"
      ? { source: (value as { source: string }).source }
      : {}),
  };
};

const normalizeDiagnostics = (
  value: unknown,
  filePath: string
): TsServerDiagnostic[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(entry => normalizeDiagnostic(entry, filePath))
    .filter((entry): entry is TsServerDiagnostic => entry !== null);
};

const getDefaultNodeExecutable = () => {
  const executable = basename(process.execPath).toLowerCase();
  return executable.startsWith("node") ? process.execPath : "node";
};

export class TsServerClient implements TsServerClientLike {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextSeq = 1;
  private readonly openedFiles = new Map<string, string>();

  constructor(private readonly options: TsServerClientOptions) {}

  private resolveTsServerPath() {
    if (this.options.tsserverPath) {
      return resolve(this.options.workspaceRoot, this.options.tsserverPath);
    }
    try {
      return require.resolve("typescript/lib/tsserver.js", {
        paths: [this.options.workspaceRoot],
      });
    } catch {
      try {
        return require.resolve("typescript/lib/tsserver.js");
      } catch {
        throw new Error(
          "TypeScript server runtime not found. Install `typescript` in the workspace or configure a tsserver path explicitly."
        );
      }
    }
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleResponseMessage(message: TsServerResponseMessage) {
    if (message.type !== "response" || typeof message.request_seq !== "number") {
      return;
    }
    const pending = this.pendingRequests.get(message.request_seq);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.request_seq);
    if (!message.success) {
      pending.reject(new Error(message.message ?? `tsserver ${message.command ?? "request"} failed`));
      return;
    }
    pending.resolve(message.body);
  }

  private consumeStdout(data: Buffer) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, data]);

    while (this.stdoutBuffer.length > 0) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const headerText = this.stdoutBuffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = /^content-length:\s*(\d+)$/im.exec(headerText);
      if (!lengthMatch) {
        this.stdoutBuffer = Buffer.alloc(0);
        this.rejectAllPending(new Error("Invalid tsserver frame received."));
        return;
      }

      const contentLength = Number(lengthMatch[1] ?? "0");
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.stdoutBuffer.length < messageEnd) {
        return;
      }

      const payload = this.stdoutBuffer.slice(messageStart, messageEnd).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.slice(messageEnd);

      try {
        this.handleResponseMessage(JSON.parse(payload) as TsServerResponseMessage);
      } catch (error) {
        this.rejectAllPending(
          new Error(
            `Invalid tsserver JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return;
      }
    }
  }

  private async ensureProcess() {
    if (this.process) {
      return this.process;
    }

    const child = (this.options.spawnProcess ?? spawn)(
      this.options.nodeExecutable ?? getDefaultNodeExecutable(),
      [this.resolveTsServerPath(), ...(this.options.args ?? [])],
      {
        cwd: this.options.workspaceRoot,
        env: {
          ...process.env,
          ...this.options.env,
        },
        stdio: "pipe",
      }
    );

    child.stdout.on("data", chunk => {
      this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", () => {
      // tsserver can log on stderr; ignore for now and surface request failures instead.
    });
    child.on("error", error => {
      this.process = null;
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      this.process = null;
      this.openedFiles.clear();
      this.rejectAllPending(
        new Error(
          `tsserver exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`
        )
      );
    });

    this.process = child;
    return child;
  }

  private sendMessage(message: Record<string, unknown>) {
    if (!this.process) {
      throw new Error("tsserver is not running.");
    }

    const payload = JSON.stringify(message);
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    this.process.stdin.write(frame, "utf8");
  }

  private request(command: string, args?: Record<string, unknown>) {
    const seq = this.nextSeq++;

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pendingRequests.set(seq, {
        resolve: resolveRequest,
        reject: rejectRequest,
      });

      void this.ensureProcess()
        .then(() => {
          this.sendMessage({
            seq,
            type: "request",
            command,
            ...(args === undefined ? {} : { arguments: args }),
          });
        })
        .catch(error => {
          this.pendingRequests.delete(seq);
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private notify(command: string, args?: Record<string, unknown>) {
    const seq = this.nextSeq++;
    this.sendMessage({
      seq,
      type: "request",
      command,
      ...(args === undefined ? {} : { arguments: args }),
    });
  }

  private async syncFile(filePath: string, force: boolean) {
    const content = await readFile(filePath, "utf8");
    const current = this.openedFiles.get(filePath);
    if (!force && current === content) {
      return;
    }

    await this.ensureProcess();
    if (current !== undefined) {
      this.notify("close", { file: filePath });
    }
    this.notify("open", {
      file: filePath,
      fileContent: content,
      projectRootPath: this.options.workspaceRoot,
      ...(detectScriptKindName(filePath)
        ? { scriptKindName: detectScriptKindName(filePath) }
        : {}),
    });
    this.openedFiles.set(filePath, content);
  }

  async open(filePath: string) {
    await this.syncFile(filePath, false);
  }

  async reload(filePath: string) {
    await this.syncFile(filePath, true);
  }

  async hover(filePath: string, line: number, column: number) {
    await this.syncFile(filePath, false);
    return normalizeQuickInfo(
      await this.request("quickinfo", {
        file: filePath,
        line,
        offset: column,
      })
    );
  }

  async definition(filePath: string, line: number, column: number) {
    await this.syncFile(filePath, false);
    return normalizeDefinitionResult(
      await this.request("definitionAndBoundSpan", {
        file: filePath,
        line,
        offset: column,
      })
    );
  }

  async references(filePath: string, line: number, column: number) {
    await this.syncFile(filePath, false);
    return normalizeReferencesResult(
      await this.request("references", {
        file: filePath,
        line,
        offset: column,
      })
    );
  }

  async rename(
    filePath: string,
    line: number,
    column: number,
    options?: {
      findInComments?: boolean;
      findInStrings?: boolean;
    }
  ) {
    await this.syncFile(filePath, false);
    return normalizeRenameResult(
      await this.request("rename", {
        file: filePath,
        line,
        offset: column,
        ...(typeof options?.findInComments === "boolean"
          ? { findInComments: options.findInComments }
          : {}),
        ...(typeof options?.findInStrings === "boolean"
          ? { findInStrings: options.findInStrings }
          : {}),
      })
    );
  }

  async diagnostics(filePath: string) {
    await this.syncFile(filePath, false);
    const [syntactic, semantic, suggestion] = await Promise.all([
      this.request("syntacticDiagnosticsSync", {
        file: filePath,
        includeLinePosition: true,
      }),
      this.request("semanticDiagnosticsSync", {
        file: filePath,
        includeLinePosition: true,
      }),
      this.request("suggestionDiagnosticsSync", {
        file: filePath,
        includeLinePosition: true,
      }),
    ]);

    return {
      syntactic: normalizeDiagnostics(syntactic, filePath),
      semantic: normalizeDiagnostics(semantic, filePath),
      suggestion: normalizeDiagnostics(suggestion, filePath),
    } satisfies TsServerDiagnosticsResult;
  }

  invalidate(filePath?: string) {
    if (!filePath) {
      this.openedFiles.clear();
      return;
    }
    this.openedFiles.delete(filePath);
  }

  dispose() {
    this.openedFiles.clear();
    this.stdoutBuffer = Buffer.alloc(0);
    this.rejectAllPending(new Error("tsserver client disposed."));
    if (this.process) {
      try {
        this.notify("exit");
      } catch {
        // Best effort shutdown.
      }
      try {
        this.process.kill();
      } catch {
        // Best effort shutdown.
      }
      this.process = null;
    }
  }
}
