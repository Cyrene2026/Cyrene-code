import { describe, expect, test } from "bun:test";
import {
  formatWorkingStateEntryForPrompt,
  parseWorkingStateEntry,
  normalizeWorkingStateSummary,
  parseWorkingStateSummary,
  repairWorkingStateSummary,
  WORKING_STATE_SECTION_ORDER,
} from "../src/core/session/workingState";

describe("workingState", () => {
  test("treats headings-only input as an empty structured summary instead of legacy", () => {
    const input = ["OBJECTIVE:", "CONFIRMED FACTS:", "CONSTRAINTS:"].join("\n");

    const parsed = parseWorkingStateSummary(input);
    const normalized = normalizeWorkingStateSummary(input);

    expect(Object.keys(parsed)).toHaveLength(WORKING_STATE_SECTION_ORDER.length);
    for (const section of WORKING_STATE_SECTION_ORDER) {
      expect(parsed[section]).toEqual([]);
    }
    expect(normalized).not.toContain("LEGACY SUMMARY");
    expect(normalized).toContain("OBJECTIVE:\n(none)");
    expect(normalized).toContain("CONFIRMED FACTS:\n(none)");
    expect(normalized).toContain("ASSUMPTIONS:\n(none)");
    expect(normalized).toContain("CONSTRAINTS:\n(none)");
    expect(normalized).toContain("DECISIONS:\n(none)");
    expect(normalized).toContain("ENTITY STATE:\n(none)");
    expect(normalized).toContain("STALE OR CONFLICTING:\n(none)");
  });

  test("does not silently drop orphan lines when free text is mixed with empty headings", () => {
    const input = ["orphan line", "OBJECTIVE:"].join("\n");

    const normalized = normalizeWorkingStateSummary(input);

    expect(normalized).toContain("LEGACY SUMMARY");
    expect(normalized).toContain("- orphan line");
  });

  test("preserves structured fallback sections when repairing a headings-only summary", () => {
    const repaired = repairWorkingStateSummary(
      ["OBJECTIVE:", "CONFIRMED FACTS:"].join("\n"),
      ["REMAINING:", "- do x", "", "KNOWN PATHS:", "- src/app.ts"].join("\n")
    );

    expect(repaired).toContain("OBJECTIVE:\n- (none)");
    expect(repaired).toContain("CONFIRMED FACTS:\n- (none)");
    expect(repaired).toContain("REMAINING:\n- do x");
    expect(repaired).toContain("KNOWN PATHS:\n- src/app.ts");
    expect(repaired).not.toContain("OBJECTIVE:\n- do x");
    expect(repaired).not.toContain("CONFIRMED FACTS:\n- do x");
  });

  test("parses source refs attached to working-state entries", () => {
    const parsed = parseWorkingStateSummary(
      [
        "CONFIRMED FACTS:",
        '- 目标文件是 `src/app.ts`',
        '  refs: [{"kind":"tool_result","label":"read_range","path":"src/app.ts","startLine":41,"endLine":80}]',
      ].join("\n")
    );

    const first = parsed["CONFIRMED FACTS"]?.[0] ?? "";
    const entry = parseWorkingStateEntry(first);

    expect(entry.text).toBe("目标文件是 `src/app.ts`");
    expect(entry.sourceRefs).toEqual([
      {
        kind: "tool_result",
        label: "read_range",
        path: "src/app.ts",
        startLine: 41,
        endLine: 80,
      },
    ]);
    expect(formatWorkingStateEntryForPrompt(first)).toContain(
      "[refs: tool_result read_range src/app.ts#L41-L80]"
    );
  });
});
