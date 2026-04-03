import type { TokenUsage } from "../../core/query/tokenUsage";

export const buildExitMessage = (
  sessionId: string | null,
  usage: TokenUsage | null
) => {
  const sessionLabel = sessionId ?? "-";
  const tokenLabel = usage
    ? `prompt ${usage.promptTokens} | completion ${usage.completionTokens} | total ${usage.totalTokens}`
    : "-";

  return `session ${sessionLabel} | tokens ${tokenLabel} | bye!`;
};

export const createExitHandler = (
  getSnapshot: () => { sessionId: string | null; usage: TokenUsage | null },
  write: (text: string) => void,
  exit: () => void
) => {
  let exiting = false;

  return () => {
    if (exiting) {
      return false;
    }
    exiting = true;
    const snapshot = getSnapshot();
    write(`${buildExitMessage(snapshot.sessionId, snapshot.usage)}\n`);
    exit();
    return true;
  };
};
