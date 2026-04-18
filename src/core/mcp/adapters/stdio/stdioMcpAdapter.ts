import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpConfiguredServer } from "../../loadMcpConfig";
import type {
  McpHandleResult,
  McpServerAdapter,
  McpServerDescriptor,
  McpServerExitPhase,
  McpServerExitSource,
  McpServerHealthReason,
} from "../../runtimeTypes";
import type { PendingReviewItem } from "../../toolTypes";
import {
  buildRemoteToolDescriptors,
  formatRemoteToolCallResult,
  type RemoteMcpTool,
  type RemoteToolCallResult,
} from "../remote/mcpRemoteProtocol";
import { buildRestrictedSubprocessEnvFromBase } from "../filesystem/subprocessEnv";

type StdioMcpAdapterContext = {
  appRoot: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  initializeTimeoutMs?: number;
  discoveryTimeoutMs?: number;
};

type JsonRpcResponse = {
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRemoteReview = {
  id: string;
  toolName: string;
  input: unknown;
  item: PendingReviewItem;
};

type DirectRetrySpawnTarget = {
  command: string;
  args: string[];
};

type StdioFramingMode = "content-length" | "newline";

const CLIENT_INFO = {
  name: "cyrene-code",
  version: "0.1.3",
};

const PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05", "2024-10-07"];
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const PACKAGE_MANAGER_BOOTSTRAP_TIMEOUT_MS = 45_000;
const RESUME_STDIN_REQUIRE_PATH = fileURLToPath(
  new URL("./resumeStdin.cjs", import.meta.url)
);
const LEGACY_STDIO_BRIDGE_PATH = fileURLToPath(
  new URL("./legacyStdioBridge.cjs", import.meta.url)
);
const QUIET_LEGACY_STDOUT_REQUIRE_PATH = fileURLToPath(
  new URL("./quietLegacyStdout.cjs", import.meta.url)
);
const resolveHomeDir = (env?: NodeJS.ProcessEnv) =>
  env?.HOME || env?.USERPROFILE || process.env.HOME || process.env.USERPROFILE || "";

const extractPackageSpecFromBootstrapCommand = (server: McpConfiguredServer) => {
  const commandName = getCommandBasename(server.command);
  const args = server.args ?? [];
  if (commandName === "npx") {
    return args.find(arg => !arg.startsWith("-")) ?? null;
  }
  if (commandName === "npm") {
    const execIndex = args.findIndex(arg => {
      const normalized = arg.trim().toLowerCase();
      return normalized === "exec" || normalized === "x";
    });
    if (execIndex < 0) {
      return null;
    }
    return args.slice(execIndex + 1).find(arg => !arg.startsWith("-")) ?? null;
  }
  return null;
};

const extractPackageNameFromSpec = (spec: string) => {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.includes("\\")) {
    return null;
  }
  if (!trimmed.startsWith("@")) {
    const versionSeparator = trimmed.indexOf("@");
    return versionSeparator >= 0 ? trimmed.slice(0, versionSeparator) : trimmed;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) {
    return null;
  }
  const versionSeparator = trimmed.indexOf("@", slashIndex + 1);
  return versionSeparator >= 0 ? trimmed.slice(0, versionSeparator) : trimmed;
};

const resolveCommandPath = (appRoot: string, command: string) => {
  if (
    command.startsWith(".\\") ||
    command.startsWith("./") ||
    command.startsWith("..\\") ||
    command.startsWith("../") ||
    command.includes("\\") ||
    command.includes("/")
  ) {
    return resolve(appRoot, command);
  }
  return command;
};

const resolveServerCwd = (appRoot: string, cwd?: string) =>
  cwd ? resolve(appRoot, cwd) : appRoot;

const getCommandBasename = (command?: string) =>
  command
    ? basename(command)
        .toLowerCase()
        .replace(/\.(cmd|exe|bat|ps1)$/i, "")
    : "";

const isPackageBootstrapCommand = (server: McpConfiguredServer) => {
  const commandName = getCommandBasename(server.command);
  if (commandName === "npx") {
    return true;
  }
  if (commandName === "npm") {
    const firstArg = server.args?.[0]?.trim().toLowerCase();
    return firstArg === "exec" || firstArg === "x";
  }
  return false;
};

