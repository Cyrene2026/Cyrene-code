import { ExecutionRuntime } from "./ExecutionRuntime";
import type {
  RunQuerySessionParams,
  RunQuerySessionResult,
  RunQuerySessionResumeInput,
  RunQuerySessionToolCallResult,
  RunQuerySessionToolResult,
} from "./ExecutionTypes";

export type {
  RunQuerySessionParams,
  RunQuerySessionResult,
  RunQuerySessionResumeInput,
  RunQuerySessionToolCallResult,
  RunQuerySessionToolResult,
};

export const runQuerySession = async (
  params: RunQuerySessionParams
): Promise<RunQuerySessionResult> => new ExecutionRuntime(params).run();
