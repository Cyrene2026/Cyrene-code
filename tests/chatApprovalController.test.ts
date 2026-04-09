import { describe, expect, mock, test } from "bun:test";
import type { PendingReviewItem } from "../src/core/mcp";
import { executeCurrentPendingReviewAction } from "../src/application/chat/chatApprovalController";
import { createInitialApprovalPanelState } from "../src/application/chat/chatApprovalPanelState";

const pendingItem: PendingReviewItem = {
  id: "review-1",
  serverId: "fs",
  request: {
    action: "write_file",
    path: "src/example.ts",
  },
  preview: "preview",
  previewSummary: "summary",
  previewFull: "full",
  createdAt: "2026-04-09T00:00:00.000Z",
};

describe("chatApprovalController", () => {
  test("executeCurrentPendingReviewAction starts approve flow from current selection", () => {
    const pushSystemMessage = mock(() => {});
    const markApprovalInFlight = mock(() => {});
    const runReviewAction = mock(() => {});

    const result = executeCurrentPendingReviewAction({
      action: "approve",
      pendingReviews: [pendingItem],
      approvalPanel: createInitialApprovalPanelState(),
      blockedRetryMs: 5000,
      isActionLocked: false,
      hasSuspendedTask: true,
      lastIntentRef: { current: null },
      isRepeatedInteraction: () => false,
      pushSystemMessage,
      markApprovalInFlight,
      runReviewAction,
    });

    expect(result).toBe(true);
    expect(markApprovalInFlight).toHaveBeenCalledWith("review-1", "approve", true);
    expect(runReviewAction).toHaveBeenCalledWith("review-1");
    expect(pushSystemMessage).toHaveBeenCalledWith("Approving review-1...", {
      kind: "system_hint",
      tone: "info",
      color: "cyan",
    });
  });

  test("executeCurrentPendingReviewAction blocks repeated approval retries inside cooldown", () => {
    const markApprovalInFlight = mock(() => {});
    const runReviewAction = mock(() => {});

    const result = executeCurrentPendingReviewAction({
      action: "approve",
      pendingReviews: [pendingItem],
      approvalPanel: {
        ...createInitialApprovalPanelState(),
        blockedItemId: "review-1",
        blockedAt: Date.now(),
      },
      blockedRetryMs: 60_000,
      isActionLocked: false,
      hasSuspendedTask: false,
      lastIntentRef: { current: null },
      isRepeatedInteraction: () => false,
      pushSystemMessage: () => {},
      markApprovalInFlight,
      runReviewAction,
    });

    expect(result).toBe(false);
    expect(markApprovalInFlight).not.toHaveBeenCalled();
    expect(runReviewAction).not.toHaveBeenCalled();
  });
});
