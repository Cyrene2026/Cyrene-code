import { describe, expect, test } from "bun:test";
import { buildPromptWithContext } from "../src/core/session/buildPromptWithContext";
import { CYRENE_PLAN_START_TAG } from "../src/core/session/executionPlan";
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
      executionPlan: {
        capturedAt: "2026-01-01T00:00:00.000Z",
        sourcePreview: "finish oauth follow-up",
        projectRoot: "/workspace/oauth",
        summary: "Close the oauth follow-up cleanly",
        objective: "finish oauth follow-up",
        acceptedAt: "",
        acceptedSummary: "",
        steps: [
          {
            id: "step-1",
            title: "verify approval flow",
            details: "confirm approval UI still works",
            status: "in_progress",
            evidence: ["Tool review_status: approval preview inspected"],
            filePaths: ["src/app.ts"],
            recentToolResult: "Reviewed src/app.ts",
          },
          {
            id: "step-2",
            title: "finalize oauth notes",
            details: "capture remaining polish",
            status: "pending",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
        ],
      },
      latestActionableUserMessage: "finish the oauth follow-up without reopening old files",
      summaryFallback: "",
      reducerMode: "merge_and_digest",
      summaryRecoveryNeeded: false,
      interruptedTurn: null,
    });

    expect(prompt).toContain("TASK STATE CONTEXT:");
    expect(prompt).toContain("EXECUTION PLAN PROTOCOL:");
    expect(prompt).toContain(CYRENE_PLAN_START_TAG);
    expect(prompt).toContain("When a step finishes, mark it completed yourself.");
    expect(prompt).toContain("Active execution plan:");
    expect(prompt).toContain("1. [in_progress] verify approval flow");
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
    expect(prompt).not.toContain("a".repeat(450));
    expect(prompt).not.toContain("b".repeat(450));
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
      executionPlan: null,
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
    expect(prompt).toContain("EXECUTION PLAN PROTOCOL:");
    expect(prompt).toContain("If all planned work is done, mark the remaining finished steps completed");
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
      relevantMemories: [
        "[task] 直接编辑 src/bootstrap-entry.ts",
        "[fact] ???claude code是这个项目的东西，你搞错了",
      ],
      archiveSections: {
        "NEXT BEST ACTIONS": ["直接编辑 src/bootstrap-entry.ts"],
        "RECENT FAILURES": ["这会导致模型被旧信息、无关信息甚至错误信息影响"],
      },
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
      executionPlan: null,
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
    expect(prompt).toContain(
      "Retrieved archive memory:\n(deferred for low-information continuation"
    );
    expect(prompt).not.toContain("直接编辑 src/bootstrap-entry.ts");
    expect(prompt).not.toContain("这会导致模型被旧信息");
    expect(prompt).not.toContain("???claude code是这个项目的东西");
  });

  test("injects only selected extension summary instead of full skill prompt bodies", () => {
    const prompt = buildPromptWithContext(
      "explain this repo",
      "system",
      "project",
      {
        pins: [],
        relevantMemories: [],
        recent: [],
        latestActionableUserMessage: "",
        durableSummary: "",
        pendingDigest: "",
        executionPlan: null,
        summaryFallback: "",
        reducerMode: "merge_and_digest",
        summaryRecoveryNeeded: false,
        interruptedTurn: null,
      },
      [
        "SELECTED EXTENSIONS (request-scoped summary):",
        "skills:",
        "- skill repo-map | reason trigger match | scope project | exposure scoped | desc Repo structure helper",
        "mcp:",
        "- mcp filesystem | reason always visible | transport filesystem | scope default | trust trusted | exposure full",
      ].join("\n")
    );

    expect(prompt).toContain("SELECTED EXTENSIONS (request-scoped summary):");
    expect(prompt).toContain("skill repo-map");
    expect(prompt).toContain("mcp filesystem");
    expect(prompt).not.toContain("ACTIVE SKILLS");
    expect(prompt).not.toContain("full prompt should not leak here");
  });

  test("trims oversized working state and query blocks before sending the prompt upstream", () => {
    const hugeSummary = [
      "OBJECTIVE:",
      "- stabilize the transport layer",
      "",
      "CONFIRMED FACTS:",
      ...Array.from({ length: 80 }, (_, index) => `- fact ${index} ${"x".repeat(400)}`),
      "",
      "COMPLETED:",
      ...Array.from({ length: 80 }, (_, index) => `- completed ${index} ${"y".repeat(400)}`),
      "",
      "REMAINING:",
      ...Array.from({ length: 80 }, (_, index) => `- remaining ${index} ${"z".repeat(400)}`),
    ].join("\n");

    const prompt = buildPromptWithContext(
      `fix the provider overflow\n${"q".repeat(30000)}`,
      "system",
      "project",
      {
        pins: [],
        relevantMemories: [],
        recent: [],
        latestActionableUserMessage: "",
        durableSummary: hugeSummary,
        pendingDigest: hugeSummary,
        executionPlan: {
          capturedAt: "2026-01-01T00:00:00.000Z",
          sourcePreview: "trim prompt",
          projectRoot: "/workspace/repo",
          summary: "trim prompt",
          objective: "trim prompt",
          acceptedAt: "",
          acceptedSummary: "",
          steps: Array.from({ length: 12 }, (_, index) => ({
            id: `step-${index + 1}`,
            title: `step ${index + 1}`,
            details: `detail ${index} ${"p".repeat(500)}`,
            status: index === 0 ? "in_progress" : "pending",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          })),
        },
        summaryFallback: hugeSummary,
        reducerMode: "merge_and_digest",
        summaryRecoveryNeeded: true,
        interruptedTurn: null,
      }
    );

    expect(prompt.length).toBeLessThan(55000);
    expect(prompt).toContain("(truncated)");
    expect(prompt).toContain("...[truncated for prompt budget]...");
    expect(prompt).toContain("Working state (durable reducer):");
    expect(prompt).toContain("Pending turn digest (last completed turn not yet merged):");
    expect(prompt).toContain("Current user query (act on this now):");
    expect(prompt).not.toContain("q".repeat(15000));
  });

  test("keeps moderately long current queries intact under the expanded prompt budget", () => {
    const longQuery = `continue the refactor\n${"q".repeat(15000)}`;
    const prompt = buildPromptWithContext(
      longQuery,
      "system",
      "project",
      {
        pins: [],
        relevantMemories: [],
        recent: [],
        latestActionableUserMessage: "",
        durableSummary: [
          "OBJECTIVE:",
          "- finish the refactor",
          "",
          "REMAINING:",
          "- wire the next module",
        ].join("\n"),
        pendingDigest: "",
        executionPlan: null,
        summaryFallback: "",
        reducerMode: "merge_and_digest",
        summaryRecoveryNeeded: false,
        interruptedTurn: null,
      }
    );

    expect(prompt).toContain(longQuery);
    expect(prompt).not.toContain("...[truncated for prompt budget]...");
  });
});
