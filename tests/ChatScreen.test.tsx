import React from "react";
import { describe, expect, mock, test } from "bun:test";
import { create } from "react-test-renderer";
import type { PendingReviewItem } from "../src/core/tools/mcp/types";

mock.module("ink", () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useInput: () => {},
  useStdin: () => ({
    stdin: {
      on: () => {},
      off: () => {},
    },
    setRawMode: () => {},
    isRawModeSupported: false,
  }),
}));

mock.module("ink-text-input", () => ({
  default: ({ placeholder }: { placeholder?: string }) => <input placeholder={placeholder} />,
}));

const { ChatScreen } = await import("../src/frontend/components/ChatScreen");

const editPending: PendingReviewItem = {
  id: "p1",
  request: {
    action: "edit_file",
    path: "src/example.ts",
    find: "old",
    replace: "new",
  },
  preview: "preview",
  previewSummary:
    "[edit preview]\n[old - to be removed]\n- 12 | oldValue\n[new + to be written]\n+ 12 | newValue\n@@ replacement",
  previewFull:
    "[edit preview]\n[old - to be removed]\n- 12 | const oldValue = 1;\n[new + to be written]\n+ 12 | const newValue = 2;\n@@ replacement",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const movePending: PendingReviewItem = {
  id: "p2",
  request: {
    action: "move_path",
    path: "src/old.ts",
    destination: "src/new.ts",
  },
  preview: "preview",
  previewSummary: "[move preview]\nsource: src/old.ts\ndestination: src/new.ts",
  previewFull: "[move preview]\nsource: src/old.ts\ndestination: src/new.ts",
  createdAt: "2026-01-01T00:01:00.000Z",
};

const commandPending: PendingReviewItem = {
  id: "p3",
  request: {
    action: "run_command",
    path: ".",
    command: "bun",
    args: ["test", "tests/ChatScreen.test.tsx"],
    cwd: "test_files",
  },
  preview: "preview",
  previewSummary:
    "[command preview]\ncommand: bun\nargs: test tests/ChatScreen.test.tsx\ncwd: test_files\nmode: summary",
  previewFull:
    "[command preview]\ncommand: bun\nargs: test tests/ChatScreen.test.tsx\ncwd: test_files\nmode: full",
  createdAt: "2026-01-01T00:02:00.000Z",
};

const buildProps = (
  overrides: Partial<React.ComponentProps<typeof ChatScreen>> = {}
): React.ComponentProps<typeof ChatScreen> => ({
  items: [
    {
      role: "system" as const,
      text: "Tool: write_file src/a.ts | ok",
      kind: "tool_status" as const,
      tone: "info" as const,
    },
  ],
  status: "idle" as const,
  input: "",
  inputCommandState: {
    active: false,
    currentCommand: null,
    suggestions: [],
    historyPosition: null,
    historySize: 0,
  },
  resumePicker: { active: false, sessions: [], selectedIndex: 0, pageSize: 8 },
  sessionsPanel: { active: false, sessions: [], selectedIndex: 0, pageSize: 8 },
  modelPicker: { active: false, models: [], selectedIndex: 0, pageSize: 8 },
  pendingReviews: [],
  approvalPanel: {
    active: false,
    selectedIndex: 0,
    previewMode: "summary" as const,
    previewOffset: 0,
    lastOpenedAt: null,
    blockedItemId: null,
    blockedReason: null,
    blockedAt: null,
    lastAction: null,
    inFlightId: null,
    actionState: null,
    resumePending: false,
  },
  activeSessionId: "session-1",
  currentModel: "gpt-test",
  onInputChange: () => {},
  onSubmit: () => {},
  ...overrides,
});

const renderScreen = (overrides: Partial<React.ComponentProps<typeof ChatScreen>> = {}) =>
  create(<ChatScreen {...buildProps(overrides)} />).toJSON();

describe("ChatScreen", () => {
  test("approval mode renders focused approval view with enhanced diff structure", () => {
    const tree = renderScreen({
      pendingReviews: [editPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Code Approval");
    expect(output).not.toContain("Conversation");
    expect(output).toContain("approval panel active");
    expect(output).toContain("Action summary");
    expect(output).toContain("Diff preview");
    expect(output).toContain("Section");
    expect(output).toContain("Hunk");
    expect(output).toContain("newValue");
  });

  test("normal mode renders conversation and input", () => {
    const tree = renderScreen();
    const output = JSON.stringify(tree);

    expect(output).toContain("Conversation");
    expect(output).toContain("Tool: write_file src/a.ts | ok");
    expect(output).toContain("Ask something...");
  });

  test("streaming mode shows working status and spinner text", () => {
    const tree = renderScreen({
      items: [{ role: "assistant", text: "working", kind: "transcript", tone: "neutral" }],
      status: "streaming",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("WORKING");
    expect(output).toContain("Thinking");
  });

  test("renders approval queue summary, diff preview and code block text", () => {
    const tree = renderScreen({
      items: [
        {
          role: "assistant",
          text: "```ts\nconst value = 1\n```\n+ added line",
          kind: "transcript",
          tone: "neutral",
        },
      ],
      pendingReviews: [editPending],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Approval Queue");
    expect(output).toContain("edit_file  |  src/example.ts");
    expect(output).toContain("code | ts");
    expect(output).toContain("const");
    expect(output).toContain("value");
    expect(output).toContain("\"1\"");
    expect(output).toContain("+ added line");
  });

  test("renders blocked approval state and error hint", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [editPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
        blockedItemId: "p1",
        blockedReason: "EEXIST: file already exists",
        blockedAt: Date.now(),
        lastAction: "approve",
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Last error:");
    expect(output).toContain("EEXIST");
    expect(output).toContain("blocked");
    expect(output).toContain("r/d reject");
    expect(output).toContain("State");
  });

  test("renders move approval with source and destination cards", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [movePending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Path preview");
    expect(output).toContain("Destination");
    expect(output).toContain("src/new.ts");
    expect(output).toContain("Source");
  });

  test("renders run_command approval as command preview card", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [commandPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Command preview");
    expect(output).toContain("Command");
    expect(output).toContain("Args");
    expect(output).toContain("Cwd");
    expect(output).toContain("test tests/ChatScreen.test.tsx");
    expect(output).toContain("test_files");
  });

  test("renders slash command hints and history indicator", () => {
    const tree = renderScreen({
      items: [],
      input: "/mo",
      inputCommandState: {
        active: true,
        currentCommand: "/mo",
        suggestions: [
          { command: "/model", description: "open model picker" },
          { command: "/model refresh", description: "refresh available models" },
        ],
        historyPosition: 2,
        historySize: 5,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Slash commands");
    expect(output).toContain("/model");
    expect(output).toContain("/model refresh");
    expect(output).toContain("History 2/5");
  });
});
