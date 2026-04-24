import type {
  QueryInput,
  QueryTransport,
} from "../../query/transport";
import type { QuerySessionState } from "../../query/sessionMachine";
import type { TokenUsage } from "../../query/tokenUsage";

export type RunQuerySessionToolResult = {
  message: string;
  metadata?: unknown;
};

export type RunQuerySessionToolCallResult = RunQuerySessionToolResult & {
  reviewMode?: "queue" | "block";
};

export type RunQuerySessionResumeInput = string | RunQuerySessionToolResult;

export type RunQuerySessionResult =
  | { status: "completed" }
  | {
      status: "suspended";
      resume: (
        toolResult: RunQuerySessionResumeInput
      ) => Promise<RunQuerySessionResult>;
    };

export type RunQuerySessionParams = {
  query: string | QueryInput;
  originalTask?: string;
  queryMaxToolSteps?: number;
  abortSignal?: AbortSignal;
  transport: QueryTransport;
  env?: NodeJS.ProcessEnv;
  onState: (state: QuerySessionState) => void;
  onTextDelta: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onToolStatus?: (message: string) => void;
  onToolCall: (
    toolName: string,
    input: unknown
  ) =>
    | Promise<RunQuerySessionToolCallResult>
    | RunQuerySessionToolCallResult;
  onError: (message: string) => void;
};
