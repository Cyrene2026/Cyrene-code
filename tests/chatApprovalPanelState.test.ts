import { describe, expect, test } from "bun:test";
import type { PendingReviewItem } from "../src/core/mcp";
import {
  closeApprovalPanelState,
  createInitialApprovalPanelState,
  createNextApprovalPanelState,
} from "../src/application/chat/chatApprovalPanelState";

const createPendingItem = (id: string): PendingReviewItem => ({
  id,
  serverId: "fs",
  request: {
    action: "write_file",
    path: `src/${id}.ts`,
  },
  preview: `${id} preview`,
  previewSummary: `${id} summary`,
  previewFull: `${id} full`,
  createdAt: "2026-04-09T00:00:00.000Z",
});

describe("chatApprovalPanelState", () => {
  test("createNextApprovalPanelState clears stale blocked state when queue changes", () => {
    const previous = {
      ...createInitialApprovalPanelState(),
      active: true,
      blockedItemId: "review-gone",
      blockedReason: "still blocked",
      blockedAt: 123,
      lastAction: "approve" as const,
    };

    const nextState = createNextApprovalPanelState(previous, [
      createPendingItem("review-1"),
    ]);

    expect(nextState.blockedItemId).toBeNull();
    expect(nextState.blockedReason).toBeNull();
    expect(nextState.blockedAt).toBeNull();
    expect(nextState.lastAction).toBeNull();
    expect(nextState.active).toBe(true);
  });

  test("closeApprovalPanelState clears in-flight flags but preserves other context", () => {
    const previous = {
      ...createInitialApprovalPanelState("full"),
      active: true,
      previewOffset: 24,
      blockedItemId: "review-1",
      blockedReason: "blocked",
      blockedAt: 456,
      lastAction: "reject" as const,
      inFlightId: "review-1",
      actionState: "approve" as const,
      resumePending: true,
    };

    expect(closeApprovalPanelState(previous)).toEqual({
      ...previous,
      active: false,
      previewOffset: 0,
      inFlightId: null,
      actionState: null,
      resumePending: false,
    });
  });
});
