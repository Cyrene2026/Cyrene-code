import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspServerConfig } from "../../toolTypes";

type JsonRpcResponseMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type JsonRpcRequestMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
};

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type LspHoverResult = {
  contents: string;
  range?: LspRange;
};

export type LspDocumentSymbol = {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  containerName?: string;
  children: LspDocumentSymbol[];
};

export type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

export type LspTextEdit = {
  range: LspRange;
  newText: string;
};

export type LspWorkspaceEditDocumentChange =
  | {
      kind: "text";
      uri: string;
      edits: LspTextEdit[];
    }
  | {
      kind: "resource";
      operation: string;
    };

export type LspWorkspaceEdit = {
  changes: Record<string, LspTextEdit[]>;
  documentChanges: LspWorkspaceEditDocumentChange[];
};

export type LspPrepareRenameResult = {
  range: LspRange;
  placeholder: string;
};

type LspServerCapabilities = {
  hoverProvider?: unknown;
  definitionProvider?: unknown;
  referencesProvider?: unknown;
  documentSymbolProvider?: unknown;
  renameProvider?: unknown;
  diagnosticProvider?: unknown;
  textDocumentSync?: unknown;
};

export interface LspWorkspaceLike {
  getInfo(): { serverId: string; rootPath: string };
  probe(filePath: string): Promise<{ serverId: string; rootPath: string }>;
  hover(filePath: string, line: number, column: number): Promise<LspHoverResult | null>;
  definition(filePath: string, line: number, column: number): Promise<LspLocation[]>;
  references(filePath: string, line: number, column: number): Promise<LspLocation[]>;
  documentSymbols(filePath: string): Promise<LspDocumentSymbol[]>;
  diagnostics(filePath: string): Promise<LspDiagnostic[]>;
  prepareRename(
    filePath: string,
    line: number,
    column: number
  ): Promise<LspPrepareRenameResult | null>;
  rename(
    filePath: string,
    line: number,
    column: number,
    newName: string
  ): Promise<LspWorkspaceEdit | null>;
  invalidate(filePath?: string): void;
  dispose(): Promise<void> | void;
}

export type LspPathInspection = {
  workspaceRoot: string;
  relativePath: string;
  configuredServerIds: string[];
  matchedServerIds: string[];
  selectedServerId?: string;
  resolvedRoot?: string;
};

export interface LspManagerLike {
  getSession(
    filePath: string,
    options?: { serverId?: string }
  ): Promise<LspWorkspaceLike>;
  inspectPath(
    filePath: string,
    options?: { serverId?: string }
  ): Promise<LspPathInspection>;
  invalidate(filePath?: string): void;
  dispose(): Promise<void> | void;
}

type LspClientOptions = {
  rootPath: string;
  config: LspServerConfig;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
};

type LspManagerOptions = {
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  sessionFactory?: (input: {
    rootPath: string;
    config: LspServerConfig;
    env?: NodeJS.ProcessEnv;
    spawnProcess?: typeof spawn;
  }) => LspWorkspaceLike;
};

const CLIENT_INFO = {
  name: "cyrene-code",
  version: "0.1.61",
};

const LSP_DIAGNOSTIC_WAIT_MS = 250;

const normalizePathForGlob = (value: string) => value.replace(/\\/g, "/");

const isPathInsideRoot = (absolutePath: string, rootPath: string) => {
  const normalizedRoot = resolve(rootPath);
  const normalizedAbsolute = resolve(absolutePath);
  if (normalizedAbsolute === normalizedRoot) {
    return true;
  }

  const relativePath = relative(normalizedRoot, normalizedAbsolute);
  return !/^\.\.(?:[\\/]|$)/.test(relativePath) && !isAbsolute(relativePath);
};

const globToRegExp = (pattern: string) => {
  const normalized = normalizePathForGlob(pattern.trim());
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    const nextNext = normalized[index + 2] ?? "";

    if (char === "*" && next === "*" && nextNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
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
  return new RegExp(source, "i");
};

const resolveCommandPath = (rootPath: string, command: string) => {
  if (
    command.startsWith(".\\") ||
    command.startsWith("./") ||
    command.startsWith("..\\") ||
    command.startsWith("../") ||
    command.includes("\\") ||
    command.includes("/")
  ) {
    return resolve(rootPath, command);
  }
  return command;
};

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

const normalizeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizePosition = (value: unknown): LspPosition | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const line = normalizeNumber((value as { line?: unknown }).line);
  const character = normalizeNumber((value as { character?: unknown }).character);
  if (typeof line !== "number" || typeof character !== "number" || line < 0 || character < 0) {
    return null;
  }
  return { line, character };
};

