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
  transport: QueryTransport;
  onState: (state: QuerySessionState) => void;
  onTextDelta: (text: string) => void;
  onToolCall: (
    toolName: string,
    input: unknown
  ) => Promise<{ message: string; halt?: boolean }> | { message: string; halt?: boolean };
  onError: (message: string) => void;
};

export const runQuerySession = async ({
  query,
  transport,
  onState,
  onTextDelta,
  onToolCall,
  onError,
}: RunQuerySessionParams) => {
  let state = createQuerySessionState();
  const originalTask = query;
  const dispatch: QuerySessionDispatch = event => {
    state = querySessionReducer(state, event);
    onState(state);
  };

  dispatch({ type: "start" });

  try {
    let roundPrompt = query;
    const maxRounds = 6;
    const repeatedToolCallCount = new Map<string, number>();
    let loopCorrection = "";
    let needsReviewFinalization = false;
    let reviewFinalizationUsed = false;

    for (let round = 0; round < maxRounds; round += 1) {
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
            if (reviewFinalizationUsed) {
              onTextDelta(
                `\n[tool blocked] review is pending. Use /approve or /reject first.\n`
              );
              dispatch({ type: "complete" });
              return;
            }
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
              return;
            }
            dispatch({
              type: "tool_call",
              toolName: event.toolName,
              input: event.input,
            });
            const toolResult = await onToolCall(event.toolName, event.input);
            toolResults.push(
              `[tool_result] ${event.toolName}\n${toolResult.message}`.trim()
            );
            if (toolResult.halt) {
              needsReviewFinalization = true;
            }
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
        return;
      }

      const resultsBlock = toolResults.join("\n\n");
      if (needsReviewFinalization) {
        roundPrompt = [
          "A file operation is pending human review.",
          "Do not call any tools.",
          "Briefly summarize what is pending, then ask user to run /review and /approve <id> or /reject <id>.",
          "Then stop.",
          "",
          "Pending operation details:",
          resultsBlock || "(none)",
        ].join("\n");
        needsReviewFinalization = false;
        reviewFinalizationUsed = true;
        continue;
      }
      roundPrompt = [
        "Original user task:",
        originalTask,
        "",
        "Continue based on tool results while staying strictly on the original task.",
        "Do not inspect unrelated files unless required for the task.",
        loopCorrection ? `\n${loopCorrection}\n` : "",
        "Tool results:",
        resultsBlock || "(none)",
        "If more tool usage is needed, call tools again. Otherwise provide final answer.",
      ].join("\n\n");
    }

    dispatch({ type: "complete" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "fail", message });
    onError(message);
  }
};
