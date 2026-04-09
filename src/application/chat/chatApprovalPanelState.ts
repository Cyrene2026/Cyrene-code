import type { PendingReviewItem } from "../../core/mcp";
import {
  getApprovalPreviewText,
  type ApprovalPreviewMode,
} from "./chatApprovalHelpers";
import {
  clampPreviewOffset,
  computeNextApprovalSelection,
} from "./chatStateHelpers";

export type ApprovalActionKind = "approve" | "reject";

export type ApprovalPanelState = {
  active: boolean;
  selectedIndex: number;
  previewMode: ApprovalPreviewMode;
  previewOffset: number;
  lastOpenedAt: string | null;
  blockedItemId: string | null;
  blockedReason: string | null;
  blockedAt: number | null;
  lastAction: ApprovalActionKind | null;
  inFlightId: string | null;
  actionState: ApprovalActionKind | null;
  resumePending: boolean;
};

export type ApprovalBlockedState = {
  itemId: string;
  reason: string;
  at: number;
  lastAction: ApprovalActionKind;
};

export type ApprovalStateUpdateOptions = {
  open?: boolean;
  focusLatest?: boolean;
  selectId?: string;
  selectedIndex?: number;
  previewMode?: ApprovalPreviewMode;
  clearBlocked?: boolean;
  blocked?: ApprovalBlockedState | null;
};

export const createInitialApprovalPanelState = (
  previewMode: ApprovalPreviewMode = "summary"
): ApprovalPanelState => ({
  active: false,
  selectedIndex: 0,
  previewMode,
  previewOffset: 0,
  lastOpenedAt: null,
  blockedItemId: null,
  blockedReason: null,
  blockedAt: null,
  lastAction: null,
  inFlightId: null,
  actionState: null,
  resumePending: false,
});

export const clearApprovalBlock = (
  state: ApprovalPanelState
): ApprovalPanelState => ({
  ...state,
  blockedItemId: null,
  blockedReason: null,
  blockedAt: null,
  lastAction: null,
});

export const clearApprovalInFlight = (
  state: ApprovalPanelState
): ApprovalPanelState => ({
  ...state,
  inFlightId: null,
  actionState: null,
  resumePending: false,
});

export const syncApprovalBlockToQueue = (
  state: ApprovalPanelState,
  pending: PendingReviewItem[]
): ApprovalPanelState => {
  if (
    !state.blockedItemId ||
    pending.some(item => item.id === state.blockedItemId)
  ) {
    return state;
  }

  return clearApprovalBlock(state);
};

export const createNextApprovalPanelState = (
  previous: ApprovalPanelState,
  nextPending: PendingReviewItem[],
  options?: ApprovalStateUpdateOptions
): ApprovalPanelState => {
  if (nextPending.length === 0) {
    return {
      active: false,
      selectedIndex: 0,
      previewMode: options?.previewMode ?? previous.previewMode,
      previewOffset: 0,
      lastOpenedAt: previous.lastOpenedAt,
      blockedItemId: null,
      blockedReason: null,
      blockedAt: null,
      lastAction: null,
      inFlightId: null,
      actionState: null,
      resumePending: false,
    };
  }

  let nextIndex = previous.selectedIndex;
  if (typeof options?.selectedIndex === "number") {
    nextIndex = options.selectedIndex;
  } else if (options?.selectId) {
    const matchedIndex = nextPending.findIndex(item => item.id === options.selectId);
    if (matchedIndex >= 0) {
      nextIndex = matchedIndex;
    }
  } else if (options?.focusLatest) {
    nextIndex = nextPending.length - 1;
  }

  const boundedIndex = computeNextApprovalSelection(nextIndex, nextPending.length);
  const nextPreviewMode = options?.previewMode ?? previous.previewMode;
  const selectedItem = nextPending[boundedIndex];
  const selectedPreview = getApprovalPreviewText(selectedItem, nextPreviewMode);
  const previewOffset =
    options?.previewMode && options.previewMode !== previous.previewMode
      ? 0
      : boundedIndex !== previous.selectedIndex
        ? 0
        : clampPreviewOffset(selectedPreview, previous.previewOffset);
  const nextActive = options?.open ?? previous.active;
  let nextState: ApprovalPanelState = {
    active: nextActive,
    selectedIndex: boundedIndex,
    previewMode: nextPreviewMode,
    previewOffset,
    lastOpenedAt: nextActive ? new Date().toISOString() : previous.lastOpenedAt,
    blockedItemId: previous.blockedItemId,
    blockedReason: previous.blockedReason,
    blockedAt: previous.blockedAt,
    lastAction: previous.lastAction,
    inFlightId: previous.inFlightId,
    actionState: previous.actionState,
    resumePending: previous.resumePending,
  };

  if (options?.clearBlocked) {
    nextState = clearApprovalBlock(nextState);
  } else if (options?.blocked) {
    nextState = {
      ...nextState,
      blockedItemId: options.blocked.itemId,
      blockedReason: options.blocked.reason,
      blockedAt: options.blocked.at,
      lastAction: options.blocked.lastAction,
    };
  } else if (boundedIndex !== previous.selectedIndex) {
    nextState = clearApprovalBlock(nextState);
  }

  return syncApprovalBlockToQueue(nextState, nextPending);
};

export const closeApprovalPanelState = (
  previous: ApprovalPanelState
): ApprovalPanelState => ({
  ...clearApprovalInFlight(previous),
  active: false,
  previewOffset: 0,
});
