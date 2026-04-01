export type QuerySessionStatus = "idle" | "streaming" | "error";

export type ToolCallLog = {
  toolName: string;
  input?: unknown;
};

export type QuerySessionState = {
  status: QuerySessionStatus;
  assistantText: string;
  toolCalls: ToolCallLog[];
  errorMessage: string | null;
};

type QuerySessionEvent =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolName: string; input?: unknown }
  | { type: "complete" }
  | { type: "fail"; message: string };

export const createQuerySessionState = (): QuerySessionState => ({
  status: "idle",
  assistantText: "",
  toolCalls: [],
  errorMessage: null,
});

export const querySessionReducer = (
  state: QuerySessionState,
  event: QuerySessionEvent
): QuerySessionState => {
  switch (event.type) {
    case "start":
      return {
        status: "streaming",
        assistantText: "",
        toolCalls: [],
        errorMessage: null,
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