const normalizeRange = (value: unknown): LspRange | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const start = normalizePosition((value as { start?: unknown }).start);
  const end = normalizePosition((value as { end?: unknown }).end);
  if (!start || !end) {
    return null;
  }
  return { start, end };
};

const stringifyMarkedString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const markupKind = normalizeString((value as { kind?: unknown }).kind);
  const markupValue = normalizeString((value as { value?: unknown }).value);
  if (markupKind && markupValue) {
    return markupValue;
  }
  return normalizeString((value as { value?: unknown }).value) ?? "";
};

const normalizeHover = (value: unknown): LspHoverResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rawContents = (value as { contents?: unknown }).contents;
  const contents = Array.isArray(rawContents)
    ? rawContents.map(item => stringifyMarkedString(item)).filter(Boolean).join("\n\n")
    : stringifyMarkedString(rawContents);
  if (!contents.trim()) {
    return null;
  }
  const range = normalizeRange((value as { range?: unknown }).range);
  return {
    contents,
    ...(range ? { range } : {}),
  };
};

const normalizeLocation = (value: unknown): LspLocation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const uri = normalizeString((value as { uri?: unknown }).uri);
  const range = normalizeRange((value as { range?: unknown }).range);
  if (!uri || !range) {
    return null;
  }
  return { uri, range };
};

const normalizeLocationLink = (value: unknown): LspLocation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const uri = normalizeString((value as { targetUri?: unknown }).targetUri);
  const range =
    normalizeRange((value as { targetSelectionRange?: unknown }).targetSelectionRange) ??
    normalizeRange((value as { targetRange?: unknown }).targetRange);
  if (!uri || !range) {
    return null;
  }
  return { uri, range };
};

const normalizeLocationArray = (value: unknown): LspLocation[] => {
  const rawArray = Array.isArray(value) ? value : value == null ? [] : [value];
  return rawArray
    .map(item => normalizeLocation(item) ?? normalizeLocationLink(item))
    .filter((item): item is LspLocation => item !== null);
};

const normalizeDocumentSymbol = (value: unknown): LspDocumentSymbol | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const name = normalizeString((value as { name?: unknown }).name);
  const kind = normalizeNumber((value as { kind?: unknown }).kind);
  if (!name || typeof kind !== "number") {
    return null;
  }

  if ("location" in value) {
    const location = normalizeLocation((value as { location?: unknown }).location);
    if (!location) {
      return null;
    }
    return {
      name,
      kind,
      range: location.range,
      selectionRange: location.range,
      containerName: normalizeString((value as { containerName?: unknown }).containerName),
      children: [],
    };
  }

  const range = normalizeRange((value as { range?: unknown }).range);
  const selectionRange = normalizeRange(
    (value as { selectionRange?: unknown }).selectionRange
  );
  if (!range) {
    return null;
  }
  const children = Array.isArray((value as { children?: unknown[] }).children)
    ? (value as { children: unknown[] }).children
        .map(item => normalizeDocumentSymbol(item))
        .filter((item): item is LspDocumentSymbol => item !== null)
    : [];
  return {
    name,
    detail: normalizeString((value as { detail?: unknown }).detail),
    kind,
    range,
    ...(selectionRange ? { selectionRange } : {}),
    children,
  };
};

const normalizeDiagnostic = (value: unknown): LspDiagnostic | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const range = normalizeRange((value as { range?: unknown }).range);
  const message = normalizeString((value as { message?: unknown }).message);
  if (!range || !message) {
    return null;
  }
  const severity = normalizeNumber((value as { severity?: unknown }).severity);
  const codeValue = (value as { code?: unknown }).code;
  return {
    range,
    ...(typeof severity === "number" ? { severity } : {}),
    ...(typeof codeValue === "string" || typeof codeValue === "number"
      ? { code: codeValue }
      : {}),
    ...(normalizeString((value as { source?: unknown }).source)
      ? { source: normalizeString((value as { source?: unknown }).source) }
      : {}),
    message,
  };
};

const normalizeTextEdit = (value: unknown): LspTextEdit | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const range = normalizeRange((value as { range?: unknown }).range);
  const newText = typeof (value as { newText?: unknown }).newText === "string"
    ? (value as { newText: string }).newText
    : undefined;
  if (!range || typeof newText !== "string") {
    return null;
  }
  return { range, newText };
};

