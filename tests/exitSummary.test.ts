import { describe, expect, test } from "bun:test";
import {
  buildExitMessage,
  createExitHandler,
} from "../src/frontend/components/exitSummary";

describe("exitSummary", () => {
  test("includes session id, token usage and bye", () => {
    expect(
      buildExitMessage("session-42", {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      })
    ).toBe("session session-42 | tokens prompt 12 | completion 5 | total 17 | bye!");
  });

  test("falls back when session id or usage is unavailable", () => {
    expect(buildExitMessage(null, null)).toBe("session - | tokens - | bye!");
  });

  test("createExitHandler writes once and exits once", () => {
    const writeCalls: string[] = [];
    let exitCount = 0;
    const handleExit = createExitHandler(
      () => ({
        sessionId: "session-42",
        usage: {
          promptTokens: 12,
          completionTokens: 5,
          totalTokens: 17,
        },
      }),
      text => {
        writeCalls.push(text);
      },
      () => {
        exitCount += 1;
      }
    );

    expect(handleExit()).toBe(true);
    expect(handleExit()).toBe(false);
    expect(writeCalls).toEqual([
      "session session-42 | tokens prompt 12 | completion 5 | total 17 | bye!\n",
    ]);
    expect(exitCount).toBe(1);
  });
});
