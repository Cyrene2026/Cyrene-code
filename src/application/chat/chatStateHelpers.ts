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
