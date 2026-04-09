import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { StdioMcpAdapter } from "../src/core/mcp";

describe("time MCP server", () => {
  test("can be initialized and called over stdio", async () => {
    const adapter = new StdioMcpAdapter(
      {
        id: "time",
        transport: "stdio",
        label: "Time",
        enabled: true,
        aliases: ["clock"],
        command: process.execPath,
        args: [resolve("scripts/time-mcp-server.mjs")],
        tools: [],
      },
      {
        appRoot: process.cwd(),
      }
    );

    await adapter.initialize();

    expect(adapter.descriptor.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "show_time",
        }),
      ])
    );

    const result = await adapter.handleToolCall("show_time", {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("[tool result] show_time");
    expect(result.message).toContain("Current time");
    expect(result.message).toContain("Timezone: Asia/Shanghai");
    expect(result.message).toContain("ISO:");

    adapter.dispose();
  });
});

