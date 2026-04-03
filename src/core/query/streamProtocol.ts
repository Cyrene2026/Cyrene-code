import { z } from "zod";
import type { TokenUsage } from "./tokenUsage";

export type QueryStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolName: string; input?: unknown }
  | ({ type: "usage" } & TokenUsage)
  | { type: "done" };

const textDeltaSchema = z.object({
  type: z.literal("text_delta"),
  text: z.string(),
});

const toolCallSchema = z.object({
  type: z.literal("tool_call"),
  toolName: z.string(),
  input: z.unknown().optional(),
});

const usageSchema = z.object({
  type: z.literal("usage"),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const doneSchema = z.object({
  type: z.literal("done"),
});

const eventSchema = z.union([
  textDeltaSchema,
  toolCallSchema,
  usageSchema,
  doneSchema,
]);

const legacyTextSchema = z.object({
  delta: z.string(),
});

export const parseStreamChunk = (raw: string): QueryStreamEvent[] => {
  const normalized = raw.trim();
  if (!normalized) {
    return [];
  }

  if (normalized === "[DONE]") {
    return [{ type: "done" }];
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    const event = eventSchema.safeParse(parsed);
    if (event.success) {
      return [event.data];
    }

    const legacy = legacyTextSchema.safeParse(parsed);
    if (legacy.success) {
      return [{ type: "text_delta", text: legacy.data.delta }];
    }
  } catch {
    // Fallback to treating non-JSON chunks as plain text.
  }

  return [{ type: "text_delta", text: raw }];
};
