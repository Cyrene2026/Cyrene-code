import { describe, expect, test } from "bun:test";
import {
  buildExitScreen,
  createExitHandler,
} from "../src/frontend/components/exitSummary";

const baseSnapshot = {
  startedAt: "2026-04-04T00:00:00.000Z",
  activeSessionId: "session-42",
  currentModel: "gpt-5.4",
  requestCount: 2,
  summaryRequestCount: 1,
  promptTokens: 12,
  completionTokens: 5,
  totalTokens: 17,
};

const createMockStdin = (isTTY = true) => {
  const listeners = new Set<(chunk: Buffer | string) => void>();
  return {
    isTTY,
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      listeners.add(listener);
    },
    off: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      listeners.delete(listener);
    },
    emit: (chunk: string) => {
      for (const listener of listeners) {
        listener(chunk);
      }
    },
  };
};

const createMockSignalTarget = () => {
  const listeners = new Set<() => void>();
  return {
    on: (_event: "SIGINT", listener: () => void) => {
      listeners.add(listener);
    },
    off: (_event: "SIGINT", listener: () => void) => {
      listeners.delete(listener);
    },
    emit: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

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

  test("createExitHandler confirm mode writes summary + hint, exits gracefully once, and waits for confirm", () => {
    const writeCalls: string[] = [];
    const callOrder: string[] = [];
    let exitCount = 0;
    let forceExitCount = 0;
    const handleExit = createExitHandler(
      () => baseSnapshot,
      text => {
        callOrder.push("write");
        writeCalls.push(text);
      },
      () => {
        callOrder.push("exit");
        exitCount += 1;
      },
      {
        ansi: true,
        now: () => "2026-04-04T00:00:03.000Z",
        confirmBeforeExit: true,
        confirmTimeoutMs: 0,
        forceExit: () => {
          forceExitCount += 1;
        },
      }
    );

    expect(handleExit()).toBe(true);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.startsWith("\x1b[2J\x1b[H")).toBe(true);
    expect(writeCalls[0]).toContain("Session Summary");
    expect(writeCalls[0]).toContain("Press Enter or Ctrl+C to exit");
    expect(writeCalls[0]).toContain("bye!");
    expect(exitCount).toBe(1);
    expect(forceExitCount).toBe(0);
    expect(callOrder).toEqual(["exit", "write"]);
  });

  test("createExitHandler confirm mode finalizes on Enter once and ignores repeated triggers after finalize", () => {
    const stdin = createMockStdin(true);
    const signalTarget = createMockSignalTarget();
    let forceExitCount = 0;
    let exitCount = 0;
    const handleExit = createExitHandler(
      () => baseSnapshot,
      () => {},
      () => {
        exitCount += 1;
      },
      {
        ansi: false,
        confirmBeforeExit: true,
        confirmTimeoutMs: 100,
        forceExit: () => {
          forceExitCount += 1;
        },
        stdin,
        signalTarget,
      }
    );

    expect(handleExit()).toBe(true);
    stdin.emit("\n");
    expect(forceExitCount).toBe(1);
    expect(exitCount).toBe(1);
    expect(handleExit()).toBe(false);
    stdin.emit("\n");
    signalTarget.emit();
    expect(forceExitCount).toBe(1);
  });

  test("createExitHandler confirm mode finalizes on second Ctrl+C trigger", () => {
    let forceExitCount = 0;
    let exitCount = 0;
    const handleExit = createExitHandler(
      () => baseSnapshot,
      () => {},
      () => {
        exitCount += 1;
      },
      {
        ansi: false,
        confirmBeforeExit: true,
        confirmTimeoutMs: 0,
        forceExit: () => {
          forceExitCount += 1;
        },
      }
    );

    expect(handleExit()).toBe(true);
    expect(handleExit()).toBe(true);
    expect(handleExit()).toBe(false);
    expect(exitCount).toBe(1);
    expect(forceExitCount).toBe(1);
  });

  test("createExitHandler confirm mode finalizes on SIGINT from signal target", () => {
    const stdin = createMockStdin(true);
    const signalTarget = createMockSignalTarget();
    let forceExitCount = 0;
    const handleExit = createExitHandler(
      () => baseSnapshot,
      () => {},
      () => {},
      {
        ansi: false,
        confirmBeforeExit: true,
        confirmTimeoutMs: 100,
        forceExit: () => {
          forceExitCount += 1;
        },
        stdin,
        signalTarget,
      }
    );

    expect(handleExit()).toBe(true);
    signalTarget.emit();
    expect(forceExitCount).toBe(1);
    signalTarget.emit();
    expect(forceExitCount).toBe(1);
  });

  test("createExitHandler confirm mode timeout triggers force-exit once", async () => {
    const stdin = createMockStdin(false);
    const signalTarget = createMockSignalTarget();
    let forceExitCount = 0;
    const handleExit = createExitHandler(
      () => baseSnapshot,
      () => {},
      () => {},
      {
        ansi: false,
        confirmBeforeExit: true,
        confirmTimeoutMs: 10,
        forceExit: () => {
          forceExitCount += 1;
        },
        stdin,
        signalTarget,
      }
    );

    expect(handleExit()).toBe(true);
    stdin.emit("\n");
    expect(forceExitCount).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(forceExitCount).toBe(1);
  });

  test("createExitHandler immediate mode stays backward-compatible", () => {
    const writeCalls: string[] = [];
    const callOrder: string[] = [];
    let exitCount = 0;
    let forceExitCount = 0;
    const handleExit = createExitHandler(
      () => baseSnapshot,
      text => {
        callOrder.push("write");
        writeCalls.push(text);
      },
      () => {
        callOrder.push("exit");
        exitCount += 1;
      },
      {
        ansi: false,
        confirmBeforeExit: false,
        forceExit: () => {
          forceExitCount += 1;
        },
      }
    );

    expect(handleExit()).toBe(true);
    expect(handleExit()).toBe(false);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).not.toContain("Press Enter or Ctrl+C to exit");
    expect(exitCount).toBe(1);
    expect(forceExitCount).toBe(0);
    expect(callOrder).toEqual(["exit", "write"]);
  });
});
