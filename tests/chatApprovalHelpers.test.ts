import { describe, expect, test } from "bun:test";
import type { PendingReviewItem } from "../src/core/mcp";
import {
  buildApprovalMessage,
  condensePreview,
  getApprovalPreviewText,
  getPendingQueueSignature,
  parseToolDetail,
} from "../src/application/chat/chatApprovalHelpers";

const pendingItem: PendingReviewItem = {
  id: "review-1",
  serverId: "fs",
  request: {
    action: "create_file",
    path: "src/example.ts",
  },
  preview: "preview",
  previewSummary: "summary preview",
  previewFull: "full preview",
  createdAt: "2026-04-09T00:00:00.000Z",
};

describe("chatApprovalHelpers", () => {
  test("buildApprovalMessage includes item metadata and extra lines", () => {
    expect(buildApprovalMessage("Approved", pendingItem, ["done"])).toBe(
      [
        "Approved",
        "id: review-1",
        "action: create_file",
        "path: src/example.ts",
        "done",
      ].join("\n")
    );
  });

  test("parseToolDetail extracts detail action and path from tool headers", () => {
    expect(
      parseToolDetail("[tool result] create_file src/example.ts\nCreated file")
    ).toEqual({
      detail: "create_file src/example.ts",
      action: "create_file",
      path: "src/example.ts",
    });
  });

  test("condensePreview trims long previews by line count", () => {
    const text = ["a", "b", "c", "d"].join("\n");
    expect(condensePreview(text, 2)).toBe("a\nb\n... 2 more lines");
    expect(condensePreview(text, 4)).toBe(text);
  });

  test("approval preview and queue signature helpers stay deterministic", () => {
    expect(getApprovalPreviewText(undefined, "summary")).toBe("");
    expect(getApprovalPreviewText(pendingItem, "summary")).toBe("summary preview");
    expect(getApprovalPreviewText(pendingItem, "full")).toBe("full preview");
    expect(getPendingQueueSignature([pendingItem, { ...pendingItem, id: "review-2" }])).toBe(
      "review-1|review-2"
    );
  });
});
