import { describe, expect, test } from "bun:test";
import {
  normalizeMcpMessage,
  summarizeToolMessage,
} from "../src/application/chat/toolMessageSummary";

describe("toolMessageSummary", () => {
  test("summarizes file mutations with full diff lines", () => {
    const result = summarizeToolMessage(
      [
        "[tool result] create_file test_files/u4.py",
        "Created file: test_files/u4.py",
        "[confirmed file mutation] create_file test_files/u4.py",
        "postcondition: file now exists and content was written successfully",
        "diff_stats: +1 -0",
        "[diff preview]",
        "+    1 | print('ok')",
        "+    2 | print('still ok')",
      ].join("\n")
    );

    expect(result.kind).toBe("tool_status");
    expect(result.tone).toBe("info");
    expect(result.text).toContain(
      "Tool: create_file test_files/u4.py | Created file: test_files/u4.py | +1 -0"
    );
    expect(result.text).toContain("+    1 | print('ok')");
    expect(result.text).toContain("+    2 | print('still ok')");
  });

  test("summarizes file mutations with masked diff preview lines", () => {
    const result = summarizeToolMessage(
      [
        "[tool result] write_file simplex.py",
        "Wrote file: simplex.py",
        "[confirmed file mutation] write_file simplex.py",
        "postcondition: file content was overwritten successfully",
        "diff_stats: +32 -16",
        "[diff preview]",
        "+***",
        "-***",
        "diff_preview_omitted: 12",
      ].join("\n")
    );

    expect(result.kind).toBe("tool_status");
    expect(result.text).toContain(
      "Tool: write_file simplex.py | Wrote file: simplex.py | +32 -16"
    );
    expect(result.text).toContain("+***");
    expect(result.text).toContain("-***");
    expect(result.text).toContain("... 12 more changed line(s)");
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
        "[confirmed directory state] .",
        "[D] .cyrene",
        "[D] test_files",
        "[F] package.json",
        "[F] README.md",
        "[F] bun.lock",
      ].join("\n")
    );

    expect(result.text).toContain("Tool: list_dir . |");
    expect(result.text).toContain("confirmed directory state");
    expect(result.text).toContain("[D] .cyrene");
    expect(result.text).toContain("[D] test_files");
    expect(result.text).toContain("5 items");
    expect(result.text).toContain("+1 more");
  });

  test("summarizes empty read_file explicitly", () => {
    const result = summarizeToolMessage(
      ["[tool result] read_file test_files/u5.py", "(empty file)"].join("\n")
    );

    expect(result.text).toBe("Tool: read_file test_files/u5.py | (empty file)");
  });

  test("summarizes read_files without leaking raw multi-file body structure", () => {
    const result = summarizeToolMessage(
      [
        "[tool result] read_files a.txt",
        "[file] a.txt",
        "alpha",
        "",
        "[file] b.txt",
        "beta",
      ].join("\n")
    );

    expect(result.text).toContain("Tool: read_files a.txt |");
    expect(result.text).toContain("[file] a.txt");
    expect(result.text).toContain("[file] b.txt");
    expect(result.text).toContain("2 files");
    expect(result.text).not.toContain("alpha");
    expect(result.text).not.toContain("beta");
  });

  test("preserves approved terminal transcript bodies for shell actions", () => {
    const raw = [
      "[approved] shell-1",
      "status: completed",
      "shell: pwsh",
      "cwd: .",
      "input: python --version",
      "last_exit: 0",
      "output:",
      "$ python --version",
      "Python 3.12.0",
    ].join("\n");

    const result = summarizeToolMessage(raw);

    expect(result.kind).toBe("review_status");
    expect(result.text).toBe(
      [
        "Approved shell-1",
        "status: completed",
        "shell: pwsh",
        "cwd: .",
        "input: python --version",
        "last_exit: 0",
        "output:",
        "$ python --version",
        "Python 3.12.0",
      ].join("\n")
    );
  });
});