const normalizeWorkspaceEdit = (value: unknown): LspWorkspaceEdit | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const changes: Record<string, LspTextEdit[]> = {};
  const rawChanges = (value as { changes?: unknown }).changes;
  if (rawChanges && typeof rawChanges === "object" && !Array.isArray(rawChanges)) {
    for (const [uri, edits] of Object.entries(rawChanges as Record<string, unknown>)) {
      if (!Array.isArray(edits)) {
        continue;
      }
      const normalizedEdits = edits
        .map(item => normalizeTextEdit(item))
        .filter((item): item is LspTextEdit => item !== null);
      if (normalizedEdits.length > 0) {
        changes[uri] = normalizedEdits;
      }
    }
  }

  const documentChanges: LspWorkspaceEditDocumentChange[] = [];
  const rawDocumentChanges = (value as { documentChanges?: unknown }).documentChanges;
  if (Array.isArray(rawDocumentChanges)) {
    for (const item of rawDocumentChanges) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const textDocument = (item as { textDocument?: unknown }).textDocument;
      const edits = (item as { edits?: unknown }).edits;
      if (
        textDocument &&
        typeof textDocument === "object" &&
        !Array.isArray(textDocument) &&
        Array.isArray(edits)
      ) {
        const uri = normalizeString((textDocument as { uri?: unknown }).uri);
        const normalizedEdits = edits
          .map(entry => normalizeTextEdit(entry))
          .filter((entry): entry is LspTextEdit => entry !== null);
        if (uri && normalizedEdits.length > 0) {
          documentChanges.push({
            kind: "text",
            uri,
            edits: normalizedEdits,
          });
          continue;
        }
      }
      const operation = normalizeString((item as { kind?: unknown }).kind) ?? "resource";
      documentChanges.push({
        kind: "resource",
        operation,
      });
    }
  }

  if (Object.keys(changes).length === 0 && documentChanges.length === 0) {
    return null;
  }

  return {
    changes,
    documentChanges,
  };
};

const hasPrepareRenameProvider = (capabilities: LspServerCapabilities) => {
  const renameProvider = capabilities.renameProvider;
  if (renameProvider === true) {
    return false;
  }
  if (renameProvider && typeof renameProvider === "object" && !Array.isArray(renameProvider)) {
    return Boolean((renameProvider as { prepareProvider?: unknown }).prepareProvider);
  }
  return false;
};

const supportsPullDiagnostics = (capabilities: LspServerCapabilities) =>
  Boolean(capabilities.diagnosticProvider);

const toUri = (filePath: string) => pathToFileURL(filePath).href;

const fromUriToPath = (uri: string) => {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

const getLineStartOffsets = (content: string) => {
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
};

const positionToIndex = (content: string, position: LspPosition) => {
  const lineStarts = getLineStartOffsets(content);
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
};

const sliceContentByRange = (content: string, range: LspRange) =>
  content.slice(positionToIndex(content, range.start), positionToIndex(content, range.end));

const detectLanguageId = (filePath: string) => {
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".lua":
      return "lua";
    default:
      return undefined;
  }
};

const findIdentifierRangeAt = (content: string, line: number, column: number): LspRange | null => {
  const lineStarts = getLineStartOffsets(content);
  const lineStart = lineStarts[line];
  if (typeof lineStart !== "number") {
    return null;
  }
  const nextLineStart =
    line + 1 < lineStarts.length ? (lineStarts[line + 1] ?? content.length) : content.length;
  let lineEnd = nextLineStart;
  if (lineEnd > lineStart && content[lineEnd - 1] === "\n") {
    lineEnd -= 1;
  }
  if (lineEnd > lineStart && content[lineEnd - 1] === "\r") {
    lineEnd -= 1;
  }
  const lineText = content.slice(lineStart, lineEnd);
  const charIndex = Math.max(0, Math.min(column, lineText.length));
  const isWordChar = (char: string) => /[A-Za-z0-9_$]/.test(char);

  let start = charIndex;
  let end = charIndex;
  const currentChar = lineText[charIndex] ?? "";
  const previousChar = lineText[Math.max(0, charIndex - 1)] ?? "";

  if (currentChar && isWordChar(currentChar)) {
    start = charIndex;
    end = charIndex + 1;
  } else if (previousChar && isWordChar(previousChar)) {
    start = charIndex - 1;
    end = charIndex;
  } else {
    return null;
  }

  while (start > 0 && isWordChar(lineText[start - 1] ?? "")) {
    start -= 1;
  }
  while (end < lineText.length && isWordChar(lineText[end] ?? "")) {
    end += 1;
  }

  return {
    start: { line, character: start },
    end: { line, character: end },
  };
};

class LspClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextRequestId = 1;
  private initializePromise: Promise<LspServerCapabilities> | null = null;
  private capabilities: LspServerCapabilities | null = null;
  private readonly workspaceUri: string;
  private readonly workspaceFolder = {
    uri: "",
    name: "",
  };
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<
    string,
    Array<(diagnostics: LspDiagnostic[]) => void>
  >();

  constructor(private readonly options: LspClientOptions) {
    this.workspaceUri = toUri(options.rootPath);
    this.workspaceFolder.uri = this.workspaceUri;
    this.workspaceFolder.name = basename(options.rootPath) || options.config.id;
  }

  private formatStartupError(reason: string) {
    return `LSP startup error: ${this.options.config.id} (${this.options.config.command}) ${reason}`;
  }

  private rememberDiagnostics(uri: string, diagnostics: LspDiagnostic[]) {
    this.diagnostics.set(uri, diagnostics);
    const waiters = this.diagnosticWaiters.get(uri) ?? [];
    this.diagnosticWaiters.delete(uri);
    for (const waiter of waiters) {
      waiter(diagnostics);
    }
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private sendMessage(message: Record<string, unknown>) {
    if (!this.process) {
      throw new Error(`LSP server not running: ${this.options.config.id}`);
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      ...message,
    });
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    this.process.stdin.write(frame, "utf8");
  }

  private sendResponse(id: number | string | null, result: unknown) {
    this.sendMessage({
      id,
      result,
    });
  }

  private async handleServerRequest(message: JsonRpcRequestMessage) {
    if (message.id === undefined || typeof message.method !== "string") {
      return;
    }

    const { method, params } = message;
    switch (method) {
      case "workspace/configuration": {
        const items =
          params &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          Array.isArray((params as { items?: unknown }).items)
            ? ((params as { items: Array<{ section?: string }> }).items ?? [])
            : [];
        const settings = this.options.config.settings;
        this.sendResponse(
          message.id,
          items.map(item => {
            const section = normalizeString(item?.section);
            if (!section || !settings || typeof settings !== "object") {
              return settings ?? null;
            }
            return (settings as Record<string, unknown>)[section] ?? null;
          })
        );
        return;
      }
      case "workspace/workspaceFolders":
        this.sendResponse(message.id, [this.workspaceFolder]);
        return;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        this.sendResponse(message.id, null);
        return;
      default:
        this.sendResponse(message.id, null);
    }
  }

  private handleNotification(message: JsonRpcRequestMessage) {
    if (message.id !== undefined || typeof message.method !== "string") {
      return;
    }
    if (message.method !== "textDocument/publishDiagnostics") {
      return;
    }
    const params = message.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return;
    }
    const uri = normalizeString((params as { uri?: unknown }).uri);
    const diagnostics = Array.isArray((params as { diagnostics?: unknown }).diagnostics)
      ? ((params as { diagnostics: unknown[] }).diagnostics ?? [])
          .map(item => normalizeDiagnostic(item))
          .filter((item): item is LspDiagnostic => item !== null)
      : [];
    if (uri) {
      this.rememberDiagnostics(uri, diagnostics);
    }
  }

  private handleResponseMessage(message: JsonRpcResponseMessage) {
    if (message.id === undefined || typeof message.id !== "number") {
      return;
    }
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    if (message.error) {
      const errorMessage = normalizeString(message.error.message);
      pending.reject(
        new Error(
          errorMessage
            ? `LSP request failed: ${this.options.config.id}: ${errorMessage}`
            : `LSP request failed: ${this.options.config.id}`
        )
      );
      return;
    }
    pending.resolve(message.result);
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
        this.rejectAllPending(new Error("Invalid LSP frame received."));
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
        const parsed = JSON.parse(payload) as JsonRpcResponseMessage & JsonRpcRequestMessage;
        if (typeof parsed.method === "string") {
          void this.handleServerRequest(parsed);
          this.handleNotification(parsed);
          continue;
        }
        this.handleResponseMessage(parsed);
      } catch (error) {
        this.rejectAllPending(
          new Error(
            `Invalid LSP JSON: ${error instanceof Error ? error.message : String(error)}`
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

    const rootPath = resolve(this.options.rootPath);
    const child = (this.options.spawnProcess ?? spawn)(
      resolveCommandPath(rootPath, this.options.config.command),
      this.options.config.args ?? [],
      {
        cwd: rootPath,
        env: {
          ...process.env,
          ...this.options.env,
          ...(this.options.config.env ?? {}),
        },
        stdio: "pipe",
      }
    );

    child.stdout.on("data", chunk => {
      this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", () => {
      // Best effort: ignore stderr chatter and surface request failures instead.
    });
    child.on("error", error => {
      this.process = null;
      this.capabilities = null;
      this.initializePromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      this.rejectAllPending(new Error(this.formatStartupError(`failed to launch: ${detail}`)));
    });
    child.on("exit", (code, signal) => {
      this.process = null;
      this.capabilities = null;
      this.initializePromise = null;
      this.rejectAllPending(
        new Error(
          this.formatStartupError(
            `exited before request completed (${code ?? "null"}${
              signal ? `, ${signal}` : ""
            })`
          )
        )
      );
    });

    this.process = child;
    return child;
  }

  private request(method: string, params?: Record<string, unknown>) {
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pendingRequests.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
      });

      void this.ensureProcess()
        .then(() => {
          this.sendMessage({
            id,
            method,
            ...(params === undefined ? {} : { params }),
          });
        })
        .catch(error => {
          this.pendingRequests.delete(id);
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  notify(method: string, params?: Record<string, unknown>) {
    this.sendMessage({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async initialize() {
    if (this.capabilities) {
      return this.capabilities;
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      await this.ensureProcess();
      const result = await this.request("initialize", {
        processId: process.pid,
        rootUri: this.workspaceUri,
        workspaceFolders: [this.workspaceFolder],
        clientInfo: CLIENT_INFO,
        initializationOptions: this.options.config.initializationOptions,
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
          },
          textDocument: {
            hover: {
              contentFormat: ["markdown", "plaintext"],
            },
            definition: {},
            references: {},
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            rename: {
              prepareSupport: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
            diagnostic: {},
          },
        },
      });

      const capabilities =
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        (result as { capabilities?: unknown }).capabilities &&
        typeof (result as { capabilities: unknown }).capabilities === "object" &&
        !Array.isArray((result as { capabilities: unknown }).capabilities)
          ? ((result as { capabilities: LspServerCapabilities }).capabilities ?? {})
          : {};

      this.capabilities = capabilities;
      this.notify("initialized", {});
      if (this.options.config.settings !== undefined) {
        this.notify("workspace/didChangeConfiguration", {
          settings: this.options.config.settings,
        });
      }
      return capabilities;
    })();

    try {
      return await this.initializePromise;
    } finally {
      if (!this.capabilities) {
        this.initializePromise = null;
      }
    }
  }

  async hover(uri: string, position: LspPosition) {
    await this.initialize();
    return normalizeHover(
      await this.request("textDocument/hover", {
        textDocument: { uri },
        position,
      })
    );
  }

  async definition(uri: string, position: LspPosition) {
    await this.initialize();
    return normalizeLocationArray(
      await this.request("textDocument/definition", {
        textDocument: { uri },
        position,
      })
    );
  }

  async references(uri: string, position: LspPosition) {
    await this.initialize();
    return normalizeLocationArray(
      await this.request("textDocument/references", {
        textDocument: { uri },
        position,
        context: {
          includeDeclaration: true,
        },
      })
    );
  }

  async documentSymbols(uri: string) {
    await this.initialize();
    const result = await this.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return Array.isArray(result)
      ? result
          .map(item => normalizeDocumentSymbol(item))
          .filter((item): item is LspDocumentSymbol => item !== null)
      : [];
  }

  async requestDiagnostics(uri: string) {
    const capabilities = await this.initialize();
    if (!supportsPullDiagnostics(capabilities)) {
      return null;
    }
    const result = await this.request("textDocument/diagnostic", {
      textDocument: { uri },
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return [];
    }
    const kind = normalizeString((result as { kind?: unknown }).kind);
    if (kind === "unchanged") {
      return this.diagnostics.get(uri) ?? [];
    }
    const items = Array.isArray((result as { items?: unknown }).items)
      ? ((result as { items: unknown[] }).items ?? [])
          .map(item => normalizeDiagnostic(item))
          .filter((item): item is LspDiagnostic => item !== null)
      : [];
    this.rememberDiagnostics(uri, items);
    return items;
  }

  async waitForPublishedDiagnostics(uri: string, timeoutMs = LSP_DIAGNOSTIC_WAIT_MS) {
    const cached = this.diagnostics.get(uri);
    const next = new Promise<LspDiagnostic[]>(resolveDiagnostics => {
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(resolveDiagnostics);
      this.diagnosticWaiters.set(uri, waiters);
    });

    const timeout = delay(timeoutMs).then(() => cached ?? []);
    return Promise.race([next, timeout]);
  }

  async prepareRename(uri: string, position: LspPosition) {
    await this.initialize();
    const result = await this.request("textDocument/prepareRename", {
      textDocument: { uri },
      position,
    });
    if (!result) {
      return null;
    }
    const range = normalizeRange(result);
    if (range) {
      return {
        range,
      };
    }
    if (typeof result === "object" && !Array.isArray(result)) {
      const normalizedRange = normalizeRange((result as { range?: unknown }).range);
      if (!normalizedRange) {
        return null;
      }
      return {
        range: normalizedRange,
        placeholder: normalizeString((result as { placeholder?: unknown }).placeholder),
      };
    }
    return null;
  }

  async rename(uri: string, position: LspPosition, newName: string) {
    await this.initialize();
    return normalizeWorkspaceEdit(
      await this.request("textDocument/rename", {
        textDocument: { uri },
        position,
        newName,
      })
    );
  }

  invalidate(uri?: string) {
    if (!uri) {
      this.diagnostics.clear();
      return;
    }
    this.diagnostics.delete(uri);
  }

  async dispose() {
    const processHandle = this.process;
    if (processHandle) {
      try {
        await this.request("shutdown");
      } catch {
        // Best effort shutdown.
      }
      try {
        this.notify("exit");
      } catch {
        // Best effort shutdown.
      }
      try {
        processHandle.kill();
      } catch {
        // Best effort shutdown.
      }
    }
    this.process = null;
    this.capabilities = null;
    this.initializePromise = null;
    this.diagnostics.clear();
    this.stdoutBuffer = Buffer.alloc(0);
    this.rejectAllPending(new Error("LSP client disposed."));
  }
}

class LspWorkspaceSession implements LspWorkspaceLike {
  private readonly client: LspClient;
  private readonly openedFiles = new Map<string, { version: number; content: string }>();

  constructor(
    private readonly rootPath: string,
    private readonly config: LspServerConfig,
    options?: {
      env?: NodeJS.ProcessEnv;
      spawnProcess?: typeof spawn;
    }
  ) {
    this.client = new LspClient({
      rootPath,
      config,
      env: options?.env,
      spawnProcess: options?.spawnProcess,
    });
  }

  getInfo() {
    return {
      serverId: this.config.id,
      rootPath: this.rootPath,
    };
  }

  async probe(filePath: string) {
    await this.ensureSynced(filePath);
    return this.getInfo();
  }

  private assertInSessionRoot(filePath: string) {
    if (!isPathInsideRoot(filePath, this.rootPath)) {
      throw new Error(
        `LSP path is outside the configured session root (${this.config.id}): ${filePath}`
      );
    }
  }

  private async ensureSynced(filePath: string) {
    this.assertInSessionRoot(filePath);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) {
      throw new Error(`LSP tools only support files: ${filePath}`);
    }
    const content = await readFile(filePath, "utf8");
    const current = this.openedFiles.get(filePath);
    const uri = toUri(filePath);
    await this.client.initialize();
    if (!current) {
      this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: detectLanguageId(filePath),
          version: 1,
          text: content,
        },
      });
      this.openedFiles.set(filePath, {
        version: 1,
        content,
      });
      return content;
    }
    if (current.content === content) {
      return current.content;
    }
    const nextVersion = current.version + 1;
    this.client.notify("textDocument/didChange", {
      textDocument: {
        uri,
        version: nextVersion,
      },
      contentChanges: [{ text: content }],
    });
    this.openedFiles.set(filePath, {
      version: nextVersion,
      content,
    });
    this.client.invalidate(uri);
    return content;
  }

  async hover(filePath: string, line: number, column: number) {
    await this.ensureSynced(filePath);
    return this.client.hover(toUri(filePath), {
      line: line - 1,
      character: column - 1,
    });
  }

  async definition(filePath: string, line: number, column: number) {
    await this.ensureSynced(filePath);
    return this.client.definition(toUri(filePath), {
      line: line - 1,
      character: column - 1,
    });
  }

  async references(filePath: string, line: number, column: number) {
    await this.ensureSynced(filePath);
    return this.client.references(toUri(filePath), {
      line: line - 1,
      character: column - 1,
    });
  }

  async documentSymbols(filePath: string) {
    await this.ensureSynced(filePath);
    return this.client.documentSymbols(toUri(filePath));
  }

  async diagnostics(filePath: string) {
    await this.ensureSynced(filePath);
    const uri = toUri(filePath);
    try {
      const pulled = await this.client.requestDiagnostics(uri);
      if (pulled) {
        return pulled;
      }
    } catch {
      // Fall back to publishDiagnostics.
    }
    return this.client.waitForPublishedDiagnostics(uri);
  }

  async prepareRename(filePath: string, line: number, column: number) {
    const content = await this.ensureSynced(filePath);
    const uri = toUri(filePath);
    try {
      const result = await this.client.prepareRename(uri, {
        line: line - 1,
        character: column - 1,
      });
      if (!result) {
        return null;
      }
      const placeholder =
        result.placeholder && result.placeholder.trim()
          ? result.placeholder
          : sliceContentByRange(content, result.range);
      return {
        range: result.range,
        placeholder,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error);
      if (!message.includes("method not found")) {
        throw error;
      }
      const range = findIdentifierRangeAt(content, line - 1, column - 1);
      if (!range) {
        return null;
      }
      return {
        range,
        placeholder: sliceContentByRange(content, range),
      };
    }
  }

  async rename(filePath: string, line: number, column: number, newName: string) {
    await this.ensureSynced(filePath);
    return this.client.rename(toUri(filePath), {
      line: line - 1,
      character: column - 1,
    }, newName);
  }

  invalidate(filePath?: string) {
    if (!filePath) {
      for (const openedPath of this.openedFiles.keys()) {
        const uri = toUri(openedPath);
        this.client.invalidate(uri);
      }
      this.openedFiles.clear();
      return;
    }
    const uri = toUri(filePath);
    this.openedFiles.delete(filePath);
    this.client.invalidate(uri);
  }

  async dispose() {
    for (const filePath of this.openedFiles.keys()) {
      try {
        this.client.notify("textDocument/didClose", {
          textDocument: {
            uri: toUri(filePath),
          },
        });
      } catch {
        // Best effort.
      }
    }
    this.openedFiles.clear();
    await this.client.dispose();
  }
}

