import { describe, expect, test } from "bun:test";
import {
  getCachedTokenCount,
  getUncachedPromptTokenCount,
} from "../src/core/query/tokenUsage";

describe("tokenUsage helpers", () => {
  test("getCachedTokenCount defaults missing cached tokens to zero", () => {
    expect(getCachedTokenCount(undefined)).toBe(0);
    expect(getCachedTokenCount(null)).toBe(0);
    expect(getCachedTokenCount({})).toBe(0);
    expect(getCachedTokenCount({ cachedTokens: 42 })).toBe(42);
  });

  test("getUncachedPromptTokenCount subtracts cached tokens and clamps at zero", () => {
    expect(getUncachedPromptTokenCount(undefined)).toBe(0);
    expect(
      getUncachedPromptTokenCount({
        promptTokens: 128,
        cachedTokens: 96,
      })
    ).toBe(32);
    expect(
      getUncachedPromptTokenCount({
        promptTokens: 10,
        cachedTokens: 99,
      })
    ).toBe(0);
  });
});