const normalizeToolArray = (value: unknown): RemoteMcpTool[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const tools = "tools" in value && Array.isArray(value.tools) ? value.tools : [];
  const normalized: Array<RemoteMcpTool | null> = tools.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const name = "name" in item && typeof item.name === "string" ? item.name.trim() : "";
      if (!name) {
        return null;
      }
      return {
        name,
        description:
          "description" in item && typeof item.description === "string"
          ? item.description
          : undefined,
        inputSchema: "inputSchema" in item ? item.inputSchema : undefined,
      } satisfies RemoteMcpTool;
    });
  return normalized.filter((item): item is RemoteMcpTool => item !== null);
};

const getErrorText = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
};

const extractResultBody = (message: string) => {
  const [, ...rest] = message.split("\n");
  const body = rest.join("\n").trim();
  return body || message.trim();
};

const stringifyPreviewInput = (input: unknown, pretty: boolean) => {
  if (input === undefined) {
    return "(none)";
  }
  if (typeof input === "string") {
    return input.trim() || "(empty string)";
  }
  try {
    return JSON.stringify(input, null, pretty ? 2 : 0) ?? "(unserializable)";
  } catch {
    return String(input);
  }
};

const truncatePreview = (value: string, maxChars: number) =>
  value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;

const buildRecentStderrSection = (stderrLines: string[]) =>
  stderrLines.length > 0
    ? `Recent stderr:\n${stderrLines.slice(-3).map(line => `- ${line}`).join("\n")}`
    : "";

const buildBoundedStderrSection = (stderrLines: string[], maxLines = 6) =>
  stderrLines.length > 0
    ? `Recent stderr:\n${stderrLines.slice(-maxLines).map(line => `- ${line}`).join("\n")}`
    : "";

const isLowSignalRemoteToolErrorBody = (body: string) => {
  const lines = body
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "";
  if (!firstLine) {
    return true;
  }
  if (firstLine.endsWith(":")) {
    return true;
  }
  return (
    /^Error executing tool '.*':\s*Search failed for ".*":\s*$/i.test(firstLine) ||
    /^Error searching [^:]+:\s*IAsk search failed for ".*":\s*$/i.test(firstLine) ||
    /^Search failed for ".*":\s*$/i.test(firstLine) ||
    /^IAsk search failed for ".*":\s*$/i.test(firstLine)
  );
};

const buildPackageBootstrapNodeOptions = (
  contextEnv: NodeJS.ProcessEnv | undefined,
  serverEnv: Record<string, string> | undefined,
  options?: {
    includeResumeStdin?: boolean;
  }
) =>
  [
    contextEnv?.NODE_OPTIONS,
    serverEnv?.NODE_OPTIONS,
    options?.includeResumeStdin === false
      ? null
      : `--require=${RESUME_STDIN_REQUIRE_PATH}`,
  ]
    .filter(Boolean)
    .join(" ");

const buildServerSpawnEnv = (
  server: McpConfiguredServer,
  contextEnv: NodeJS.ProcessEnv | undefined,
  options?: {
    includeResumeStdin?: boolean;
  }
) => {
  if (!isPackageBootstrapCommand(server)) {
    return server.env;
  }
  return {
    ...(server.env ?? {}),
    NODE_OPTIONS: buildPackageBootstrapNodeOptions(
      contextEnv,
      server.env,
      options
    ),
  };
};

export class StdioMcpAdapter implements McpServerAdapter {
  descriptor: McpServerDescriptor;

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
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly stderrLines: string[] = [];
  private readonly pendingReviews = new Map<string, PendingRemoteReview>();
  private framingMode: StdioFramingMode = "content-length";
  private legacyProtocolFallbackAttempted = false;
  private currentPhase: McpServerExitPhase = "startup";
  private pendingExitSource: McpServerExitSource | null = null;
  private directRetrySpawnTarget: DirectRetrySpawnTarget | null = null;

  constructor(
    private readonly server: McpConfiguredServer,
    private readonly context: StdioMcpAdapterContext
  ) {
    this.descriptor = {
      id: server.id,
      label: server.label,
      enabled: server.enabled,
      source: "local",
      health: server.enabled ? "unknown" : "offline",
      transport: "stdio",
      aliases: [...server.aliases],
      exposure: server.exposure ?? "hinted",
      tags: [...(server.tags ?? [])],
      hint: server.hint,
      tools: buildRemoteToolDescriptors(server, []),
    };
  }

  private rememberStderr(data: string) {
    const lines = data
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    this.stderrLines.push(...lines);
    if (this.stderrLines.length > 20) {
      this.stderrLines.splice(0, this.stderrLines.length - 20);
    }
  }

