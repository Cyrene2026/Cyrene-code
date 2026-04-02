import { describe, expect, test } from "bun:test";
import {
  normalizeMcpMessage,
  summarizeToolMessage,
} from "../src/application/chat/toolMessageSummary";

describe("toolMessageSummary", () => {
  test("summarizes tool result to a single readable line", () => {
    const result = summarizeToolMessage(
      "[tool result] create_file test_files/u4.py\nCreated file: test_files/u4.py"
    );

    expect(result.kind).toBe("tool_status");
    expect(result.tone).toBe("info");
    expect(result.text).toBe(
      "Tool: create_file test_files/u4.py | Created file: test_files/u4.py"
    );
  });

  test("summarizes tool error to a single readable line", () => {
    const result = summarizeToolMessage(
      "[tool error] create_file test_files/u4.py\nEEXIST: file already exists"
    );

    expect(result.kind).toBe("error");
    expect(result.text).toBe(
      "Tool error: create_file test_files/u4.py | EEXIST: file already exists"
    );
  });

  test("summarizes approve failed into approval error", () => {
    const result = summarizeToolMessage(
      "[approve failed] b1c22379\nEEXIST: file already exists"
    );

    expect(result.kind).toBe("error");
    expect(result.text).toBe(
      "Approval error: b1c22379 | EEXIST: file already exists"
    );
  });

  test("normalize handles rejected status", () => {
    const result = normalizeMcpMessage("[rejected] abc123");

    expect(result.kind).toBe("review_status");
    expect(result.tone).toBe("warning");
    expect(result.text).toBe("Rejected abc123");
  });

  test("summarizes list_dir with visible entries and total count", () => {
    const result = summarizeToolMessage(
      [
        "[tool result] list_dir .",
        "[D] .cyrene",
        "[D] test_files",
        "[F] package.json",
        "[F] README.md",
        "[F] bun.lock",
      ].join("\n")
    );

    expect(result.text).toContain("Tool: list_dir . |");
    expect(result.text).toContain("[D] .cyrene");
    expect(result.text).toContain("[D] test_files");
    expect(result.text).toContain("5 items");
    expect(result.text).toContain("+1 more");
  });
});
