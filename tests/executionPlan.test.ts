import { describe, expect, test } from "bun:test";
import {
  CYRENE_PLAN_END_TAG,
  CYRENE_PLAN_START_TAG,
  applyExecutionPlanToWorkingState,
  parseAssistantPlanUpdate,
  stripExecutionPlanFromWorkingState,
} from "../src/core/session/executionPlan";

describe("executionPlan", () => {
  test("parses assistant plan blocks and strips them from visible text", () => {
    const parsed = parseAssistantPlanUpdate(
      [
        "Plan ready.",
        CYRENE_PLAN_START_TAG,
        JSON.stringify({
          version: 1,
          projectRoot: "/workspace/project-a",
          summary: "Finish the refactor cleanly",
          objective: "finish the refactor",
          steps: [
            {
              id: "step-1",
              title: "inspect call sites",
              details: "confirm current API usage",
              status: "completed",
              evidence: [],
              filePaths: [],
              recentToolResult: "",
            },
            {
              id: "step-2",
              title: "patch reducer",
              details: "wire the new state shape",
              status: "in_progress",
              evidence: [],
              filePaths: [],
              recentToolResult: "",
            },
          ],
        }),
        CYRENE_PLAN_END_TAG,
      ].join("\n"),
      "2026-01-01T00:00:00.000Z"
    );

    expect(parsed.visibleText).toBe("Plan ready.");
    expect(parsed.plan?.projectRoot).toBe("/workspace/project-a");
    expect(parsed.plan?.objective).toBe("finish the refactor");
    expect(parsed.plan?.steps).toHaveLength(2);
    expect(parsed.plan?.steps[1]).toEqual({
      id: "step-2",
      title: "patch reducer",
      details: "wire the new state shape",
      status: "in_progress",
      evidence: [],
      filePaths: [],
      recentToolResult: "",
    });
    expect(parsed.plan?.acceptedAt).toBe("");
    expect(parsed.plan?.acceptedSummary).toBe("");
  });

  test("links execution plans into summary and pending digest", () => {
    const linked = applyExecutionPlanToWorkingState({
      summary: "",
      pendingDigest: "",
      plan: {
        capturedAt: "2026-01-01T00:00:00.000Z",
        sourcePreview: "refactor task",
        projectRoot: "/workspace/project-a",
        summary: "Finish the refactor cleanly",
        objective: "finish the refactor",
        acceptedAt: "",
        acceptedSummary: "",
        steps: [
          {
            id: "step-1",
            title: "inspect call sites",
            details: "",
            status: "completed",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
          {
            id: "step-2",
            title: "patch reducer",
            details: "",
            status: "in_progress",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
          {
            id: "step-3",
            title: "run tests",
            details: "blocked on missing fixture",
            status: "blocked",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
        ],
      },
    });

    expect(linked.summary).toContain("OBJECTIVE:\n- finish the refactor");
    expect(linked.summary).toContain("COMPLETED:\n- Completed plan step: inspect call sites");
    expect(linked.summary).toContain(
      "REMAINING:\n- Remaining plan step: patch reducer\n- Remaining plan step: run tests (blocked: blocked on missing fixture)"
    );
    expect(linked.pendingDigest).toContain(
      "NEXT BEST ACTIONS:\n- Continue with active plan step: patch reducer"
    );
    expect(linked.pendingDigest).toContain(
      "RECENT FAILURES:\n- Blocked plan step: run tests - blocked on missing fixture"
    );
  });

  test("strips execution plan projections from linked working state", () => {
    const linked = applyExecutionPlanToWorkingState({
      summary: "",
      pendingDigest: "",
      plan: {
        capturedAt: "2026-01-01T00:00:00.000Z",
        sourcePreview: "refactor task",
        projectRoot: "/workspace/project-a",
        summary: "Finish the refactor cleanly",
        objective: "finish the refactor",
        acceptedAt: "2026-01-01T00:00:01.000Z",
        acceptedSummary: "ready",
        steps: [
          {
            id: "step-1",
            title: "inspect call sites",
            details: "",
            status: "completed",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
          {
            id: "step-2",
            title: "patch reducer",
            details: "",
            status: "in_progress",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
        ],
      },
    });

    const stripped = stripExecutionPlanFromWorkingState({
      summary: linked.summary,
      pendingDigest: linked.pendingDigest,
      plan: {
        capturedAt: "2026-01-01T00:00:00.000Z",
        sourcePreview: "refactor task",
        projectRoot: "/workspace/project-a",
        summary: "Finish the refactor cleanly",
        objective: "finish the refactor",
        acceptedAt: "2026-01-01T00:00:01.000Z",
        acceptedSummary: "ready",
        steps: [
          {
            id: "step-1",
            title: "inspect call sites",
            details: "",
            status: "completed",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
          {
            id: "step-2",
            title: "patch reducer",
            details: "",
            status: "in_progress",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
        ],
      },
    });

    expect(stripped.summary).not.toContain("Completed plan step:");
    expect(stripped.summary).not.toContain("Remaining plan step:");
    expect(stripped.pendingDigest).not.toContain("Next plan step:");
    expect(stripped.pendingDigest).not.toContain("Continue with active plan step:");
  });
});