const fileMatchesServer = (
  filePath: string,
  workspaceRoot: string,
  config: LspServerConfig
) => {
  const serverWorkspaceRoot = resolve(workspaceRoot, config.workspaceRoot ?? ".");
  if (!isPathInsideRoot(filePath, serverWorkspaceRoot)) {
    return false;
  }
  const relativePath = normalizePathForGlob(relative(serverWorkspaceRoot, filePath));
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }
  if (config.filePatterns.length === 0) {
    return true;
  }
  return config.filePatterns.some(pattern => globToRegExp(pattern).test(relativePath));
};

const resolveSessionRoot = async (
  filePath: string,
  workspaceRoot: string,
  config: LspServerConfig
) => {
  const serverWorkspaceRoot = resolve(workspaceRoot, config.workspaceRoot ?? ".");
  let current = dirname(filePath);
  if (!isPathInsideRoot(current, serverWorkspaceRoot)) {
    return serverWorkspaceRoot;
  }
  while (true) {
    if (config.rootMarkers.length > 0) {
      for (const marker of config.rootMarkers) {
        try {
          await access(resolve(current, marker));
          return current;
        } catch {
          // Try next marker/root.
        }
      }
    }
    if (current === serverWorkspaceRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current || !isPathInsideRoot(parent, serverWorkspaceRoot)) {
      break;
    }
    current = parent;
  }
  return serverWorkspaceRoot;
};

