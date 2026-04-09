#!/usr/bin/env node

const TOOL_NAME = "show_time";
const SERVER_INFO = {
  name: "time-mcp",
  version: "0.1.0",
};

let inputBuffer = Buffer.alloc(0);
let shuttingDown = false;

const writeMessage = message => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    ...message,
  });
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`,
    "utf8"
  );
};

const buildTimeText = (args = {}) => {
  const now = new Date();
  const timeZone =
    typeof args.timezone === "string" && args.timezone.trim()
      ? args.timezone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const locale =
    typeof args.locale === "string" && args.locale.trim()
      ? args.locale.trim()
      : "zh-CN";

  let localized = "";
  try {
    localized = new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "long",
      timeZone,
    }).format(now);
  } catch {
    localized = now.toLocaleString();
  }

  return [
    "Current time",
    `ISO: ${now.toISOString()}`,
    `Timezone: ${timeZone}`,
    `Local: ${localized}`,
  ].join("\n");
};

const handleRequest = request => {
  switch (request.method) {
    case "initialize":
      writeMessage({
        id: request.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      writeMessage({
        id: request.id,
        result: {
          tools: [
            {
              name: TOOL_NAME,
              description: "Show the current time on the MCP server host.",
              inputSchema: {
                type: "object",
                properties: {
                  timezone: {
                    type: "string",
                    description: "Optional IANA timezone, e.g. Asia/Shanghai.",
                  },
                  locale: {
                    type: "string",
                    description: "Optional locale, e.g. zh-CN or en-US.",
                  },
                },
              },
            },
          ],
        },
      });
      return;
    case "tools/call": {
      const toolName = request.params?.name;
      if (toolName !== TOOL_NAME) {
        writeMessage({
          id: request.id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown tool: ${String(toolName ?? "")}`,
              },
            ],
          },
        });
        return;
      }
      writeMessage({
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: buildTimeText(request.params?.arguments),
            },
          ],
        },
      });
      return;
    }
    case "shutdown":
      shuttingDown = true;
      writeMessage({
        id: request.id,
        result: {},
      });
      return;
    case "exit":
      process.exit(0);
    default:
      writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${String(request.method ?? "")}`,
        },
      });
  }
};

const pumpInput = () => {
  while (inputBuffer.length > 0) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const header = inputBuffer.slice(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      inputBuffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number(match[1] ?? "0");
    const payloadStart = headerEnd + 4;
    const payloadEnd = payloadStart + contentLength;
    if (inputBuffer.length < payloadEnd) {
      return;
    }
    const payload = inputBuffer.slice(payloadStart, payloadEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(payloadEnd);
    try {
      handleRequest(JSON.parse(payload));
    } catch (error) {
      writeMessage({
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
};

process.stdin.on("data", chunk => {
  inputBuffer = Buffer.concat([
    inputBuffer,
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
  ]);
  pumpInput();
});

process.stdin.on("end", () => {
  if (shuttingDown) {
    process.exit(0);
  }
});

