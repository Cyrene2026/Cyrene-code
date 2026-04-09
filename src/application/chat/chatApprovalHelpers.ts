import type { PendingReviewItem } from "../../core/mcp";

export type ApprovalPreviewMode = "summary" | "full";

export const buildApprovalMessage = (
  title: string,
  item?: PendingReviewItem,
  extraLines: string[] = []
) =>
  [
    title,
    ...(item
      ? [
          `id: ${item.id}`,
          `action: ${item.request.action}`,
          `path: ${item.request.path}`,
        ]
      : []),
    ...extraLines.filter(Boolean),
  ].join("\n");

export const parseToolDetail = (raw: string) => {
  const [header = ""] = raw.split("\n");
  const detail = header
    .replace("[tool result]", "")
    .replace("[tool error]", "")
    .trim();
  const [action = "", path = ""] = detail.split(/\s+/, 2);
  return {
    detail,
    action: action || undefined,
    path: path || undefined,
  };
};

export const condensePreview = (text: string, maxLines = 120) => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n... ${lines.length - maxLines} more lines`;
};

export const getApprovalPreviewText = (
  item: PendingReviewItem | undefined,
  mode: ApprovalPreviewMode
) => {
  if (!item) {
    return "";
  }
  return mode === "full" ? item.previewFull : item.previewSummary;
};

export const getPendingQueueSignature = (pending: PendingReviewItem[]) =>
  pending.map(item => item.id).join("|");
