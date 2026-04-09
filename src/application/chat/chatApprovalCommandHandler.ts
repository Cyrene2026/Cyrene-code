import type { PendingReviewItem } from "../../core/mcp";
import type { ChatItem } from "../../shared/types/chat";
import {
  buildApprovalMessage,
  type ApprovalPreviewMode,
} from "./chatApprovalHelpers";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;
type ApprovalRiskSummary = { high: number; medium: number; low: number };

type HandleApprovalCommandParams = {
  query: string;
  listPending: () => PendingReviewItem[];
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
  summarizePendingRisk: (pending: PendingReviewItem[]) => ApprovalRiskSummary;
  openApprovalPanel: (
    nextPending: PendingReviewItem[],
    options?: {
      focusLatest?: boolean;
      selectId?: string;
      selectedIndex?: number;
      previewMode?: ApprovalPreviewMode;
    }
  ) => void;
  approvePendingReview: (id: string) => void;
  rejectPendingReview: (id: string) => void;
  approveLowBatch: () => void;
  approveAllBatch: () => void;
  rejectAllBatch: () => void;
};

const NEUTRAL_MESSAGE_OPTIONS = {
  kind: "system_hint",
  tone: "neutral",
  color: "white",
} satisfies SystemMessageOptions;

const ERROR_MESSAGE_OPTIONS = {
  kind: "error",
  tone: "danger",
  color: "red",
} satisfies SystemMessageOptions;

const REVIEW_MESSAGE_OPTIONS = {
  kind: "review_status",
  tone: "warning",
  color: "yellow",
} satisfies SystemMessageOptions;

export const handleApprovalCommand = ({
  query,
  listPending,
  pushSystemMessage,
  clearInput,
  summarizePendingRisk,
  openApprovalPanel,
  approvePendingReview,
  rejectPendingReview,
  approveLowBatch,
  approveAllBatch,
  rejectAllBatch,
}: HandleApprovalCommandParams) => {
  if (query === "/review") {
    const pending = listPending();
    if (pending.length === 0) {
      pushSystemMessage("No pending operations.", NEUTRAL_MESSAGE_OPTIONS);
    } else {
      const risk = summarizePendingRisk(pending);
      pushSystemMessage(
        buildApprovalMessage("Approval required", undefined, [
          `pending: ${pending.length}`,
          `risk: high ${risk.high} | medium ${risk.medium} | low ${risk.low}`,
          "panel: opened",
          "keys: ↑/↓ select  Tab preview  a approve  r reject  Esc close",
          "batch: /approve low | /approve all | /reject all",
        ]),
        REVIEW_MESSAGE_OPTIONS
      );
      openApprovalPanel(pending, {
        focusLatest: true,
        previewMode: "summary",
      });
    }
    clearInput();
    return true;
  }

  if (query.startsWith("/review ")) {
    const id = query.slice("/review ".length).trim();
    if (!id) {
      pushSystemMessage("Usage: /review <id>");
      clearInput();
      return true;
    }

    const pending = listPending();
    const target = pending.find(item => item.id === id);
    if (!target) {
      pushSystemMessage(
        buildApprovalMessage("Approval error", undefined, [
          `pending operation not found: ${id}`,
        ]),
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }

    pushSystemMessage(
      buildApprovalMessage("Approval required", target, [
        "panel: opened",
        "preview: full",
      ]),
      REVIEW_MESSAGE_OPTIONS
    );
    openApprovalPanel(pending, {
      selectId: target.id,
      previewMode: "full",
    });
    clearInput();
    return true;
  }

  if (query === "/approve") {
    const pending = listPending();
    if (pending.length === 0) {
      pushSystemMessage(
        "No pending operations to approve.",
        NEUTRAL_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    if (pending.length > 1) {
      const risk = summarizePendingRisk(pending);
      pushSystemMessage(
        buildApprovalMessage("Approval required", undefined, [
          `pending: ${pending.length}`,
          `risk: high ${risk.high} | medium ${risk.medium} | low ${risk.low}`,
          "use: /approve <id>, /approve low, /approve all, or the approval panel",
        ]),
        REVIEW_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const only = pending[0];
    if (!only) {
      pushSystemMessage(
        "No pending operations to approve.",
        NEUTRAL_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    approvePendingReview(only.id);
    clearInput();
    return true;
  }

  if (query === "/approve low") {
    approveLowBatch();
    clearInput();
    return true;
  }

  if (query === "/approve all") {
    approveAllBatch();
    clearInput();
    return true;
  }

  if (query.startsWith("/approve ")) {
    const id = query.slice("/approve ".length).trim();
    if (!id) {
      pushSystemMessage("Usage: /approve <id> | /approve low | /approve all");
      clearInput();
      return true;
    }
    approvePendingReview(id);
    clearInput();
    return true;
  }

  if (query === "/reject") {
    const pending = listPending();
    if (pending.length === 0) {
      pushSystemMessage(
        "No pending operations to reject.",
        NEUTRAL_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    if (pending.length > 1) {
      const risk = summarizePendingRisk(pending);
      pushSystemMessage(
        buildApprovalMessage("Approval required", undefined, [
          `pending: ${pending.length}`,
          `risk: high ${risk.high} | medium ${risk.medium} | low ${risk.low}`,
          "use: /reject <id>, /reject all, or the approval panel",
        ]),
        REVIEW_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const only = pending[0];
    if (!only) {
      pushSystemMessage(
        "No pending operations to reject.",
        NEUTRAL_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    rejectPendingReview(only.id);
    clearInput();
    return true;
  }

  if (query === "/reject all") {
    rejectAllBatch();
    clearInput();
    return true;
  }

  if (query.startsWith("/reject ")) {
    const id = query.slice("/reject ".length).trim();
    if (!id) {
      pushSystemMessage("Usage: /reject <id> | /reject all");
      clearInput();
      return true;
    }
    rejectPendingReview(id);
    clearInput();
    return true;
  }

  return false;
};
