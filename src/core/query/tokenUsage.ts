export type TokenUsage = {
  promptTokens: number;
  cachedTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  completionTokens: number;
  totalTokens: number;
};

export const getCachedTokenCount = (usage: { cachedTokens?: number } | null | undefined) =>
  Math.max(0, usage?.cachedTokens ?? 0);

export const getUncachedPromptTokenCount = (
  usage: { promptTokens: number; cachedTokens?: number } | null | undefined
) => {
  if (!usage) {
    return 0;
  }

  return Math.max(0, usage.promptTokens - getCachedTokenCount(usage));
};
