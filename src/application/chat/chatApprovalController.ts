import type { PendingReviewItem } from "../../core/mcp";
import type { ChatItem } from "../../shared/types/chat";
import type {
  ApprovalActionKind,
  ApprovalPanelState,
} from "./chatApprovalPanelState";
import { canRetryBlockedApproval } from "./chatStateHelpers";

type InteractionStampRef = {
  current: { token: string; at: number } | null;
};

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;

type ExecuteCurrentPendingReviewActionParams = {
  action: ApprovalActionKind;
  pendingReviews: PendingReviewItem[];
  approvalPanel: ApprovalPanelState;
  blockedRetryMs: number;
  isActionLocked: boolean;
  hasSuspendedTask: boolean;
  lastIntentRef: InteractionStampRef;
  isRepeatedInteraction: (
    ref: InteractionStampRef,
    token: string,
    cooldownMs?: number
  ) => boolean;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  markApprovalInFlight: (
    id: string,
    action: ApprovalActionKind,
    resumePending?: boolean
  ) => void;
  runReviewAction: (id: string) => void;
};

export const executeCurrentPendingReviewAction = ({
  action,
  pendingReviews,
  approvalPanel,
  blockedRetryMs,
  isActionLocked,
  hasSuspendedTask,
  lastIntentRef,
  isRepeatedInteraction,
  pushSystemMessage,
  markApprovalInFlight,
  runReviewAction,
}: ExecuteCurrentPendingReviewActionParams) => {
  const target = pendingReviews[approvalPanel.selectedIndex];
  if (!target) {
    pushSystemMessage("Approval error\nNo pending operation selected.", {
      kind: "error",
      tone: "danger",
      color: "red",
    });
    return false;
  }

  if (isActionLocked) {
    return false;
  }

  if (
    action === "approve" &&
    !canRetryBlockedApproval(
      approvalPanel.blockedItemId,
      target.id,
      approvalPanel.blockedAt,
      Date.now(),
      blockedRetryMs
    )
  ) {
    return false;
  }

  const interactionToken = `${action}:${target.id}:${approvalPanel.selectedIndex}`;
  if (isRepeatedInteraction(lastIntentRef, interactionToken)) {
    return false;
  }

  markApprovalInFlight(target.id, action, hasSuspendedTask);
  pushSystemMessage(
    `${action === "approve" ? "Approving" : "Rejecting"} ${target.id}...`,
    {
      kind: "system_hint",
      tone: "info",
      color: "cyan",
    }
  );
  runReviewAction(target.id);
  return true;
};
