import { describe, expect, mock, test } from "bun:test";
import { handleSessionCommand } from "../src/application/chat/chatSessionCommandHandler";
import type {
  SessionMemoryIndex,
  SessionPromptContext,
} from "../src/core/session/memoryIndex";
import type { SessionStore } from "../src/core/session/store";
import type { SessionRecord } from "../src/core/session/types";

const createSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "session-1",
  title: "Checkpoint demo",
  createdAt: "2026-04-28T00:00:00.000Z",
  updatedAt: "2026-04-28T00:00:00.000Z",
  projectRoot: "/workspace/demo",
  summary: "",
  pendingDigest: "",
  pendingChoice: null,
  executionPlan: null,
  lastStateUpdate: null,
  inFlightTurn: null,
  focus: [],
  tags: [],
  messages: [],
  ...overrides,
});

const createStore = (session: SessionRecord): SessionStore => {
  let current = session;
  return {
    createSession: mock(async () => current),
    listSessions: mock(async () => []),
    searchSessions: mock(async () => []),
    loadSession: mock(async id => (id === current.id ? current : null)),
    appendMessage: mock(async () => current),
    updateSummary: mock(async (_id, summary) => {
      current = { ...current, summary };
      return current;
    }),
    updateWorkingState: mock(async (_id, state) => {
      current = {
        ...current,
        summary: state.summary ?? current.summary,
        pendingDigest: state.pendingDigest ?? current.pendingDigest,
        lastStateUpdate:
          state.lastStateUpdate === undefined
            ? current.lastStateUpdate
            : state.lastStateUpdate,
      };
      return current;
    }),
    updateInFlightTurn: mock(async (_id, inFlightTurn) => {
      current = { ...current, inFlightTurn };
      return current;
    }),
    updatePendingChoice: mock(async (_id, pendingChoice) => {
      current = { ...current, pendingChoice };
      return current;
    }),
    updateExecutionPlan: mock(async (_id, executionPlan) => {
      current = { ...current, executionPlan };
      return current;
    }),
    addFocus: mock(async (_id, note) => {
      current = { ...current, focus: [note, ...current.focus] };
      return current;
    }),
    removeFocus: mock(async (_id, index) => {
      current = {
        ...current,
        focus: current.focus.filter((_, itemIndex) => itemIndex !== index),
      };
      return current;
    }),
    addTag: mock(async (_id, tag) => {
      current = { ...current, tags: [...current.tags, tag] };
      return current;
    }),
    removeTag: mock(async (_id, tag) => {
      current = { ...current, tags: current.tags.filter(item => item !== tag) };
      return current;
    }),
    getMemoryIndex: mock(async (): Promise<SessionMemoryIndex> => ({
      version: 1,
      sessionId: current.id,
      updatedAt: current.updatedAt,
      entries: [],
      byKind: {},
      byPath: {},
      byTool: {},
      byAction: {},
      byPriority: [],
    })),
    recordMemory: mock(async () => current),
    recordMemories: mock(async () => current),
    rebuildMemoryIndex: mock(async () => current),
    getPromptContext: mock(async (): Promise<SessionPromptContext> => ({
      recent: [],
      relevantMemories: [],
      pins: current.focus,
      latestActionableUserMessage: "",
      durableSummary: current.summary,
      pendingDigest: current.pendingDigest,
      summaryFallback: "",
      summaryRecoveryNeeded: false,
      reducerMode: "merge_and_digest",
      executionPlan: current.executionPlan,
      interruptedTurn: null,
    })),
  };
};

const runCommand = async (
  query: string,
  session: SessionRecord,
  options: { pinMaxCount?: number } = {}
) => {
  const messages: string[] = [];
  const store = createStore(session);
  const handled = await handleSessionCommand({
    query,
    sessionStore: store,
    activeSessionId: session.id,
    systemPrompt: "system",
    defaultSystemPrompt: "default",
    pinMaxCount: options.pinMaxCount ?? 8,
    pushSystemMessage: text => messages.push(text),
    clearInput: () => {},
    setSystemPrompt: () => {},
    formatReducerStateMessage: () => "state",
    ensureActiveSession: mock(async () => session),
    startNewSession: mock(async () => {}),
    undoLastMutation: mock(async () => ({ ok: true, message: "undo" })),
    openSessionsPanel: () => {},
    openResumePicker: () => {},
    loadSessionIntoChat: mock(async () => {}),
  });
  return {
    handled,
    messages,
    store,
  };
};

describe("handleSessionCommand", () => {
  test("pins a checkpoint built from working state and execution plan", async () => {
    const session = createSession({
      summary: [
        "OBJECTIVE:",
        "- 完成 summary 辅助机制",
        "",
        "DECISIONS:",
        "- 决定添加手动 checkpoint pin",
      ].join("\n"),
      pendingDigest: [
        "ENTITY STATE:",
        "- `chatSessionCommandHandler.ts` 负责 session slash commands",
        "",
        "NEXT BEST ACTIONS:",
        "- 运行 checkpoint handler 测试",
      ].join("\n"),
      executionPlan: {
        capturedAt: "2026-04-28T00:00:00.000Z",
        sourcePreview: "checkpoint",
        projectRoot: "/workspace/demo",
        summary: "Add checkpoint",
        objective: "stabilize sessions",
        acceptedAt: "",
        acceptedSummary: "",
        steps: [
          {
            id: "step-1",
            title: "Implement command",
            details: "",
            status: "completed",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
          {
            id: "step-2",
            title: "Run tests",
            details: "",
            status: "in_progress",
            evidence: [],
            filePaths: [],
            recentToolResult: "",
          },
        ],
      },
    });

    const { handled, messages, store } = await runCommand(
      "/checkpoint before refactor",
      session
    );

    expect(handled).toBe(true);
    expect(store.addFocus).toHaveBeenCalledTimes(1);
    const pinned = (store.addFocus as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[1] as string;
    expect(pinned).toContain("Checkpoint");
    expect(pinned).toContain("note: before refactor");
    expect(pinned).toContain("plan: 1/2 completed; in_progress: Run tests");
    expect(pinned).toContain("objective: 完成 summary 辅助机制");
    expect(pinned).toContain("decisions: 决定添加手动 checkpoint pin");
    expect(pinned).toContain(
      "entity state: `chatSessionCommandHandler.ts` 负责 session slash commands"
    );
    expect(pinned).toContain("next actions: 运行 checkpoint handler 测试");
    expect(messages[0]).toContain("Checkpoint pinned");
  });

  test("refuses checkpoint when pin limit is reached", async () => {
    const session = createSession({ focus: ["existing"] });

    const { handled, messages, store } = await runCommand("/checkpoint", session, {
      pinMaxCount: 1,
    });

    expect(handled).toBe(true);
    expect(store.addFocus).not.toHaveBeenCalled();
    expect(messages[0]).toContain("Pin limit reached");
  });
});
