import type { SessionMemoryInput } from "../../core/session/memoryIndex";
import type { McpHandleResult, McpRuntime, MpcAction, PendingReviewItem } from "../../core/mcp";
import type { ChatItem } from "../../shared/types/chat";
import { buildApprovalMessage } from "./chatApprovalHelpers";
import type {
  ApprovalActionKind,
  ApprovalStateUpdateOptions,
} from "./chatApprovalPanelState";
import { extractMessageBody } from "./chatFilePreviewHelpers";
import {
  computeNextApprovalSelection,
  shouldKeepApprovalPanelOpen,
} from "./chatStateHelpers";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;
type ApprovalRiskSummary = { high: number; medium: number; low: number };

type BaseApprovalExecutionParams = {
  mcpService: McpRuntime;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  recordSessionMemory: (
    sessionId: string | null,
    entry: SessionMemoryInput
  ) => Promise<void>;
  getMemorySessionId: () => string | null;
  updatePendingState: (
    nextPending: PendingReviewItem[],
    options?: ApprovalStateUpdateOptions
  ) => void;
};

type ApproveExecutionExtras = {
  syncShellSessionFromMessage: (raw: string, actionHint?: string | null) => void;
  actionColor: (action?: MpcAction) => ChatItem["color"];
  resumeSuspendedTask: (toolResultMessage: string) => Promise<void>;
  repairSettledReviewState: () => void;
};

type RejectExecutionExtras = {
  cancelSuspendedTask: (
    toolResultMessage: string,
    options?: { suppressApprovalQueue?: boolean }
  ) => Promise<unknown>;
};

type BatchExecutionExtras = RejectExecutionExtras & {
  resumeSuspendedTask: (toolResultMessage: string) => Promise<void>;
  repairSettledReviewState: () => void;
  summarizePendingRisk: (pending: PendingReviewItem[]) => ApprovalRiskSummary;
};

type ExecuteApprovePendingReviewParams = BaseApprovalExecutionParams &
  ApproveExecutionExtras & {
  id: string;
  wasOpen: boolean;
  onApprovalBlocked: (blocked: {
    itemId: string;
    reason: string;
    at: number;
    lastAction: "approve";
  }) => void;
  };

type ExecuteRejectPendingReviewParams = BaseApprovalExecutionParams &
  RejectExecutionExtras & {
  id: string;
  wasOpen: boolean;
  hasSuspendedTask: boolean;
};

type ExecutePendingBatchParams = BaseApprovalExecutionParams &
  BatchExecutionExtras & {
  action: ApprovalActionKind;
  selector: (item: PendingReviewItem) => boolean;
  scopeLabel: string;
  currentIndex: number;
  wasOpen: boolean;
  hasSuspendedTask: boolean;
  markInFlight?: () => void;
};

