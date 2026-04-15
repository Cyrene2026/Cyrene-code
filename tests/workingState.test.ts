import { describe, expect, test } from "bun:test";
import {
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
    expect(normalized).toContain("CONSTRAINTS:\n(none)");
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
});
