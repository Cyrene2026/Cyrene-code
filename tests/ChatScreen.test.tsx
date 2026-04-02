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

const pending: PendingReviewItem[] = [
  {
    id: "p1",
    request: {
      action: "edit_file",
      path: "src/example.ts",
      find: "old",
      replace: "new",
    },
    preview: "preview",
    previewSummary: "+ new",
    previewFull: "+ new\n- old",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const renderScreen = (approvalActive: boolean) =>
  create(
    <ChatScreen
      items={[{ role: "system", text: "Tool: write_file src/a.ts | ok", kind: "tool_status", tone: "info" }]}
      status="idle"
      input=""
      resumePicker={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
      sessionsPanel={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
      modelPicker={{ active: false, models: [], selectedIndex: 0, pageSize: 8 }}
      pendingReviews={approvalActive ? pending : []}
      approvalPanel={{
        active: approvalActive,
        selectedIndex: 0,
        previewMode: "summary",
        previewOffset: 0,
        lastOpenedAt: null,
        blockedItemId: null,
        blockedReason: null,
        blockedAt: null,
        lastAction: null,
      }}
      activeSessionId="session-1"
      currentModel="gpt-test"
      onInputChange={() => {}}
      onSubmit={() => {}}
    />
  );

describe("ChatScreen", () => {
  test("approval mode renders focused approval view", () => {
    const tree = renderScreen(true).toJSON();
    const output = JSON.stringify(tree);

    expect(output).toContain("Code Approval");
    expect(output).not.toContain("Conversation");
    expect(output).toContain("approval panel active");
  });

  test("normal mode renders conversation and input", () => {
    const tree = renderScreen(false).toJSON();
    const output = JSON.stringify(tree);

    expect(output).toContain("Conversation");
    expect(output).toContain("Tool: write_file src/a.ts | ok");
    expect(output).toContain("Ask something...");
  });

  test("streaming mode shows working status and spinner text", () => {
    const tree = create(
      <ChatScreen
        items={[{ role: "assistant", text: "working", kind: "transcript", tone: "neutral" }]}
        status="streaming"
        input=""
        resumePicker={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
        sessionsPanel={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
        modelPicker={{ active: false, models: [], selectedIndex: 0, pageSize: 8 }}
        pendingReviews={[]}
        approvalPanel={{
          active: false,
          selectedIndex: 0,
          previewMode: "summary",
          previewOffset: 0,
          lastOpenedAt: null,
          blockedItemId: null,
          blockedReason: null,
          blockedAt: null,
          lastAction: null,
        }}
        activeSessionId="session-1"
        currentModel="gpt-test"
        onInputChange={() => {}}
        onSubmit={() => {}}
      />
    ).toJSON();

    const output = JSON.stringify(tree);
    expect(output).toContain("WORKING");
    expect(output).toContain("Thinking");
  });

  test("renders approval queue summary, diff preview and code block text", () => {
    const tree = create(
      <ChatScreen
        items={[
          {
            role: "assistant",
            text: "```ts\nconst value = 1\n```\n+ added line",
            kind: "transcript",
            tone: "neutral",
          },
        ]}
        status="idle"
        input=""
        resumePicker={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
        sessionsPanel={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
        modelPicker={{ active: false, models: [], selectedIndex: 0, pageSize: 8 }}
        pendingReviews={pending}
        approvalPanel={{
          active: false,
          selectedIndex: 0,
          previewMode: "summary",
          previewOffset: 0,
          lastOpenedAt: null,
          blockedItemId: null,
          blockedReason: null,
          blockedAt: null,
          lastAction: null,
        }}
        activeSessionId="session-1"
        currentModel="gpt-test"
        onInputChange={() => {}}
        onSubmit={() => {}}
      />
    ).toJSON();

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
    const tree = create(
      <ChatScreen
        items={[]}
        status="idle"
        input=""
        resumePicker={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
        sessionsPanel={{ active: false, sessions: [], selectedIndex: 0, pageSize: 8 }}
        modelPicker={{ active: false, models: [], selectedIndex: 0, pageSize: 8 }}
        pendingReviews={pending}
        approvalPanel={{
          active: true,
          selectedIndex: 0,
          previewMode: "summary",
          previewOffset: 0,
          lastOpenedAt: null,
          blockedItemId: "p1",
          blockedReason: "EEXIST: file already exists",
          blockedAt: Date.now(),
          lastAction: "approve",
        }}
        activeSessionId="session-1"
        currentModel="gpt-test"
        onInputChange={() => {}}
        onSubmit={() => {}}
      />
    ).toJSON();

    const output = JSON.stringify(tree);
    expect(output).toContain("Last error:");
    expect(output).toContain("EEXIST");
    expect(output).toContain("blocked");
    expect(output).toContain("r/d reject");
  });
});
