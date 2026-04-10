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
      latestActionableUserMessage: "finish the oauth follow-up without reopening old files",
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
    expect(prompt).toContain(
      "Hard rules: never write planner chatter such as 我来 / 我先 / 让我 / 再看一下 / let me / I'll."
    );
    expect(prompt).toContain(
      "Hard rules: CONFIRMED FACTS must be complete factual statements."
    );
    expect(prompt).toContain(
      "Hard rules: CONFIRMED FACTS may include confirmed negative facts such as missing files"
    );
    expect(prompt).toContain(
      "Hard rules: COMPLETED and REMAINING must stay mutually exclusive."
    );
    expect(prompt.indexOf("Working state (durable reducer):")).toBeLessThan(
      prompt.indexOf("Short transcript tail (immediate recency only):")
    );
  });

  test("includes recovery aids and interrupted turn snapshot when durable summary is missing", () => {
    const prompt = buildPromptWithContext("continue", "system", "project", {
      pins: [],
      relevantMemories: [],
      recent: [
        {
          role: "assistant",
          text: "latest unresolved branch is docs polish",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      latestActionableUserMessage: "continue oauth",
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
    expect(prompt).toContain(
      "The current user query is low-information. Continue from the most recent unresolved context first"
    );
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

  test("low-information continuation queries prioritize pending digest and recent context ahead of durable summary", () => {
    const prompt = buildPromptWithContext("继续", "system", "project", {
      pins: [],
      relevantMemories: [],
      recent: [
        {
          role: "assistant",
          text: "latest active thread is the LSP rename flow, not the earlier billing cleanup",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      latestActionableUserMessage:
        "完善下 lsp doctor/list 的一致性和可诊断性，再继续补 rename 相关能力",
      durableSummary: [
        "OBJECTIVE:",
        "- finish billing cleanup",
        "",
        "REMAINING:",
        "- verify usage totals",
      ].join("\n"),
      pendingDigest: [
        "OBJECTIVE:",
        "- continue the LSP rename flow",
        "",
        "REMAINING:",
        "- verify rename preview",
      ].join("\n"),
      summaryFallback: "",
      reducerMode: "merge_and_digest",
      summaryRecoveryNeeded: false,
      interruptedTurn: null,
    });

    expect(prompt).toContain(
      "The current user query is low-information. Continue from the most recent unresolved context first"
    );
    expect(prompt).toContain("OBJECTIVE:\n- continue the LSP rename flow");
    expect(prompt).toContain("latest active thread is the LSP rename flow");
    expect(prompt.indexOf("Pending turn digest (last completed turn not yet merged):")).toBeLessThan(
      prompt.indexOf("Working state (durable reducer):")
    );
    expect(prompt.indexOf("Short transcript tail (immediate recency only):")).toBeLessThan(
      prompt.indexOf("Working state (durable reducer):")
    );
    expect(prompt).toContain("Latest actionable user request before this continuation:");
    expect(prompt).toContain("完善下 lsp doctor/list 的一致性和可诊断性");
  });
});