export const executeApprovePendingReview = async ({
  id,
  mcpService,
  wasOpen,
  updatePendingState,
  pushSystemMessage,
  recordSessionMemory,
  getMemorySessionId,
  onApprovalBlocked,
  syncShellSessionFromMessage,
  actionColor,
  resumeSuspendedTask,
  repairSettledReviewState,
}: ExecuteApprovePendingReviewParams) => {
  const before = mcpService.listPending();
  const target = before.find(item => item.id === id);
  const currentIndex = computeNextApprovalSelection(
    before.findIndex(item => item.id === id),
    before.length
  );
  const optimisticPending = before.filter(item => item.id !== id);
  if (target) {
    updatePendingState(optimisticPending, {
      open: shouldKeepApprovalPanelOpen(optimisticPending.length, wasOpen),
      selectedIndex: computeNextApprovalSelection(
        currentIndex,
        optimisticPending.length
      ),
      clearBlocked: true,
    });
  }
  const result = await mcpService.approve(id);
  const nextPending = mcpService.listPending();

  if (!target) {
    updatePendingState(nextPending, {
      open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
      selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
      clearBlocked: true,
    });
    const message = buildApprovalMessage("Approval error", undefined, [result.message]);
    pushSystemMessage(message, {
      kind: "error",
      tone: "danger",
      color: "red",
    });
    await recordSessionMemory(getMemorySessionId(), {
      kind: "error",
      text: message,
      priority: 85,
      entities: {
        status: ["error"],
      },
    });
    return;
  }

  if (!result.ok) {
    const blockedState = {
      itemId: target.id,
      reason: extractMessageBody(result.message) || result.message,
      at: Date.now(),
      lastAction: "approve" as const,
    };
    updatePendingState(nextPending, {
      open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
      selectedIndex: currentIndex,
      blocked: blockedState,
    });
    if (nextPending.some(item => item.id === target.id)) {
      onApprovalBlocked(blockedState);
    }
    const message = buildApprovalMessage("Approval error", target, [
      blockedState.reason,
    ]);
    pushSystemMessage(message, {
      kind: "error",
      tone: "danger",
      color: "red",
    });
    await recordSessionMemory(getMemorySessionId(), {
      kind: "error",
      text: message,
      priority: 90,
      entities: {
        path: [target.request.path],
        action: [target.request.action],
        status: ["error"],
      },
    });
    return;
  }

  updatePendingState(nextPending, {
    open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
    selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
    clearBlocked: true,
  });

  const output = extractMessageBody(result.message);
  syncShellSessionFromMessage(result.message, target.request.action);
  const message = buildApprovalMessage("Approved", target, output ? [output] : []);
  pushSystemMessage(message, {
    kind: "review_status",
    tone: "success",
    color: actionColor(target.request.action) ?? "green",
  });
  await recordSessionMemory(getMemorySessionId(), {
    kind: "approval",
    text: message,
    priority: 80,
    entities: {
      path: [target.request.path],
      action: [target.request.action],
      status: ["approved"],
    },
  });
  await resumeSuspendedTask(result.message);
  repairSettledReviewState();
};

export const executeRejectPendingReview = async ({
  id,
  mcpService,
  wasOpen,
  hasSuspendedTask,
  updatePendingState,
  pushSystemMessage,
  recordSessionMemory,
  getMemorySessionId,
  cancelSuspendedTask,
}: ExecuteRejectPendingReviewParams) => {
  const before = mcpService.listPending();
  const target = before.find(item => item.id === id);
  const currentIndex = computeNextApprovalSelection(
    before.findIndex(item => item.id === id),
    before.length
  );
  const optimisticPending = before.filter(item => item.id !== id);
  if (target) {
    updatePendingState(optimisticPending, {
      open: shouldKeepApprovalPanelOpen(optimisticPending.length, wasOpen),
      selectedIndex: computeNextApprovalSelection(
        currentIndex,
        optimisticPending.length
      ),
      clearBlocked: true,
    });
  }
  const result = mcpService.reject(id);
  const nextPending = mcpService.listPending();

  if (!target || !result.ok) {
    updatePendingState(nextPending, {
      open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
      selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
    });
    const message = buildApprovalMessage("Approval error", target, [
      extractMessageBody(result.message) || result.message,
    ]);
    pushSystemMessage(message, {
      kind: "error",
      tone: "danger",
      color: "red",
    });
    await recordSessionMemory(getMemorySessionId(), {
      kind: "error",
      text: message,
      priority: 85,
      entities: {
        path: target?.request.path ? [target.request.path] : undefined,
        action: target?.request.action ? [target.request.action] : undefined,
        status: ["error"],
      },
    });
    return;
  }

  updatePendingState(nextPending, {
    open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
    selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
    clearBlocked: true,
  });

  const rejectionMessage = buildApprovalMessage(
    "Rejected",
    target,
    hasSuspendedTask
      ? [
          "current suspended task cancelled",
          "add requirements and send a new prompt when ready",
        ]
      : []
  );
  if (hasSuspendedTask) {
    await cancelSuspendedTask(rejectionMessage, {
      suppressApprovalQueue: true,
    });
  } else {
    pushSystemMessage(rejectionMessage, {
      kind: "review_status",
      tone: "warning",
      color: "yellow",
    });
  }
  await recordSessionMemory(getMemorySessionId(), {
    kind: "approval",
    text: rejectionMessage,
    priority: 78,
    entities: {
      path: [target.request.path],
      action: [target.request.action],
      status: ["rejected"],
    },
  });
};

