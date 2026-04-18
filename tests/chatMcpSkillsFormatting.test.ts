import { describe, expect, test } from "bun:test";
import { formatMcpServerDetail } from "../src/application/chat/chatMcpSkillsFormatting";

describe("chatMcpSkillsFormatting", () => {
  test("includes MCP health diagnostics in server detail output", () => {
    const text = formatMcpServerDetail({
      id: "ddg-search",
      label: "ddg-search",
      enabled: true,
      source: "local",
      health: "error",
      healthReason: "invalid_protocol_output",
      healthDetail: "Invalid MCP stdio JSON from ddg-search",
      healthExitPhase: "tools_list",
      healthExitCode: null,
      healthExitSignal: "SIGTERM",
      healthExitSource: "cyrene_timeout",
      healthHint: "stdout did not contain MCP JSON-RPC frames",
      transport: "stdio",
      aliases: [],
      exposure: "hinted",
      tags: [],
      tools: [],
    });

    expect(text).toContain("health: error");
    expect(text).toContain("health_reason: invalid protocol output");
    expect(text).toContain("health_detail: Invalid MCP stdio JSON from ddg-search");
    expect(text).toContain("health_exit_phase: tools list");
    expect(text).toContain("health_exit_code: null");
    expect(text).toContain("health_exit_signal: SIGTERM");
    expect(text).toContain("health_exit_source: cyrene timeout");
    expect(text).toContain("health_hint: stdout did not contain MCP JSON-RPC frames");
  });
});
