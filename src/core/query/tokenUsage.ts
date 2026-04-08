export type TokenUsage = {
  promptTokens: number;
  cachedTokens?: number;
  completionTokens: number;
  totalTokens: number;
};
