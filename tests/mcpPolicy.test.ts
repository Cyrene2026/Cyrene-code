import { describe, expect, test } from "bun:test";
import {
  buildMcpPolicyDecision,
  getMcpToolCapabilities,
  getMcpToolRisk,
} from "../src/core/mcp";

describe("McpPolicy", () => {
  test("classifies read/search/git capabilities", () => {
    expect(getMcpToolCapabilities("search_text_context")).toEqual(
      expect.arrayContaining(["read", "search"])
    );
    expect(getMcpToolCapabilities("git_diff")).toEqual(
      expect.arrayContaining(["read", "git"])
    );
  });

  test("classifies write and shell risks", () => {
    expect(getMcpToolCapabilities("write_file")).toEqual(
      expect.arrayContaining(["write", "review"])
    );
    expect(getMcpToolRisk("write_file")).toBe("medium");
    expect(getMcpToolRisk("run_shell")).toBe("high");
    expect(getMcpToolRisk("read_file")).toBe("low");
  });

  test("builds policy decisions with review state", () => {
    expect(
      buildMcpPolicyDecision(
        { action: "run_command", path: ".", command: "bun", args: ["test"] },
        true
      )
    ).toEqual({
      allowed: true,
      requiresReview: true,
      risk: "medium",
    });
  });
});
