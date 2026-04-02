export const cycleSelection = (
  selectedIndex: number,
  total: number,
  direction: "up" | "down"
) => {
  if (total <= 0) {
    return 0;
  }

  if (direction === "up") {
    return selectedIndex <= 0 ? total - 1 : selectedIndex - 1;
  }

  return selectedIndex >= total - 1 ? 0 : selectedIndex + 1;
};

export const movePagedSelection = (
  selectedIndex: number,
  total: number,
  pageSize: number,
  direction: "left" | "right"
) => {
  if (total <= 0) {
    return 0;
  }

  const safePageSize = Math.max(1, pageSize);
  const currentPage = Math.floor(selectedIndex / safePageSize);
  const maxPage = Math.floor((total - 1) / safePageSize);
  const offset = selectedIndex % safePageSize;

  const nextPage =
    direction === "left"
      ? currentPage <= 0
        ? maxPage
        : currentPage - 1
      : currentPage >= maxPage
        ? 0
        : currentPage + 1;

  return Math.min(nextPage * safePageSize + offset, total - 1);
};

export const clampPreviewOffset = (
  previewText: string,
  offset: number,
  pageSize = 20
) => {
  const totalLines = previewText.split("\n").length;
  const maxOffset = Math.max(0, totalLines - pageSize);
  return Math.max(0, Math.min(offset, maxOffset));
};

export const computeNextApprovalSelection = (
  previousIndex: number,
  total: number
) => {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(previousIndex, total - 1));
};

export const shouldKeepApprovalPanelOpen = (
  total: number,
  wasActive: boolean
) => wasActive && total > 0;

export const canRetryBlockedApproval = (
  blockedItemId: string | null,
  targetItemId: string,
  blockedAt: number | null,
  now: number,
  cooldownMs: number
) => {
  if (blockedItemId !== targetItemId || blockedAt === null) {
    return true;
  }

  return now - blockedAt >= cooldownMs;
};

export const shouldBlockRepeatedApproval = (
  blockedItemId: string | null,
  targetItemId: string,
  blockedAt: number | null,
  now: number,
  cooldownMs: number
) =>
  blockedItemId === targetItemId &&
  blockedAt !== null &&
  now - blockedAt < cooldownMs;

export const clearApprovalBlockOnSelectionChange = <T extends {
  selectedIndex: number;
  blockedItemId: string | null;
  blockedReason: string | null;
  blockedAt: number | null;
  lastAction: "approve" | "reject" | null;
}>(
  previous: T,
  nextSelectedIndex: number
): Omit<
  T,
  "selectedIndex" | "blockedItemId" | "blockedReason" | "blockedAt" | "lastAction"
> & {
  selectedIndex: number;
  blockedItemId: string | null;
  blockedReason: string | null;
  blockedAt: number | null;
  lastAction: "approve" | "reject" | null;
} =>
  nextSelectedIndex === previous.selectedIndex
    ? previous
    : {
        ...previous,
        selectedIndex: nextSelectedIndex,
        blockedItemId: null,
        blockedReason: null,
        blockedAt: null,
        lastAction: null,
      };
