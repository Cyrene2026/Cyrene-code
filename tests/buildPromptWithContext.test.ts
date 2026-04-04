import { describe, expect, test } from "bun:test";
import { buildPromptWithContext } from "../src/core/session/buildPromptWithContext";

describe("buildPromptWithContext", () => {
  test("prioritizes working state and clips large transcript tail lines", () => {
    const prompt = buildPromptWithContext("continue the oauth task", "system", "project", {
      pins: ["Preserve approval UX polish"],
      relevantMemories: [
        "[tool_result] write_file src/app.ts | Wrote file: src/app.ts",
      ],
      archiveSections: {
        COMPLETED: ["[tool_result] write_file src/app.ts | Wrote file: src/app.ts"],
        "KNOWN PATHS": ["src/app.ts"],
      },
      recent: [
        {
          role: "user",
          text: "a".repeat(500),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          role: "assistant",
          text: "b".repeat(500),
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      summaryFallback: [
        "OBJECTIVE:",
        "- finish oauth follow-up",
        "",
        "COMPLETED:",
        "- wrote src/app.ts",
        "",
        "REMAINING:",
        "- verify approval flow",
      ].join("\n"),
    });

    expect(prompt).toContain("TASK STATE CONTEXT:");
    expect(prompt).toContain("Working state (durable reducer):");
    expect(prompt).toContain("OBJECTIVE:\n- finish oauth follow-up");
    expect(prompt).toContain("CONFIRMED FACTS:\n(none)");
    expect(prompt).toContain("Pinned memory (stable user priorities):\n- Preserve approval UX polish");
    expect(prompt).toContain("Retrieved archive memory (section-aware):");
    expect(prompt).toContain("COMPLETED:\n- [tool_result] write_file src/app.ts | Wrote file: src/app.ts");
    expect(prompt).toContain("KNOWN PATHS:\n- src/app.ts");
    expect(prompt).toContain("Short transcript tail (immediate recency only):");
    expect(prompt).not.toContain("a".repeat(300));
    expect(prompt).not.toContain("b".repeat(300));
    expect(prompt.indexOf("Working state (durable reducer):")).toBeLessThan(
      prompt.indexOf("Short transcript tail (immediate recency only):")
    );
  });

  test("wraps legacy summaries without pretending they are structured state", () => {
    const prompt = buildPromptWithContext("continue", "system", "project", {
      pins: [],
      relevantMemories: [],
      recent: [],
      summaryFallback:
        "- task: continue oauth work\n- fact: api behavior confirmed",
    });

    expect(prompt).toContain(
      "LEGACY SUMMARY (older format; treat this as partial state and refine completed/remaining items from newer evidence when needed):"
    );
    expect(prompt).toContain("- task: continue oauth work");
    expect(prompt).toContain("- fact: api behavior confirmed");
  });
});
