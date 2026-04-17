import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { McpConfiguredServer } from "../../loadMcpConfig";
import type {
  McpHandleResult,
  McpServerAdapter,
  McpServerDescriptor,
} from "../../runtimeTypes";
import type { PendingReviewItem } from "../../toolTypes";
import {
  buildRemoteToolDescriptors,
  formatRemoteToolCallResult,
  type RemoteMcpTool,
} from "../remote/mcpRemoteProtocol";
import { buildRestrictedSubprocessEnvFromBase } from "../filesystem/subprocessEnv";

type StdioMcpAdapterContext = {
  appRoot: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
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

const CLIENT_INFO = {
  name: "cyrene-code",
  version: "0.1.3",
};

const PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05", "2024-10-07"];

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
    }
  }

  private async ensureProcess() {
    if (this.process) {
      return this.process;
    }

    if (!this.server.command) {
      throw new Error(`MCP stdio server missing command: ${this.server.id}`);
    }

    const child = (this.context.spawnProcess ?? spawn)(
      resolveCommandPath(this.context.appRoot, this.server.command),
      this.server.args ?? [],
      {
        cwd: resolveServerCwd(this.context.appRoot, this.server.cwd),
        env: buildRestrictedSubprocessEnvFromBase(
          this.context.env,
          this.server.env
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
      this.descriptor.health = "error";
      this.rejectAllPending(error);
    });
    child.on("exit", (code, signal) => {
      this.process = null;
      this.initialized = false;
      if (!this.descriptor.enabled) {
        this.descriptor.health = "offline";
        return;
      }
      this.descriptor.health = "error";
      this.rejectAllPending(
        new Error(
          `MCP stdio server exited: ${this.server.id} (${code ?? "null"}${signal ? `, ${signal}` : ""})`
        )
      );
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
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
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

  private notify(method: string, params?: unknown) {
    this.sendMessage({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private buildErrorResult(toolName: string, error: unknown): McpHandleResult {
    const detail = [getErrorText(error), ...this.stderrLines.slice(-3)]
      .filter(Boolean)
      .join("\n");
    return {
      ok: false,
      message: `[tool error] ${toolName}\n${detail}`.trim(),
    };
  }

  async initialize() {
    if (!this.descriptor.enabled) {
      this.descriptor.health = "offline";
      return;
    }
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      await this.ensureProcess();

      let initialized = false;
      let lastError: unknown = null;
      for (const protocolVersion of PROTOCOL_VERSIONS) {
        try {
          await this.request("initialize", {
            protocolVersion,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          });
          initialized = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!initialized) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`MCP stdio initialize failed: ${this.server.id}`);
      }

      this.notify("notifications/initialized", {});

      try {
        const toolListResult = await this.request("tools/list", {});
        const remoteTools = normalizeToolArray(toolListResult);
        if (remoteTools.length > 0) {
          this.descriptor.tools = buildRemoteToolDescriptors(this.server, remoteTools);
        }
      } catch (error) {
        if (this.descriptor.tools.length === 0) {
          throw error;
        }
      }

      this.initialized = true;
      this.descriptor.health = "online";
    })()
      .catch(error => {
        this.descriptor.health = "error";
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
      this.descriptor.health = "online";
      return formatRemoteToolCallResult(toolName, result);
    } catch (error) {
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
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