  private setHealthError(
    reason: McpServerHealthReason,
    detail: string,
    hint?: string
  ) {
    this.descriptor.health = "error";
    this.descriptor.healthReason = reason;
    this.descriptor.healthDetail = detail.trim();
    this.descriptor.healthHint = hint?.trim() || undefined;
  }

  private clearExitMetadata() {
    this.descriptor.healthExitCode = undefined;
    this.descriptor.healthExitSignal = undefined;
    this.descriptor.healthExitPhase = undefined;
    this.descriptor.healthExitSource = undefined;
    this.pendingExitSource = null;
  }

  private recordExitMetadata(code: number | null, signal: NodeJS.Signals | null) {
    this.descriptor.healthExitCode = code;
    this.descriptor.healthExitSignal = signal;
    this.descriptor.healthExitPhase = this.currentPhase;
    this.descriptor.healthExitSource =
      this.pendingExitSource ??
      (signal || code !== null ? "external_or_server" : "unknown");
    this.pendingExitSource = null;
  }

  private setCurrentPhase(phase: McpServerExitPhase) {
    this.currentPhase = phase;
  }

  private requestProcessKill(
    source: Exclude<McpServerExitSource, "external_or_server" | "unknown">
  ) {
    if (!this.process) {
      return false;
    }
    this.pendingExitSource = source;
    const killed = this.process.kill();
    if (!killed) {
      this.pendingExitSource = null;
    }
    return killed;
  }

  private clearHealthError(nextHealth: McpServerDescriptor["health"]) {
    this.descriptor.health = nextHealth;
    this.descriptor.healthReason = undefined;
    this.descriptor.healthDetail = undefined;
    this.descriptor.healthHint = undefined;
    this.clearExitMetadata();
  }

  private buildHealthDetail(error: unknown) {
    return [getErrorText(error), buildRecentStderrSection(this.stderrLines)]
      .filter(Boolean)
      .join("\n");
  }

  private formatRemoteToolResult(
    toolName: string,
    result: unknown,
    stderrStartIndex: number
  ): McpHandleResult {
    const formatted = formatRemoteToolCallResult(toolName, result);
    if (formatted.ok) {
      return formatted;
    }

    const [header = `[tool error] ${toolName}`, ...rest] = formatted.message.split("\n");
    const body = rest.join("\n").trim();
    if (!isLowSignalRemoteToolErrorBody(body)) {
      return formatted;
    }

    const remoteResult =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as RemoteToolCallResult)
        : undefined;
    const stderrSection = buildBoundedStderrSection(
      this.stderrLines.slice(stderrStartIndex)
    );
    const explanation = remoteResult?.isError
      ? "Upstream MCP tool reported an error without a concrete cause."
      : "Remote MCP tool call failed without a concrete cause.";

