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
  onToolCall: (toolName: string, input: unknown) => void;
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
  const dispatch: QuerySessionDispatch = event => {
    state = querySessionReducer(state, event);
    onState(state);
  };

  dispatch({ type: "start" });

  try {
    const streamUrl = await transport.requestStreamUrl(query);
    let completed = false;

    for await (const chunk of transport.stream(streamUrl)) {
      const events = parseStreamChunk(chunk);
      for (const event of events) {
        if (event.type === "text_delta") {
          dispatch({ type: "text_delta", text: event.text });
          onTextDelta(event.text);
          continue;
        }

        if (event.type === "tool_call") {
          dispatch({
            type: "tool_call",
            toolName: event.toolName,
            input: event.input,
          });
          onToolCall(event.toolName, event.input);
          continue;
        }

        if (event.type === "done") {
          completed = true;
          dispatch({ type: "complete" });
          break;
        }
      }

      if (completed) {
        break;
      }
    }

    if (!completed) {
      dispatch({ type: "complete" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "fail", message });
    onError(message);
  }
};

