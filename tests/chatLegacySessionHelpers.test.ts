import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/core/session/types";
import {
  hasLegacyCompressedMarkdown,
  isLikelyLegacyCompressedMarkdown,
} from "../src/application/chat/chatLegacySessionHelpers";

const createSession = (assistantText: string): SessionRecord => ({
  id: "session-1",
  title: "Example",
  createdAt: "2026-04-09T00:00:00.000Z",
  updatedAt: "2026-04-09T00:00:00.000Z",
  projectRoot: null,
  summary: "",
  pendingDigest: "",
  pendingChoice: null,
  executionPlan: null,
  lastStateUpdate: null,
  inFlightTurn: null,
  focus: [],
  tags: [],
  messages: [
    {
      role: "assistant",
      text: assistantText,
      createdAt: "2026-04-09T00:00:00.000Z",
    },
  ],
});

describe("chatLegacySessionHelpers", () => {
  test("detects compressed single-line markdown with multiple signals", () => {
    expect(
      isLikelyLegacyCompressedMarkdown("# Title **bold** - item ... ```ts")
    ).toBe(true);
    expect(isLikelyLegacyCompressedMarkdown("# Title\n- item")).toBe(false);
  });

  test("finds legacy compressed markdown in assistant transcript", () => {
    expect(hasLegacyCompressedMarkdown(createSession("# Title **bold** - item"))).toBe(
      true
    );
    expect(hasLegacyCompressedMarkdown(createSession("plain text only"))).toBe(false);
  });
});