const formatConfiguredServerIds = (configs: LspServerConfig[]) =>
  configs.length > 0 ? configs.map(config => config.id).join(", ") : "(none)";

const formatRelativeWorkspacePath = (workspaceRoot: string, filePath: string) => {
  const relativePath = normalizePathForGlob(relative(workspaceRoot, filePath));
  if (!relativePath || relativePath === "") {
    return normalizePathForGlob(filePath);
  }
  return relativePath;
};

export class LspManager implements LspManagerLike {
  private readonly sessions = new Map<string, LspWorkspaceLike>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly configs: LspServerConfig[],
    private readonly options: LspManagerOptions = {}
  ) {}

  private getServerConfigForId(serverId: string) {
    return this.configs.find(config => config.id.toLowerCase() === serverId.toLowerCase());
  }

  private buildNoConfiguredServersError() {
    return new Error(
      [
        "LSP config error: no lsp_servers are configured for this filesystem workspace.",
        `workspace: ${this.workspaceRoot}`,
        "hint: add `lsp_servers` under the filesystem server in .cyrene/mcp.yaml or use `/mcp lsp add ...`",
      ].join("\n")
    );
  }

  private buildServerNotFoundError(serverId: string) {
    return new Error(
      [
        `LSP config error: serverId '${serverId}' is not configured.`,
        `configured: ${formatConfiguredServerIds(this.configs)}`,
        "hint: re-run with a configured serverId or add the missing lsp_servers entry",
      ].join("\n")
    );
  }

  private buildPathMismatchError(config: LspServerConfig, filePath: string) {
    return new Error(
      [
        `LSP config error: serverId '${config.id}' does not match path '${formatRelativeWorkspacePath(this.workspaceRoot, filePath)}'.`,
        `workspace: ${this.workspaceRoot}`,
        `file_patterns: ${config.filePatterns.join(", ")}`,
        `server_workspace: ${resolve(this.workspaceRoot, config.workspaceRoot ?? ".")}`,
        "hint: use a different serverId or adjust file_patterns/workspace_root",
      ].join("\n")
    );
  }

  private buildNoMatchError(filePath: string) {
    return new Error(
      [
        `LSP config error: no configured LSP server matches '${formatRelativeWorkspacePath(this.workspaceRoot, filePath)}'.`,
        `configured: ${formatConfiguredServerIds(this.configs)}`,
        "hint: add a matching file_patterns entry or re-run with a specific serverId if you expected one match",
      ].join("\n")
    );
  }

  private buildMultipleMatchError(filePath: string, matches: LspServerConfig[]) {
    return new Error(
      [
        `LSP config error: multiple LSP servers match '${formatRelativeWorkspacePath(this.workspaceRoot, filePath)}'.`,
        `matched: ${matches.map(config => config.id).join(", ")}`,
        "hint: re-run with serverId to disambiguate",
      ].join("\n")
    );
  }

  private async createSession(config: LspServerConfig, rootPath: string) {
    return (
      this.options.sessionFactory?.({
        rootPath,
        config,
        env: this.options.env,
        spawnProcess: this.options.spawnProcess,
      }) ??
      new LspWorkspaceSession(rootPath, config, {
        env: this.options.env,
        spawnProcess: this.options.spawnProcess,
      })
    );
  }

  async inspectPath(filePath: string, options?: { serverId?: string }) {
    if (this.configs.length === 0) {
      throw this.buildNoConfiguredServersError();
    }

    const configuredServerIds = this.configs.map(config => config.id);
    const explicitServerId = options?.serverId?.trim();
    if (explicitServerId) {
      const config = this.getServerConfigForId(explicitServerId);
      if (!config) {
        throw this.buildServerNotFoundError(explicitServerId);
      }
      if (!fileMatchesServer(filePath, this.workspaceRoot, config)) {
        throw this.buildPathMismatchError(config, filePath);
      }
      const rootPath = await resolveSessionRoot(filePath, this.workspaceRoot, config);
      return {
        workspaceRoot: this.workspaceRoot,
        relativePath: formatRelativeWorkspacePath(this.workspaceRoot, filePath),
        configuredServerIds,
        matchedServerIds: [config.id],
        selectedServerId: config.id,
        resolvedRoot: rootPath,
      } satisfies LspPathInspection;
    }

    const matches = this.configs.filter(config =>
      fileMatchesServer(filePath, this.workspaceRoot, config)
    );

    if (matches.length === 0) {
      throw this.buildNoMatchError(filePath);
    }

    if (matches.length > 1) {
      throw this.buildMultipleMatchError(filePath, matches);
    }

    const config = matches[0]!;
    const rootPath = await resolveSessionRoot(filePath, this.workspaceRoot, config);
    return {
      workspaceRoot: this.workspaceRoot,
      relativePath: formatRelativeWorkspacePath(this.workspaceRoot, filePath),
      configuredServerIds,
      matchedServerIds: matches.map(match => match.id),
      selectedServerId: config.id,
      resolvedRoot: rootPath,
    } satisfies LspPathInspection;
  }

  async getSession(filePath: string, options?: { serverId?: string }) {
    const inspection = await this.inspectPath(filePath, options);
    const config = this.getServerConfigForId(inspection.selectedServerId ?? "");
    if (!config || !inspection.resolvedRoot) {
      throw new Error("LSP config error: failed to resolve a matching session.");
    }
    const rootPath = inspection.resolvedRoot;
    const key = `${config.id}:${rootPath}`;
    const cached = this.sessions.get(key);
    if (cached) {
      return cached;
    }
    const created = await this.createSession(config, rootPath);
    this.sessions.set(key, created);
    return created;
  }

  invalidate(filePath?: string) {
    if (!filePath) {
      for (const session of this.sessions.values()) {
        session.invalidate();
      }
      return;
    }
    for (const session of this.sessions.values()) {
      const rootPath = session.getInfo().rootPath;
      if (isPathInsideRoot(filePath, rootPath)) {
        session.invalidate(filePath);
      }
    }
  }

  async dispose() {
    await Promise.all(
      [...this.sessions.values()].map(session => Promise.resolve(session.dispose()))
    );
    this.sessions.clear();
  }
}

export const createLspServerConfig = (
  config: LspServerConfig
): LspServerConfig => ({
  ...config,
  args: [...config.args],
  filePatterns: [...config.filePatterns],
  rootMarkers: [...config.rootMarkers],
  ...(config.env ? { env: { ...config.env } } : {}),
});

export const pathFromLspUri = fromUriToPath;
