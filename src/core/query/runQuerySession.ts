import { parseStreamChunk } from "./streamProtocol";
import {
  createQuerySessionState,
  querySessionReducer,
  type QuerySessionDispatch,
  type QuerySessionState,
} from "./sessionMachine";
import type { QueryTransport } from "./transport";

type RunQuerySessionParams = {
  query: string;
  originalTask?: string;
  transport: QueryTransport;
  onState: (state: QuerySessionState) => void;
  onTextDelta: (text: string) => void;
  onToolCall: (
    toolName: string,
    input: unknown
  ) =>
    | Promise<{ message: string; reviewMode?: "queue" | "block" }>
    | { message: string; reviewMode?: "queue" | "block" };
  onError: (message: string) => void;
};

export type RunQuerySessionResult =
  | { status: "completed" }
  | {
      status: "suspended";
      resume: (toolResultMessage: string) => Promise<RunQuerySessionResult>;
    };

const buildRoundPrompt = (
  originalTask: string,
  toolResults: string[],
  loopCorrection: string
) =>
  [
    "Original user task:",
    originalTask,
    "",
    "Continue based on tool results while staying strictly on the original task.",
    "Do not inspect unrelated files unless required for the task.",
    loopCorrection ? `\n${loopCorrection}\n` : "",
    "Tool results:",
    toolResults.join("\n\n") || "(none)",
    "If more tool usage is needed, call tools again. Otherwise provide final answer.",
  ].join("\n\n");

export const runQuerySession = async ({
  query,
  originalTask,
  transport,
  onState,
  onTextDelta,
  onToolCall,
  onError,
}: RunQuerySessionParams): Promise<RunQuerySessionResult> => {
  let state = createQuerySessionState();
  const task = originalTask ?? query;
  const dispatch: QuerySessionDispatch = event => {
    state = querySessionReducer(state, event);
    onState(state);
  };

  const maxRounds = 6;

  const runRounds = async (
    roundPrompt: string,
    roundStart: number,
    repeatedToolCallCount: Map<string, number>,
    loopCorrection: string,
    accumulatedToolResults: string[]
  ): Promise<RunQuerySessionResult> => {
    dispatch({ type: "start" });

    for (let round = roundStart; round < maxRounds; round += 1) {
      const streamUrl = await transport.requestStreamUrl(roundPrompt);
      let completed = false;
      let sawToolCall = false;
      const toolResults: string[] = [];

      for await (const chunk of transport.stream(streamUrl)) {
        const events = parseStreamChunk(chunk);
        for (const event of events) {
          if (event.type === "text_delta") {
            dispatch({ type: "text_delta", text: event.text });
            onTextDelta(event.text);
            continue;
          }

          if (event.type === "tool_call") {
            sawToolCall = true;
            const signature = `${event.toolName}:${JSON.stringify(event.input ?? {})}`;
            const seen = (repeatedToolCallCount.get(signature) ?? 0) + 1;
            repeatedToolCallCount.set(signature, seen);
            if (seen >= 2) {
              loopCorrection = [
                "Loop warning:",
                `Tool call was repeated: ${signature}`,
                "Do NOT call the same tool with the same input again.",
                "Choose the next concrete step toward completing the original task.",
              ].join("\n");
            }
            if (seen >= 4) {
              onTextDelta(
                `\n[tool loop detected] ${event.toolName} was called repeatedly with same input. Stopping to prevent infinite loop.\n`
              );
              dispatch({ type: "complete" });
              return { status: "completed" };
            }
            dispatch({
              type: "tool_call",
              toolName: event.toolName,
              input: event.input,
            });
            const toolResult = await onToolCall(event.toolName, event.input);
            if (toolResult.reviewMode) {
              dispatch({ type: "suspended" });
              return {
                status: "suspended",
                resume: async (toolResultMessage: string) => {
                  const nextToolResults = [
                    ...accumulatedToolResults,
                    ...toolResults,
                    `[tool_result] ${event.toolName}\n${toolResultMessage}`.trim(),
                  ];
                  const nextPrompt = buildRoundPrompt(
                    task,
                    nextToolResults,
                    loopCorrection
                  );
                  return runRounds(
                    nextPrompt,
                    round + 1,
                    repeatedToolCallCount,
                    loopCorrection,
                    nextToolResults
                  );
                },
              };
            }
            toolResults.push(
              `[tool_result] ${event.toolName}\n${toolResult.message}`.trim()
            );
            continue;
          }

          if (event.type === "done") {
            completed = true;
            break;
          }
        }

        if (completed) {
          break;
        }
      }

      if (!sawToolCall) {
        dispatch({ type: "complete" });
        return { status: "completed" };
      }

      accumulatedToolResults = [...accumulatedToolResults, ...toolResults];
      roundPrompt = buildRoundPrompt(task, accumulatedToolResults, loopCorrection);
    }

    dispatch({ type: "complete" });
    return { status: "completed" };
  };

  try {
    return await runRounds(query, 0, new Map<string, number>(), "", []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "fail", message });
    onError(message);
    return { status: "completed" };
  }
};
