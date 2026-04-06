import type { McpConfiguredServer } from "../../loadMcpConfig";
import type {
  McpHandleResult,
  McpServerAdapter,
  McpServerDescriptor,
} from "../../runtimeTypes";
import {
  buildRemoteToolDescriptors,
  formatRemoteToolCallResult,
  type RemoteMcpTool,
} from "../remote/mcpRemoteProtocol";

type HttpMcpAdapterContext = {
  appRoot: string;
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

const CLIENT_INFO = {
  name: "cyrene-code",
  version: "0.1.3",
};

const PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05", "2024-10-07"];

const getErrorText = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : String(error);
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

export class HttpMcpAdapter implements McpServerAdapter {
  descriptor: McpServerDescriptor;

  private nextRequestId = 1;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

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
      tools: buildRemoteToolDescriptors(server, []),
    };
  }

  private async postJsonRpc(
    method: string,
    params?: unknown,
    notification = false
  ) {
    if (!this.server.url) {
      throw new Error(`MCP http server missing url: ${this.server.id}`);
    }

    const requestId = notification ? undefined : this.nextRequestId++;
    const response = await fetch(this.server.url, {
      method: "POST",
      headers: {
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
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
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
          await this.postJsonRpc("initialize", {
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
          : new Error(`MCP http initialize failed: ${this.server.id}`);
      }

      await this.postJsonRpc("notifications/initialized", {}, true);

      try {
        const toolListResult = await this.postJsonRpc("tools/list", {});
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

  async handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult> {
    if (!this.descriptor.enabled) {
      return {
        ok: false,
        message: `MCP server disabled: ${this.server.id}`,
      };
    }

    try {
      await this.initialize();
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

  listPending() {
    return [];
  }

  async approve(id: string) {
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  reject(id: string) {
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
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
  }
}
