import { describe, expect, test } from "bun:test";
import {
  clampPreviewOffset,
  cycleSelection,
  movePagedSelection,
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
});