export const executePendingBatch = async ({
  action,
  selector,
  scopeLabel,
  currentIndex,
  wasOpen,
  hasSuspendedTask,
  markInFlight,
  mcpService,
  updatePendingState,
  pushSystemMessage,
  recordSessionMemory,
  getMemorySessionId,
  cancelSuspendedTask,
  resumeSuspendedTask,
  repairSettledReviewState,
  summarizePendingRisk,
}: ExecutePendingBatchParams) => {
  const before = mcpService.listPending();
  const targets = before.filter(selector);

  if (targets.length === 0) {
    pushSystemMessage(`No pending operations matched batch scope: ${scopeLabel}.`, {
      kind: "system_hint",
      tone: "neutral",
      color: "white",
    });
    return;
  }

  markInFlight?.();

  let success = 0;
  let failed = 0;
  let resumeMessage: string | null = null;
  const failureDetails: string[] = [];

  for (const target of targets) {
    const result: McpHandleResult =
      action === "approve"
        ? await mcpService.approve(target.id)
        : mcpService.reject(target.id);
    if (result.ok) {
      success += 1;
      if (action === "approve" && !resumeMessage) {
        resumeMessage = result.message;
      }
      continue;
    }

    failed += 1;
    failureDetails.push(
      `${target.id}: ${extractMessageBody(result.message) || result.message}`
    );
  }

  const nextPending = mcpService.listPending();
  updatePendingState(nextPending, {
    open: shouldKeepApprovalPanelOpen(nextPending.length, wasOpen),
    selectedIndex: computeNextApprovalSelection(currentIndex, nextPending.length),
    clearBlocked: true,
  });

  const processedRisk = summarizePendingRisk(targets);
  const remainingRisk = summarizePendingRisk(nextPending);
  const title = action === "approve" ? "Batch approved" : "Batch rejected";
  const tone =
    failed > 0 ? "warning" : action === "approve" ? "success" : "warning";
  const color =
    failed > 0 ? "yellow" : action === "approve" ? "green" : "yellow";
  const lines = [
    `scope: ${scopeLabel}`,
    `processed: ${targets.length}`,
    `success: ${success}`,
    `failed: ${failed}`,
    `remaining: ${nextPending.length}`,
    action === "reject" && hasSuspendedTask && success > 0
      ? "suspended task: cancelled"
      : "",
    `processed_risk: high ${processedRisk.high} | medium ${processedRisk.medium} | low ${processedRisk.low}`,
    `remaining_risk: high ${remainingRisk.high} | medium ${remainingRisk.medium} | low ${remainingRisk.low}`,
    ...failureDetails.slice(0, 3).map(detail => `failure: ${detail}`),
    failureDetails.length > 3
      ? `failure: ... ${failureDetails.length - 3} more`
      : "",
  ].filter(Boolean);

  const summaryMessage = buildApprovalMessage(title, undefined, lines);
  if (action === "reject" && hasSuspendedTask && success > 0) {
    await cancelSuspendedTask(summaryMessage, {
      suppressApprovalQueue: true,
    });
  } else {
    pushSystemMessage(summaryMessage, {
      kind: "review_status",
      tone,
      color,
    });
  }
  await recordSessionMemory(getMemorySessionId(), {
    kind: failed > 0 ? "error" : "approval",
    text: summaryMessage,
    priority: failed > 0 ? 86 : 79,
    entities: {
      action: [action],
      status: [failed > 0 ? "partial" : "ok"],
    },
  });

  if (resumeMessage) {
    await resumeSuspendedTask(resumeMessage);
  }
  repairSettledReviewState();
};
