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

type HttpMcpAdapterContext = {
  appRoot: string;
  validateRequestUrl?: () => Promise<string | null>;
  initializeTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type JsonRpcErrorShape = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse = {
  result?: unknown;
  error?: JsonRpcErrorShape;
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
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

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

export class HttpMcpAdapter implements McpServerAdapter {
  descriptor: McpServerDescriptor;

  private nextRequestId = 1;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly pendingReviews = new Map<string, PendingRemoteReview>();

  constructor(
    private readonly server: McpConfiguredServer,
    private readonly _context: HttpMcpAdapterContext
  ) {
    this.descriptor = {
      id: server.id,
      label: server.label,
      enabled: server.enabled,
      source: "remote",
      health: server.enabled ? "unknown" : "offline",
      transport: "http",
      aliases: [...server.aliases],
      exposure: server.exposure ?? "hinted",
      tags: [...(server.tags ?? [])],
      hint: server.hint,
      tools: buildRemoteToolDescriptors(server, []),
    };
  }

  private async postJsonRpc(
    method: string,
    params?: unknown,
    notification = false,
    timeoutMs?: number
  ) {
    if (!this.server.url) {
      throw new Error(`MCP http server missing url: ${this.server.id}`);
    }
    const requestUrlError = await this._context.validateRequestUrl?.();
    if (requestUrlError) {
      throw new Error(requestUrlError);
    }

    const requestId = notification ? undefined : this.nextRequestId++;
    const normalizedHeaders = this.server.headers
      ? Object.fromEntries(
          Object.entries(this.server.headers).map(([key, value]) => [key, value])
        )
      : {};
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = timeoutMs
      ? setTimeout(() => controller?.abort(), timeoutMs)
      : undefined;
    let response: Response;
    try {
      response = await (this._context.fetchImpl ?? fetch)(this.server.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...normalizedHeaders,
          "content-type": "application/json",
          accept: "application/json",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(requestId === undefined ? {} : { id: requestId }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError" && timeoutMs) {
        throw new Error(
          `MCP http ${method} timed out: ${this.server.id} (${timeoutMs}ms)`
        );
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        [
          `MCP http ${method} blocked: redirects are not allowed`,
          `server: ${this.server.id}`,
          `url: ${this.server.url}`,
          response.headers.get("location")
            ? `location: ${response.headers.get("location")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (!response.ok) {
      throw new Error(
        `MCP http ${method} failed: ${response.status} ${response.statusText}`
      );
    }

    if (notification || response.status === 204) {
      return undefined;
    }

    const text = await response.text();
    if (!text.trim()) {
      return undefined;
    }

    const payload = JSON.parse(text) as JsonRpcResponse;
    if (payload.error) {
      throw new Error(
        payload.error.message ?? `MCP http request failed: ${this.server.id}`
      );
    }
    return payload.result;
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
      let initialized = false;
      let lastError: unknown = null;

      for (const protocolVersion of PROTOCOL_VERSIONS) {
        try {
          await this.postJsonRpc(
            "initialize",
            {
              protocolVersion,
              capabilities: {},
              clientInfo: CLIENT_INFO,
            },
            false,
            this._context.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
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
          : new Error(`MCP http initialize failed: ${this.server.id}`);
      }

      await this.postJsonRpc("notifications/initialized", {}, true);

      try {
        const toolListResult = await this.postJsonRpc(
          "tools/list",
          {},
          false,
          this._context.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
        );
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
      const result = await this.postJsonRpc("tools/call", {
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
      return {
        ok: false,
        message: `[tool error] ${toolName}\n${getErrorText(error)}`.trim(),
      };
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
      return {
        ok: false,
        message: `[tool error] ${toolName}\n${getErrorText(error)}`.trim(),
      };
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
    this.sessionId = null;
    this.pendingReviews.clear();
  }
}
