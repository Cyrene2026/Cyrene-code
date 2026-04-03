import { describe, expect, test } from "bun:test";
import {
  buildExitScreen,
  createExitHandler,
} from "../src/frontend/components/exitSummary";

describe("exitSummary", () => {
  test("renders a session summary card with runtime, request counts, tokens, and bye", () => {
    const screen = buildExitScreen(
      {
        startedAt: "2026-04-04T00:00:00.000Z",
        activeSessionId: "session-42",
        currentModel: "gpt-5.4",
        requestCount: 3,
        summaryRequestCount: 1,
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
      },
      {
        ansi: false,
        now: "2026-04-04T00:02:05.000Z",
      }
    );

    expect(screen).toContain("CYRENE | Session Summary");
    expect(screen).toMatch(/session\s+session-42/);
    expect(screen).toMatch(/model\s+gpt-5\.4/);
    expect(screen).toMatch(/runtime\s+2m 5s/);
    expect(screen).toMatch(/requests\s+3/);
    expect(screen).toMatch(/summary calls\s+1/);
    expect(screen).toMatch(/prompt\s+120/);
    expect(screen).toMatch(/completion\s+45/);
    expect(screen).toMatch(/total\s+165/);
    expect(screen).toContain("bye!");
  });

  test("renders stable zero values when no usage has been recorded yet", () => {
    const screen = buildExitScreen(
      {
        startedAt: "2026-04-04T00:00:00.000Z",
        activeSessionId: null,
        currentModel: "",
        requestCount: 0,
        summaryRequestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      {
        ansi: false,
        now: "2026-04-04T00:00:00.000Z",
      }
    );

    expect(screen).toMatch(/session\s+-/);
    expect(screen).toMatch(/model\s+-/);
    expect(screen).toMatch(/runtime\s+0s/);
    expect(screen).toMatch(/requests\s+0/);
    expect(screen).toMatch(/summary calls\s+0/);
    expect(screen).toMatch(/prompt\s+0/);
    expect(screen).toMatch(/completion\s+0/);
    expect(screen).toMatch(/total\s+0/);
  });

  test("createExitHandler clears the screen, writes once, and exits once", () => {
    const writeCalls: string[] = [];
    let exitCount = 0;
    const handleExit = createExitHandler(
      () => ({
        startedAt: "2026-04-04T00:00:00.000Z",
        activeSessionId: "session-42",
        currentModel: "gpt-5.4",
        requestCount: 2,
        summaryRequestCount: 1,
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      }),
      text => {
        writeCalls.push(text);
      },
      () => {
        exitCount += 1;
      },
      {
        ansi: true,
        now: () => "2026-04-04T00:00:03.000Z",
      }
    );

    expect(handleExit()).toBe(true);
    expect(handleExit()).toBe(false);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.startsWith("\x1b[2J\x1b[H")).toBe(true);
    expect(writeCalls[0]).toContain("Session Summary");
    expect(writeCalls[0]).toContain("bye!");
    expect(exitCount).toBe(1);
  });
});
