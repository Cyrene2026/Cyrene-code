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

const {
  ChatScreen,
  isTranscriptDiffLine,
  parseInlineCodeSegments,
  parseMarkdownBlocks,
} = await import("../src/frontend/components/ChatScreen");

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
    "[process preview]\ncommand: bun\nargs: test tests/ChatScreen.test.tsx\ncwd: test_files\nmode: summary",
  previewFull:
    "[process preview]\ncommand: bun\nargs: test tests/ChatScreen.test.tsx\ncwd: test_files\nmode: full",
  createdAt: "2026-01-01T00:02:00.000Z",
};

const shellPending: PendingReviewItem = {
  id: "p4",
  request: {
    action: "run_shell",
    path: ".",
    command: "Get-ChildItem test_files",
    cwd: ".",
  },
  preview: "preview",
  previewSummary:
    "[shell preview]\nshell: pwsh\ncommand: Get-ChildItem test_files\ncwd: .\nrisk: low\ntokens: Get-ChildItem test_files\nnote: Only a safe single-command shell subset is allowed.\nmode: summary",
  previewFull:
    "[shell preview]\nshell: pwsh\ncommand: Get-ChildItem test_files\ncwd: .\nrisk: low\ntokens: Get-ChildItem test_files\nnote: Only a safe single-command shell subset is allowed.\nmode: full",
  createdAt: "2026-01-01T00:03:00.000Z",
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
  liveAssistantText: "",
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
  usage: null,
  onInputChange: () => {},
  onSubmit: () => {},
  ...overrides,
});

const renderScreen = (overrides: Partial<React.ComponentProps<typeof ChatScreen>> = {}) =>
  create(<ChatScreen {...buildProps(overrides)} />).toJSON();

describe("ChatScreen", () => {
  test("treats markdown bullet lines as normal transcript, not diff lines", () => {
    expect(
      isTranscriptDiffLine("- `ItemCreate` and `Token` are not used yet.", {
        prev: "- first bullet",
        next: "- next bullet",
      })
    ).toBe(false);
    expect(
      isTranscriptDiffLine("- oldValue", {
        prev: "@@ replacement",
        next: "+ newValue",
      })
    ).toBe(true);
  });

  test("parses inline code spans separately from正文文本", () => {
    expect(parseInlineCodeSegments("实现 `/oauth/token`，并复用 `Token` 模型。")).toEqual([
      { text: "实现 ", isCode: false },
      { text: "/oauth/token", isCode: true },
      { text: "，并复用 ", isCode: false },
      { text: "Token", isCode: true },
      { text: " 模型。", isCode: false },
    ]);
  });

  test("parses headings, lists, rules and code blocks into markdown blocks", () => {
    expect(
      parseMarkdownBlocks([
        "## 创建 FastAPI 应用",
        "",
        "这是一段说明，",
        "下一行应并入同一段。",
        "",
        "---",
        "",
        "1. 第一项",
        "2. 第二项",
        "",
        "- 普通列表",
        "- `Token` 模型",
        "",
        "```py",
        "app = FastAPI()",
        "```",
      ].join("\n"))
    ).toEqual([
      { kind: "heading", level: 2, text: "创建 FastAPI 应用" },
      { kind: "paragraph", text: "这是一段说明， 下一行应并入同一段。" },
      { kind: "rule" },
      { kind: "list", ordered: true, items: ["第一项", "第二项"] },
      { kind: "list", ordered: false, items: ["普通列表", "`Token` 模型"] },
      { kind: "code", language: "py", content: "app = FastAPI()" },
    ]);
  });

  test("approval mode renders focused approval view with compact diff structure", () => {
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
    expect(output).toContain("[edit preview]");
    expect(output).toContain("@@ replacement");
    expect(output).toContain("newValue");
  });

  test("normal mode renders minimalist transcript and input", () => {
    const tree = renderScreen();
    const output = JSON.stringify(tree);

    expect(output).toContain("CYRENE");
    expect(output).toContain("READY");
    expect(output).toContain("Tool: write_file src/a.ts | ok");
    expect(output).toContain("Ask something...");
    expect(output).not.toContain("Conversation");
  });

  test("renders token metrics when usage is available", () => {
    const tree = renderScreen({
      usage: {
        promptTokens: 128,
        completionTokens: 64,
        totalTokens: 192,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Prompt");
    expect(output).toContain("Completion");
    expect(output).toContain("Total");
    expect(output).toContain("128");
    expect(output).toContain("64");
    expect(output).toContain("192");
  });

  test("renders token metrics fallback when usage is unavailable", () => {
    const tree = renderScreen({ usage: null });
    const output = JSON.stringify(tree);

    expect(output).toContain("Prompt");
    expect(output).toContain("Completion");
    expect(output).toContain("Total");
    expect(output).toContain("Prompt -");
    expect(output).toContain("Completion -");
    expect(output).toContain("Total -");
  });

  test("streaming mode shows working status and spinner text", () => {
    const tree = renderScreen({
      items: [],
      liveAssistantText: "working",
      status: "streaming",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("WORKING");
    expect(output).toContain("Thinking");
  });

  test("renders live assistant text separately from committed transcript", () => {
    const tree = renderScreen({
      items: [
        {
          role: "user",
          text: "hello",
          kind: "transcript",
          tone: "neutral",
        },
      ],
      liveAssistantText: "streaming reply",
      status: "streaming",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("you");
    expect(output).toContain("cyrene");
    expect(output).toContain("hello");
    expect(output).toContain("streaming reply");
  });

  test("renders markdown headings and lists without literal markdown markers", () => {
    const tree = renderScreen({
      items: [
        {
          role: "assistant",
          text: [
            "## 1. 创建 FastAPI 应用",
            "",
            "这是一段说明，",
            "下一行应并入同一段。",
            "",
            "- `OAuth2PasswordBearer` 负责从请求提取 token",
            "- `Token` 模型还未接入路由",
            "",
            "---",
          ].join("\n"),
          kind: "transcript",
          tone: "neutral",
        },
      ],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("创建 FastAPI 应用");
    expect(output).not.toContain("## 1. 创建 FastAPI 应用");
    expect(output).toContain("这是一段说明， 下一行应并入同一段。");
    expect(output).toContain("• ");
    expect(output).toContain("OAuth2PasswordBearer");
    expect(output).toContain("Token");
    expect(output).toContain("─────────────────────────");
  });

  test("renders compact approval summary, diff preview and code block text", () => {
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

    expect(output).toContain("review 1 pending");
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

  test("renders run_command approval as process preview card", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [commandPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Process preview");
    expect(output).toContain("Command");
    expect(output).toContain("Args");
    expect(output).toContain("Cwd");
    expect(output).toContain("test tests/ChatScreen.test.tsx");
    expect(output).toContain("test_files");
  });

  test("renders run_shell approval as shell preview card", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [shellPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Shell preview");
    expect(output).toContain("Shell");
    expect(output).toContain("Command");
    expect(output).toContain("Risk");
    expect(output).toContain("Get-ChildItem test_files");
  });

  test("renders compact model picker list", () => {
    const tree = renderScreen({
      items: [],
      modelPicker: {
        active: true,
        models: ["gpt-test", "gpt-next"],
        selectedIndex: 1,
        pageSize: 8,
      },
      currentModel: "gpt-test",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Models  page 1/1  total 2");
    expect(output).toContain("> gpt-next");
    expect(output).toContain("[current]");
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

    expect(output).toContain("commands");
    expect(output).toContain("/model");
    expect(output).toContain("/model refresh");
    expect(output).toContain("history 2/5");
  });
});
