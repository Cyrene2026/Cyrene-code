import { describe, expect, test } from "bun:test";
import { formatReadToolResultDisplay } from "../src/frontend/components/v2/toolResultFormatting";

describe("toolResultFormatting", () => {
  test("summarizes read_files without exposing file bodies", () => {
    const result = formatReadToolResultDisplay(
      "read_files a.txt",
      ["[file] a.txt", "alpha", "", "[file] b.txt", "beta"].join("\n")
    );

    expect(result).toContain("a.txt, b.txt");
    expect(result).toContain("2 files");
    expect(result).not.toContain("alpha");
    expect(result).not.toContain("beta");
  });

  test("hides read_file body content", () => {
    const result = formatReadToolResultDisplay(
      "read_file src/main.ts",
      "export const secret = 1;\n"
    );

    expect(result).toBe("content hidden");
  });

  test("summarizes search_text_context matches without inline context", () => {
    const result = formatReadToolResultDisplay(
      "search_text_context docs",
      [
        "Text hits with context: 2",
        "[text] docs/a.txt:4",
        "3 | alpha",
        ">    4 | needle",
        "5 | omega",
        "",
        "[text] docs/b.txt:9",
        "8 | before",
        ">    9 | needle again",
      ].join("\n")
    );

    expect(result).toContain("docs/a.txt:4, docs/b.txt:9");
    expect(result).toContain("2 text hits with context");
    expect(result).not.toContain("needle again");
  });
});