    return {
      ...formatted,
      message: [
        header,
        explanation,
        stderrSection || "No additional stderr detail was emitted by the server.",
      ].join("\n"),
    };
  }

  private isLikelyLegacyNewlineBootstrapServer() {
    if (!isPackageBootstrapCommand(this.server)) {
      return false;
    }
    if (this.descriptor.healthExitPhase !== "initialize") {
      return false;
    }
    if (
      this.descriptor.healthExitSource !== "external_or_server" &&
      this.descriptor.healthExitSource !== "unknown"
    ) {
      return false;
    }
    if (this.stderrLines.length === 0) {
      return true;
    }
    return this.stderrLines.some(line =>
      /listening on stdio/i.test(line) || /started .*stdio/i.test(line)
    );
  }

  private shouldRetryWithLegacyProtocol(reason: McpServerHealthReason) {
    if (
      ["initialize_timeout", "invalid_protocol_output"].includes(reason)
    ) {
      return true;
    }
    return (
      reason === "process_exited_early" &&
      this.isLikelyLegacyNewlineBootstrapServer()
    );
  }

  private async resolveDirectRetrySpawnTarget() {
    if (this.directRetrySpawnTarget) {
      return this.directRetrySpawnTarget;
    }

    const packageSpec = extractPackageSpecFromBootstrapCommand(this.server);
    const packageName = packageSpec
      ? extractPackageNameFromSpec(packageSpec)
      : null;
    const homeDir = resolveHomeDir(this.context.env);
    if (!packageName || !homeDir) {
      return null;
    }

    const packagePathParts = packageName.split("/");
    const cacheRoot = join(homeDir, ".npm", "_npx");

    let cacheEntries;
    try {
      cacheEntries = await readdir(cacheRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    const candidates: Array<{
      binPath: string;
      mtimeMs: number;
      packageDir: string;
    }> = [];

    for (const entry of cacheEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = join(cacheRoot, entry.name, "node_modules", ...packagePathParts);
      const packageJsonPath = join(packageDir, "package.json");
      try {
        const [rawPackageJson, packageStat] = await Promise.all([
          readFile(packageJsonPath, "utf8"),
          stat(packageJsonPath),
        ]);
        const packageJson = JSON.parse(rawPackageJson) as {
          bin?: string | Record<string, string>;
        };
        const binField = packageJson.bin;
        const preferredBinName = packageName.split("/").pop() ?? packageName;
        const binPath =
          typeof binField === "string"
            ? binField
            : binField && typeof binField === "object"
              ? binField[preferredBinName] ??
                Object.values(binField).find(
                  value => typeof value === "string" && value.trim().length > 0
                ) ??
                null
              : null;
        if (!binPath) {
          continue;
        }
        candidates.push({
          binPath,
          mtimeMs: packageStat.mtimeMs,
          packageDir,
        });
      } catch {
        continue;
      }
    }

    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const selected = candidates[0];
    if (!selected) {
      return null;
    }

    this.directRetrySpawnTarget = {
      command: "node",
      args: [
        LEGACY_STDIO_BRIDGE_PATH,
        "node",
        "--require",
        QUIET_LEGACY_STDOUT_REQUIRE_PATH,
        "--require",
        RESUME_STDIN_REQUIRE_PATH,
        join(selected.packageDir, selected.binPath),
      ],
    };
    return this.directRetrySpawnTarget;
  }

  private classifyStdioError(
    error: unknown,
    phase: "initialize" | "tools/list" | "request" | "startup" = "startup"
  ): {
    reason: McpServerHealthReason;
    detail: string;
    hint?: string;
  } {
    const message = getErrorText(error);
    const detail = this.buildHealthDetail(error);

    if (
      phase === "tools/list" ||
      message.includes("tools/list")
    ) {
      return {
        reason: "tools_list_failed",
        detail,
        hint:
          "initialize succeeded, but tools/list failed; confirm the server exposes MCP tools and that the launch args enter MCP stdio mode.",
      };
    }

    if (message.includes("initialize timed out")) {
      return {
        reason: "initialize_timeout",
        detail,
        hint:
          "the process did not respond to initialize; confirm the command enters MCP stdio mode, for example with a required --stdio flag.",
      };
    }

    if (
      message.includes("Invalid MCP stdio frame") ||
      message.includes("Invalid MCP stdio JSON")
    ) {
      return {
        reason: "invalid_protocol_output",
        detail,
        hint:
          "stdout did not contain MCP JSON-RPC frames; confirm the command uses the server's stdio MCP mode and does not print logs to stdout.",
      };
    }

    if (message.includes("server exited")) {
      return {
        reason: "process_exited_early",
        detail,
        hint:
          "the process exited during startup; run the command manually to inspect stderr or missing runtime dependencies.",
      };
    }

    if (message.includes("server not running")) {
      return {
        reason: "process_exited_early",
        detail,
        hint:
          "the process exited before MCP initialization completed; inspect recent stderr for startup crashes or stdio lifecycle issues.",
      };
    }

    if (phase === "request") {
      return {
        reason: "request_failed",
        detail,
      };
    }

    return {
      reason: phase === "initialize" ? "startup_failed" : "unknown",
      detail,
    };
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleResponseMessage(message: JsonRpcResponse) {
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ??
            `MCP stdio request failed (${this.server.id})`
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  private consumeStdout(data: Buffer) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, data]);

    while (this.stdoutBuffer.length > 0) {
      const prefix = this.stdoutBuffer
        .subarray(0, Math.min(this.stdoutBuffer.length, 32))
        .toString("utf8")
        .toLowerCase();

      if (prefix.startsWith("content-length:")) {
        const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }

        const headerText = this.stdoutBuffer.slice(0, headerEnd).toString("utf8");
        const lengthMatch = /^content-length:\s*(\d+)$/im.exec(headerText);
        if (!lengthMatch) {
          this.stdoutBuffer = Buffer.alloc(0);
          this.rejectAllPending(
            new Error(`Invalid MCP stdio frame from ${this.server.id}`)
          );
          return;
        }

        const contentLength = Number(lengthMatch[1] ?? "0");
        const messageStart = headerEnd + 4;
        const messageEnd = messageStart + contentLength;
        if (this.stdoutBuffer.length < messageEnd) {
          return;
        }

        const payload = this.stdoutBuffer
          .slice(messageStart, messageEnd)
          .toString("utf8");
        this.stdoutBuffer = this.stdoutBuffer.slice(messageEnd);

        try {
          this.handleResponseMessage(JSON.parse(payload) as JsonRpcResponse);
        } catch (error) {
          this.rejectAllPending(
            new Error(
              `Invalid MCP stdio JSON from ${this.server.id}: ${getErrorText(error)}`
            )
          );
          return;
        }
        continue;
      }

      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const payload = this.stdoutBuffer.slice(0, newlineIndex).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!payload) {
        continue;
      }

      try {
        this.handleResponseMessage(JSON.parse(payload) as JsonRpcResponse);
      } catch (error) {
        this.rejectAllPending(
          new Error(
            `Invalid MCP stdio JSON from ${this.server.id}: ${getErrorText(error)}`
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

    if (!this.server.command) {
      throw new Error(`MCP stdio server missing command: ${this.server.id}`);
    }

    this.clearExitMetadata();
    this.setCurrentPhase("startup");

    const spawnTarget =
      this.directRetrySpawnTarget ??
      (this.server.command
        ? {
            command: resolveCommandPath(this.context.appRoot, this.server.command),
            args: this.server.args ?? [],
          }
        : null);
    if (!spawnTarget) {
      throw new Error(`MCP stdio server missing command: ${this.server.id}`);
    }

    const child = (this.context.spawnProcess ?? spawn)(
      spawnTarget.command,
      spawnTarget.args,
      {
        cwd: resolveServerCwd(this.context.appRoot, this.server.cwd),
        env: buildRestrictedSubprocessEnvFromBase(
          this.context.env,
          this.directRetrySpawnTarget
            ? this.server.env
            : buildServerSpawnEnv(this.server, this.context.env, {
                includeResumeStdin: this.framingMode !== "newline",
              })
        ),
        stdio: "pipe",
      }
    );

    child.stdout.on("data", chunk => {
      this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", chunk => {
      this.rememberStderr(
        Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
      );
    });
    child.on("error", error => {
      if (this.process !== child) {
        return;
      }
      if (this.pendingRequests.size === 0 && this.initPromise === null) {
        const classified = this.classifyStdioError(error, "startup");
        this.setHealthError(
          classified.reason,
          classified.detail,
          classified.hint
        );
      }
      this.rejectAllPending(error);
    });
    child.on("exit", (code, signal) => {
      if (this.process !== child) {
        return;
      }
      this.recordExitMetadata(code, signal);
      this.process = null;
      this.initialized = false;
      if (!this.descriptor.enabled) {
        this.clearHealthError("offline");
        return;
      }
      const exitError = new Error(
        `MCP stdio server exited: ${this.server.id} (${code ?? "null"}${signal ? `, ${signal}` : ""})`
      );
      if (this.pendingRequests.size === 0 && this.initPromise === null) {
        const classified = this.classifyStdioError(exitError, "startup");
        this.setHealthError(
          classified.reason,
          classified.detail,
          classified.hint
        );
      }
      this.rejectAllPending(exitError);
    });

    this.process = child;
    return child;
  }

  private sendMessage(message: Record<string, unknown>) {
    if (!this.process) {
      throw new Error(`MCP stdio server not running: ${this.server.id}`);
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      ...message,
    });
    const frame =
      this.framingMode === "newline"
        ? `${payload}\n`
        : `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
    this.process.stdin.write(frame, "utf8");
  }

  private request(method: string, params?: unknown) {
    const id = this.nextRequestId++;

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pendingRequests.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
      });

      try {
        this.sendMessage({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.pendingRequests.delete(id);
        rejectRequest(
          error instanceof Error ? error : new Error(getErrorText(error))
        );
      }
    });
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    action: string,
    onTimeout?: () => void
  ) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          // Ignore timeout cleanup failures and surface the original timeout.
        }
        reject(
          new Error(
            `MCP stdio ${action} timed out: ${this.server.id} (${timeoutMs}ms)`
          )
        );
      }, timeoutMs);

      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private resolveInitializeTimeoutMs() {
    if (typeof this.context.initializeTimeoutMs === "number") {
      return this.context.initializeTimeoutMs;
    }
    return isPackageBootstrapCommand(this.server)
      ? PACKAGE_MANAGER_BOOTSTRAP_TIMEOUT_MS
      : DEFAULT_INITIALIZE_TIMEOUT_MS;
  }

  private resolveDiscoveryTimeoutMs() {
    if (typeof this.context.discoveryTimeoutMs === "number") {
      return this.context.discoveryTimeoutMs;
    }
    return isPackageBootstrapCommand(this.server)
      ? PACKAGE_MANAGER_BOOTSTRAP_TIMEOUT_MS
      : DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  private async initializeWithCurrentFraming() {
    await this.ensureProcess();
    this.clearHealthError("unknown");

    let initialized = false;
    let lastError: unknown = null;
    for (const protocolVersion of PROTOCOL_VERSIONS) {
      this.setCurrentPhase("initialize");
      try {
        await this.withTimeout(
          this.request("initialize", {
            protocolVersion,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          }),
          this.resolveInitializeTimeoutMs(),
          "initialize",
          () => this.requestProcessKill("cyrene_timeout")
        );
        initialized = true;
        break;
      } catch (error) {
        lastError = error;
        if (getErrorText(error).includes("timed out")) {
          break;
        }
      }
    }

    if (!initialized) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`MCP stdio initialize failed: ${this.server.id}`);
    }

    this.setCurrentPhase("initialized");
    this.notify("notifications/initialized", {});

    try {
      this.setCurrentPhase("tools_list");
      const toolListResult = await this.withTimeout(
        this.request("tools/list", {}),
        this.resolveDiscoveryTimeoutMs(),
        "tools/list",
        () => this.requestProcessKill("cyrene_timeout")
      );
      const remoteTools = normalizeToolArray(toolListResult);
      if (remoteTools.length > 0) {
        this.descriptor.tools = buildRemoteToolDescriptors(this.server, remoteTools);
      }
    } catch (error) {
      const classified = this.classifyStdioError(error, "tools/list");
      this.setHealthError(
        classified.reason,
        classified.detail,
        classified.hint
      );
      if (this.descriptor.tools.length === 0) {
        throw error;
      }
    }

    this.setCurrentPhase("initialized");
    this.initialized = true;
    this.clearHealthError("online");
  }

  private async retryWithLegacyProtocolIfSupported(error: unknown) {
    const classified = this.classifyStdioError(error, "initialize");
    if (
      this.legacyProtocolFallbackAttempted ||
      this.framingMode === "newline" ||
      !isPackageBootstrapCommand(this.server) ||
      !this.shouldRetryWithLegacyProtocol(classified.reason)
    ) {
      throw error;
    }

    this.legacyProtocolFallbackAttempted = true;
    this.stdoutBuffer = Buffer.alloc(0);
    this.requestProcessKill("cyrene_retry");
    this.process = null;
    this.initialized = false;
    this.framingMode = "newline";
    this.directRetrySpawnTarget = await this.resolveDirectRetrySpawnTarget();
    await this.initializeWithCurrentFraming();
  }

  private notify(method: string, params?: unknown) {
    this.sendMessage({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private buildErrorResult(toolName: string, error: unknown): McpHandleResult {
    const classified = this.classifyStdioError(error, "request");
    this.setHealthError(
      classified.reason,
      classified.detail,
      classified.hint
    );
    return {
      ok: false,
      message: `[tool error] ${toolName}\n${classified.detail}`.trim(),
    };
  }

  async initialize() {
    if (!this.descriptor.enabled) {
      this.clearHealthError("offline");
      return;
    }
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        await this.initializeWithCurrentFraming();
      } catch (error) {
        try {
          await this.retryWithLegacyProtocolIfSupported(error);
        } catch (retryError) {
          const classified = this.classifyStdioError(retryError, "initialize");
          this.setHealthError(
            classified.reason,
            classified.detail,
            classified.hint
          );
          throw retryError;
        }
      }
    })()
      .catch(error => {
        if (this.descriptor.health !== "error") {
          const classified = this.classifyStdioError(error, "initialize");
          this.setHealthError(
            classified.reason,
            classified.detail,
            classified.hint
          );
        }
        throw error;
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  private findToolDescriptor(toolName: string) {
    const normalized = toolName.trim().toLowerCase();
    return this.descriptor.tools.find(
      tool => tool.name.trim().toLowerCase() === normalized
    );
  }

  private createPendingReview(toolName: string, input: unknown) {
    const descriptor = this.findToolDescriptor(toolName);
    const previewInputCompact = truncatePreview(stringifyPreviewInput(input, false), 240);
    const previewInputFull = truncatePreview(stringifyPreviewInput(input, true), 4_000);
    const id = crypto.randomUUID().slice(0, 8);
    const item: PendingReviewItem = {
      id,
      request: {
        action: toolName,
        path: this.server.id,
        input,
      } as PendingReviewItem["request"],
      preview: [
        "[remote tool review]",
        `server: ${this.server.id}`,
        `tool: ${toolName}`,
        `risk: ${descriptor?.risk ?? "low"}`,
        `input: ${previewInputCompact}`,
      ].join("\n"),
      previewSummary: [
        "[remote tool review]",
        `server: ${this.server.id}`,
        `tool: ${toolName}`,
        `risk: ${descriptor?.risk ?? "low"}`,
        `input: ${previewInputCompact}`,
      ].join("\n"),
      previewFull: [
        "[remote tool review]",
        `server: ${this.server.id}`,
        `tool: ${toolName}`,
        `risk: ${descriptor?.risk ?? "low"}`,
        "input:",
        previewInputFull,
      ].join("\n"),
      createdAt: new Date().toISOString(),
    };

    this.pendingReviews.set(id, {
      id,
      toolName,
      input,
      item,
    });
    return item;
  }

  private async executeRemoteToolCall(
    toolName: string,
    input: unknown
  ): Promise<McpHandleResult> {
    this.setCurrentPhase("request");
    const stderrStartIndex = this.stderrLines.length;
    try {
      const result = await this.request("tools/call", {
        name: toolName,
        arguments:
          input && typeof input === "object" && !Array.isArray(input)
            ? input
            : input === undefined
              ? {}
            : { value: input },
      });
      if (this.process) {
        this.setCurrentPhase("initialized");
      }
      this.clearHealthError("online");
      return this.formatRemoteToolResult(toolName, result, stderrStartIndex);
    } catch (error) {
      if (this.process) {
        this.setCurrentPhase("initialized");
      }
      this.descriptor.health = "error";
      return this.buildErrorResult(toolName, error);
    }
  }

  async handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult> {
    if (!this.descriptor.enabled) {
      return {
        ok: false,
        message: `MCP server disabled: ${this.server.id}`,
      };
    }

    try {
      await this.initialize();
      if (this.findToolDescriptor(toolName)?.requiresReview) {
        const pending = this.createPendingReview(toolName, input);
        return {
          ok: true,
          message: `[review required] ${pending.id}\n${pending.previewSummary}`,
          pending,
        };
      }
      return await this.executeRemoteToolCall(toolName, input);
    } catch (error) {
      this.descriptor.health = "error";
      return this.buildErrorResult(toolName, error);
    }
  }

  listPending() {
    return [...this.pendingReviews.values()]
      .map(entry => entry.item)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async approve(id: string) {
    const pending = this.pendingReviews.get(id);
    if (!pending) {
      return {
        ok: false,
        message: `Pending operation not found: ${id}`,
      };
    }

    const result = await this.executeRemoteToolCall(pending.toolName, pending.input);
    if (!result.ok) {
      return {
        ok: false,
        message: `[approve failed] ${id}\n${extractResultBody(result.message)}`,
      };
    }

    this.pendingReviews.delete(id);
    return {
      ok: true,
      message: `[approved] ${id}\n${extractResultBody(result.message)}`,
    };
  }

  reject(id: string) {
    const pending = this.pendingReviews.get(id);
    if (!pending) {
      return {
        ok: false,
        message: `Pending operation not found: ${id}`,
      };
    }

    this.pendingReviews.delete(id);
    return {
      ok: true,
      message: `[rejected] ${id}\n${pending.toolName}`,
    };
  }

  async undoLastMutation() {
    return {
      ok: false,
      message: `Undo unsupported for MCP server: ${this.server.id}`,
    };
  }

  dispose() {
    this.initialized = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pendingReviews.clear();
    this.setCurrentPhase("unknown");
    if (this.process) {
      this.requestProcessKill("cyrene_shutdown");
      this.process = null;
    }
  }
}
