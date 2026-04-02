import { describe, expect, test } from "bun:test";
import {
  canRetryBlockedApproval,
  clearApprovalBlockOnSelectionChange,
  computeNextApprovalSelection,
  clampPreviewOffset,
  cycleSelection,
  movePagedSelection,
  shouldKeepApprovalPanelOpen,
  shouldBlockRepeatedApproval,
} from "../src/application/chat/chatStateHelpers";

describe("chatStateHelpers", () => {
  test("cycleSelection wraps in both directions", () => {
    expect(cycleSelection(0, 3, "up")).toBe(2);
    expect(cycleSelection(2, 3, "down")).toBe(0);
    expect(cycleSelection(1, 3, "up")).toBe(0);
    expect(cycleSelection(1, 3, "down")).toBe(2);
  });

  test("movePagedSelection flips page while preserving offset", () => {
    expect(movePagedSelection(1, 10, 4, "right")).toBe(5);
    expect(movePagedSelection(5, 10, 4, "left")).toBe(1);
    expect(movePagedSelection(9, 10, 4, "right")).toBe(1);
    expect(movePagedSelection(1, 10, 4, "left")).toBe(9);
  });

  test("clampPreviewOffset stays within available lines", () => {
    const preview = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
    expect(clampPreviewOffset(preview, -10, 5)).toBe(0);
    expect(clampPreviewOffset(preview, 1, 5)).toBe(1);
    expect(clampPreviewOffset(preview, 99, 5)).toBe(3);
  });

  test("approval helpers keep focus and open state stable across queue transitions", () => {
    expect(computeNextApprovalSelection(2, 2)).toBe(1);
    expect(computeNextApprovalSelection(0, 0)).toBe(0);
    expect(computeNextApprovalSelection(-1, 3)).toBe(0);

    expect(shouldKeepApprovalPanelOpen(2, true)).toBe(true);
    expect(shouldKeepApprovalPanelOpen(0, true)).toBe(false);
    expect(shouldKeepApprovalPanelOpen(2, false)).toBe(false);
  });

  test("blocked approval helpers freeze repeated approval until cooldown or selection change", () => {
    expect(
      shouldBlockRepeatedApproval("item-1", "item-1", 1000, 1200, 500)
    ).toBe(true);
    expect(
      shouldBlockRepeatedApproval("item-1", "item-1", 1000, 1600, 500)
    ).toBe(false);
    expect(
      canRetryBlockedApproval("item-1", "item-1", 1000, 1600, 500)
    ).toBe(true);
    expect(
      canRetryBlockedApproval("item-1", "item-1", 1000, 1200, 500)
    ).toBe(false);

    const cleared = clearApprovalBlockOnSelectionChange(
      {
        selectedIndex: 1,
        blockedItemId: "item-1",
        blockedReason: "EEXIST",
        blockedAt: 1000,
        lastAction: "approve" as const,
      },
      0
    );

    expect(cleared).toEqual({
      selectedIndex: 0,
      blockedItemId: null,
      blockedReason: null,
      blockedAt: null,
      lastAction: null,
    });
  });
});
