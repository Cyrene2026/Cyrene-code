import type { TokenUsage } from "./tokenUsage";
import type { QueryCompletionEvent } from "./streamProtocol";

export type QuerySessionStatus =
  | "idle"
  | "requesting"
  | "streaming"
  | "awaiting_review"
  | "error";

export type ToolCallLog = {
  toolName: string;
  input?: unknown;
};

export type QuerySessionState = {
  status: QuerySessionStatus;
  assistantText: string;
  toolCalls: ToolCallLog[];
  errorMessage: string | null;
  usage: TokenUsage | null;
  completion: Omit<QueryCompletionEvent, "type"> | null;
};

type QuerySessionEvent =
  | { type: "start" }
  | { type: "stream_open" }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolName: string; input?: unknown }
  | ({ type: "usage" } & TokenUsage)
  | QueryCompletionEvent
  | { type: "suspended" }
  | { type: "complete" }
  | { type: "fail"; message: string };

export const createQuerySessionState = (): QuerySessionState => ({
  status: "idle",
  assistantText: "",
  toolCalls: [],
  errorMessage: null,
  usage: null,
  completion: null,
});

export const querySessionReducer = (
  state: QuerySessionState,
  event: QuerySessionEvent
): QuerySessionState => {
  switch (event.type) {
    case "start":
      return {
        status: "requesting",
        assistantText: "",
        toolCalls: [],
        errorMessage: null,
        usage: null,
        completion: null,
      };
    case "stream_open":
      return {
        ...state,
        status: "streaming",
      };
    case "text_delta":
      return {
        ...state,
        assistantText: state.assistantText + event.text,
      };
    case "tool_call":
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          { toolName: event.toolName, input: event.input },
        ],
      };
    case "usage":
      return {
        ...state,
        usage: {
          promptTokens: event.promptTokens,
          cachedTokens: event.cachedTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
        },
      };
    case "completion":
      return {
        ...state,
        completion: {
          source: event.source,
          reason: event.reason,
          detail: event.detail,
          expected: event.expected,
        },
      };
    case "suspended":
      return {
        ...state,
        status: "awaiting_review",
      };
    case "complete":
      return {
        ...state,
        status: "idle",
      };
    case "fail":
      return {
        ...state,
        status: "error",
        errorMessage: event.message,
      };
  }
};

export type QuerySessionDispatch = (event: QuerySessionEvent) => void;
