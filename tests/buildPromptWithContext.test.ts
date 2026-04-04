import { describe, expect, test } from "bun:test";
import { buildPromptWithContext } from "../src/core/session/buildPromptWithContext";
import { CYRENE_STATE_UPDATE_START_TAG } from "../src/core/session/stateReducer";

describe("buildPromptWithContext", () => {
  test("prioritizes durable state, pending digest, and archive retrieval ahead of transcript tail", () => {
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
      durableSummary: [
        "OBJECTIVE:",
        "- finish oauth follow-up",
        "",
        "CONFIRMED FACTS:",
        "- api behavior confirmed",
      ].join("\n"),
      pendingDigest: [
        "COMPLETED:",
        "- wrote src/app.ts",
        "",
        "REMAINING:",
        "- verify approval flow",
      ].join("\n"),
      summaryFallback: "",
      reducerMode: "merge_and_digest",
      summaryRecoveryNeeded: false,
      interruptedTurn: null,
    });

    expect(prompt).toContain("TASK STATE CONTEXT:");
    expect(prompt).toContain("Working state (durable reducer):");
    expect(prompt).toContain("OBJECTIVE:\n- finish oauth follow-up");
    expect(prompt).toContain("Pending turn digest (last completed turn not yet merged):");
    expect(prompt).toContain("COMPLETED:\n- wrote src/app.ts");
    expect(prompt).toContain(
      "Pinned memory (stable user priorities):\n- Preserve approval UX polish"
    );
    expect(prompt).toContain("Retrieved archive memory (section-aware):");
    expect(prompt).toContain(
      "COMPLETED:\n- [tool_result] write_file src/app.ts | Wrote file: src/app.ts"
    );
    expect(prompt).toContain("KNOWN PATHS:\n- src/app.ts");
    expect(prompt).toContain("Short transcript tail (immediate recency only):");
    expect(prompt).not.toContain("a".repeat(300));
    expect(prompt).not.toContain("b".repeat(300));
    expect(prompt).toContain("STATE REDUCER PROTOCOL:");
    expect(prompt).toContain(CYRENE_STATE_UPDATE_START_TAG);
    expect(prompt.indexOf("Working state (durable reducer):")).toBeLessThan(
      prompt.indexOf("Short transcript tail (immediate recency only):")
    );
  });

  test("includes recovery aids and interrupted turn snapshot when durable summary is missing", () => {
    const prompt = buildPromptWithContext("continue", "system", "project", {
      pins: [],
      relevantMemories: [],
      recent: [],
      durableSummary: "",
      pendingDigest: "",
      summaryFallback: [
        "OBJECTIVE:",
        "- continue oauth work",
        "",
        "REMAINING:",
        "- verify approval flow",
      ].join("\n"),
      reducerMode: "full_rebuild_and_digest",
      summaryRecoveryNeeded: true,
      interruptedTurn: {
        userText: "continue oauth",
        assistantText: "partial answer before exit",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
      },
    });

    expect(prompt).toContain("Working state (durable reducer):\n(missing)");
    expect(prompt).toContain("Pending turn digest (last completed turn not yet merged):\n(none)");
    expect(prompt).toContain("Local fallback state estimate (non-durable recovery aid):");
    expect(prompt).toContain("OBJECTIVE:\n- continue oauth work");
    expect(prompt).toContain("Interrupted prior turn snapshot:");
    expect(prompt).toContain("- user: continue oauth");
    expect(prompt).toContain("- partial assistant: partial answer before exit");
    expect(prompt).toContain("- status: interrupted before reducer finalized");
    expect(prompt).toContain(
      "Current reducer mode: full_rebuild_and_digest. Rebuild the durable summary from prior evidence before the current user turn, then produce nextPendingDigest for the current turn."
    );
  });
});
