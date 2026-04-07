import React from "react";
import { describe, expect, mock, test } from "bun:test";
import { create } from "react-test-renderer";
import type { PendingReviewItem } from "../src/core/mcp";

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

const editPendingWithPreviewHeader: PendingReviewItem = {
  ...editPending,
  id: "p1-header",
  previewSummary:
    "action=edit_file | path=src/example.ts\n\n[edit preview]\n[old - to be removed]\n- 12 | oldValue\n[new + to be written]\n+ 12 | newValue\n@@ replacement",
  previewFull:
    "action=edit_file | path=src/example.ts\n\n[edit preview]\n[old - to be removed]\n- 12 | const oldValue = 1;\n[new + to be written]\n+ 12 | const newValue = 2;\n@@ replacement",
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

const patchPending: PendingReviewItem = {
  id: "p2b",
  request: {
    action: "apply_patch",
    path: "src/patch.ts",
    find: "before",
    replace: "after",
  },
  preview: "preview",
  previewSummary:
    "[patch preview]\n[old - to be removed]\n- 18 | const before = true;\n[new + to be written]\n+ 18 | const after = true;\n@@ patch",
  previewFull:
    "[patch preview]\n[old - to be removed]\n- 18 | const before = true;\n[new + to be written]\n+ 18 | const after = true;\n@@ patch",
  createdAt: "2026-01-01T00:01:30.000Z",
};

const legacyNoSignDiffPending: PendingReviewItem = {
  id: "p2c",
  request: {
    action: "edit_file",
    path: "src/legacy.ts",
    find: "before",
    replace: "after",
  },
  preview: "preview",
  previewSummary:
    "[edit preview]\n[old - to be removed]\n18 | const before = true;\n[new + to be written]\n18 | const after = true;",
  previewFull:
    "[edit preview]\n[old - to be removed]\n18 | const before = true;\n[new + to be written]\n18 | const after = true;",
  createdAt: "2026-01-01T00:01:45.000Z",
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

const openShellPending: PendingReviewItem = {
  id: "p5",
  request: {
    action: "open_shell",
    path: ".",
    cwd: "workspace/subdir",
  },
  preview: "preview",
  previewSummary:
    "[shell session preview]\nshell: pwsh\ncwd: workspace/subdir\nexisting_session: none\nrisk: medium\nnote: Persistent shell state is kept in memory for this CLI process only.\nmode: summary",
  previewFull:
    "[shell session preview]\nshell: pwsh\ncwd: workspace/subdir\nexisting_session: none\nrisk: medium\nnote: Persistent shell state is kept in memory for this CLI process only.\nmode: full",
  createdAt: "2026-01-01T00:04:00.000Z",
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
  appRoot: "D:/Projects/demo-root",
  input: "",
  inputCursorOffset: 0,
    inputCommandState: {
      active: false,
      mode: "idle",
      queryText: null,
      currentCommand: null,
    suggestions: [],
    selectedIndex: 0,
    historyPosition: null,
    historySize: 0,
    shellShortcut: {
      active: false,
      action: null,
      command: "",
      actionLabel: "",
      description: "",
    },
    fileMentions: {
      references: [],
      activeQuery: null,
      suggestions: [],
      loading: false,
    },
  },
  shellSession: {
    visible: false,
    status: "none",
    shell: null,
    cwd: null,
    busy: false,
    alive: false,
    pendingOutput: false,
    lastExit: null,
    lastEvent: null,
  },
  resumePicker: { active: false, sessions: [], selectedIndex: 0, pageSize: 8 },
  sessionsPanel: { active: false, sessions: [], selectedIndex: 0, pageSize: 8 },
  modelPicker: { active: false, models: [], selectedIndex: 0, pageSize: 8 },
  providerPicker: {
    active: false,
    providers: ["https://provider.test/v1"],
    selectedIndex: 0,
    pageSize: 8,
    currentKeySource: "CYRENE_API_KEY",
    providerProfiles: {
      "https://provider.test/v1": "openai",
    },
    providerProfileSources: {
      "https://provider.test/v1": "inferred",
    },
  },
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
  authPanel: {
    active: false,
    mode: "manual_login" as const,
    step: "provider" as const,
    providerBaseUrl: "",
    apiKey: "",
    model: "gpt-test",
    cursorOffset: 0,
    error: null,
    info: null,
    saving: false,
    persistenceTarget: null,
  },
  authStatus: {
    mode: "http" as const,
    credentialSource: "process_env" as const,
    provider: "https://provider.test/v1",
    model: "gpt-test",
    persistenceTarget: null,
    onboardingAvailable: true,
    httpReady: true,
  },
  composerKeymap: "standard" as const,
  activeSessionId: "session-1",
  currentModel: "gpt-test",
  currentProvider: "https://provider.test/v1",
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
      { kind: "paragraph", lines: ["这是一段说明，", "下一行应并入同一段。"] },
      { kind: "rule" },
      {
        kind: "list",
        ordered: true,
        items: [
          { text: "第一项", marker: "1. " },
          { text: "第二项", marker: "2. " },
        ],
      },
      {
        kind: "list",
        ordered: false,
        items: [{ text: "普通列表" }, { text: "`Token` 模型" }],
      },
      { kind: "code", language: "py", content: "app = FastAPI()" },
    ]);
  });

  test("renders multiline assistant prose and unicode bullets without collapsing them", () => {
    const tree = renderScreen({
      items: [
        {
          role: "assistant",
          text: [
            "请你看一下项目结构",
            "• .vscode/：编辑器配置",
            "• SECURITY.md：安全说明",
            "如果你愿意，我下一步可以继续帮你。",
          ].join("\n"),
          kind: "transcript",
          tone: "neutral",
        },
      ],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("请你看一下项目结构");
    expect(output).toContain("• ");
    expect(output).toContain(".vscode/：编辑器配置");
    expect(output).toContain("SECURITY.md：安全说明");
    expect(output).toContain("如果你愿意，我下一步可以继续帮你。");
    expect(output).not.toContain("请你看一下项目结构 • .vscode/");
  });

  test("approval mode renders an inline approval view with diff stats and paused composer", () => {
    const tree = renderScreen({
      pendingReviews: [editPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("[review]");
    expect(output).toContain("Review pending");
    expect(output).not.toContain("Conversation");
    expect(output).not.toContain("[queue]");
    expect(output).toContain("[selection]");
    expect(output).toContain("Changes");
    expect(output).toContain("+1 lines");
    expect(output).toContain("-1 lines");
    expect(output).toContain("D:/Projects/demo-root");
    expect(output).toContain("added");
    expect(output).toContain("deleted");
    expect(output).toContain("Diff preview");
    expect(output).toContain("[preview]");
    expect(output).toContain("[edit preview]");
    expect(output).toContain("@@ replacement");
    expect(output).toContain("newValue");
    expect(output).not.toContain("Review mode");
    expect(output).not.toContain("Approval panel active...");
    expect(output).toContain("approve or reject before typing...");
    expect(output).toContain("review hotkeys");
  });

  test("approval mode hides raw preview header metadata lines", () => {
    const tree = renderScreen({
      pendingReviews: [editPendingWithPreviewHeader],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).not.toContain("action=edit_file");
    expect(output).not.toContain("path=src/example.ts");
    expect(output).toContain("[edit preview]");
    expect(output).toContain("newValue");
  });

  test("approval mode shows persistent shell session summary rows", () => {
    const tree = renderScreen({
      pendingReviews: [openShellPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("open_shell");
    expect(output).toContain("open shell session");
    expect(output).toContain("Shell");
    expect(output).toContain("platform default");
    expect(output).toContain("Cwd");
    expect(output).toContain("workspace/subdir");
    expect(output).toContain("Shell session preview");
  });

  test("normal mode renders minimalist transcript and input", () => {
    const tree = renderScreen();
    const output = JSON.stringify(tree);

    expect(output).toContain(">Cyrene");
    expect(output).toContain("READY");
    expect(output).toContain("model");
    expect(output).toContain("provider");
    expect(output).toContain("queue");
    expect(output).toContain("cwd");
    expect(output).toContain("D:/Projects/demo-root");
    expect(output).toContain("[tool]");
    expect(output).toContain("write_file src/a.ts | ok");
    expect(output).toContain("Ask Cyrene, mention files with @, or use / commands...");
    expect(output).toContain("ready  |  prompt ready");
    expect(output).toContain(
      "Enter send  |  Ctrl+J newline  |  Shift+Enter if terminal supports it"
    );
    expect(output).not.toContain("Conversation");
  });

  test("empty startup mode renders a lightweight workspace-first welcome prompt", () => {
    const tree = renderScreen({
      items: [
        {
          role: "system",
          text: "Type /help to view commands. Use /login for HTTP auth or /resume to open session picker.",
          kind: "system_hint",
          tone: "neutral",
          color: "gray",
        },
      ],
      liveAssistantText: "",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain(">Cyrene");
    expect(output).toContain("Cyrene Code");
    expect(output).toContain("Terminal-first coding assistant for the current workspace.");
    expect(output).toContain("cwd D:/Projects/demo-root");
    expect(output).toContain("provider.test");
    expect(output).toContain("Start here");
    expect(output).toContain("Explain this repository");
    expect(output).toContain("Fix something");
    expect(output).toContain("Connect HTTP");
    expect(output).toContain("Keep going");
    expect(output).toContain("/login");
    expect(output).toContain("Ask about this workspace, mention files, or use / commands...");
    expect(output).toContain(
      "Enter send  |  Ctrl+J newline  |  Shift+Enter if terminal supports it"
    );
    expect(output).not.toContain("Type /help to view commands. Use /login for HTTP auth or /resume to open session picker.");
  });

  test("compat keymap shows ctrl+d send hint instead of shift+enter guidance", () => {
    const tree = renderScreen({
      composerKeymap: "compat",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Ctrl+D send  |  Enter/Ctrl+J newline");
    expect(output).not.toContain("Shift+Enter if terminal supports it");
  });

  test("auth wizard provider step shows preset shortcut hints", () => {
    const tree = renderScreen({
      authPanel: {
        ...buildProps().authPanel,
        active: true,
        step: "provider",
        providerBaseUrl: "",
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Quick preset: 1 OpenAI | 2 Gemini | 3 Anthropic");
    expect(output).toContain("1/2/3: preset + next");
  });

  test("renders multiline composer content and grows beyond one logical line", () => {
    const tree = renderScreen({
      items: [],
      input: "first line\nsecond line",
      inputCursorOffset: "first line\nsecond line".length,
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("first line");
    expect(output).toContain("second line");
    expect(output).toContain(">");
    expect(output).toContain("│");
    expect(output).not.toContain("Ask Cyrene...");
  });

  test("shows only the visible composer window when input exceeds six lines", () => {
    const input = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
    const tree = renderScreen({
      items: [],
      input,
      inputCursorOffset: input.length,
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("line-8");
    expect(output).toContain("line-3");
    expect(output).not.toContain("line-1");
    expect(output).not.toContain("line-2");
  });

  test("wraps long pasted composer lines into continuation rows", () => {
    const input = "x".repeat(180);
    const tree = renderScreen({
      items: [],
      input,
      inputCursorOffset: input.length,
    });
    const output = JSON.stringify(tree);

    expect(output).toContain(">");
    expect(output).toContain("│");
  });

  test("wraps mixed-width pasted composer lines without losing CJK text", () => {
    const input = "这是一个很长的中文粘贴段落".repeat(12);
    const tree = renderScreen({
      items: [],
      input,
      inputCursorOffset: input.length,
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("这是一个很长的中文粘贴段落");
    expect(output).toContain("│");
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

    expect(output).toContain("tokens");
    expect(output).toContain("prompt");
    expect(output).toContain("completion");
    expect(output).toContain("128");
    expect(output).toContain("64");
    expect(output).toContain("192");
  });

  test("renders token metrics fallback when usage is unavailable", () => {
    const tree = renderScreen({ usage: null });
    const output = JSON.stringify(tree);

    expect(output).toContain("tokens -");
  });

  test("preparing, requesting, and streaming states show phased waiting labels", () => {
    const preparingOutput = JSON.stringify(
      renderScreen({
        items: [],
        status: "preparing",
      })
    );
    expect(preparingOutput).toContain("PREPARING");
    expect(preparingOutput).toContain("building prompt context");

    const requestingOutput = JSON.stringify(
      renderScreen({
        items: [],
        status: "requesting",
      })
    );
    expect(requestingOutput).toContain("REQUESTING");
    expect(requestingOutput).toContain("opening model stream");

    const streamingOutput = JSON.stringify(
      renderScreen({
        items: [],
        liveAssistantText: "working",
        status: "streaming",
      })
    );
    expect(streamingOutput).toContain("WORKING");
    expect(streamingOutput).toContain("model streaming");
    expect(streamingOutput).toContain("Ask Cyrene, mention files with @, or use / commands...");
  });

  test("review and error states remain visible in the flagship composer", () => {
    const reviewTree = renderScreen({
      items: [
        {
          role: "assistant",
          text: "pending review",
          kind: "transcript",
          tone: "neutral",
        },
      ],
      status: "awaiting_review",
    });
    const reviewOutput = JSON.stringify(reviewTree);

    expect(reviewOutput).toContain("REVIEW");
    expect(reviewOutput).toContain("review lane");

    const errorTree = renderScreen({
      items: [
        {
          role: "assistant",
          text: "failed",
          kind: "transcript",
          tone: "neutral",
        },
      ],
      status: "error",
    });
    const errorOutput = JSON.stringify(errorTree);

    expect(errorOutput).toContain("ERROR");
    expect(errorOutput).toContain("last step failed");
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
    expect(output).toContain("这是一段说明，");
    expect(output).toContain("下一行应并入同一段。");
    expect(output).not.toContain("这是一段说明， 下一行应并入同一段。");
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
    expect(output).toContain("reject with r/d");
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

  test("renders apply_patch approval as patch diff preview", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [patchPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Diff preview · patch");
    expect(output).toContain("scoped patch");
    expect(output).toContain("[patch preview]");
    expect(output).toContain("const after = true;");
  });

  test("infers add/remove rows from legacy numbered preview lines without +/- markers", () => {
    const tree = renderScreen({
      items: [],
      pendingReviews: [legacyNoSignDiffPending],
      approvalPanel: {
        ...buildProps().approvalPanel,
        active: true,
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Diff preview · edit");
    expect(output).toContain("+1 lines");
    expect(output).toContain("-1 lines");
    expect(output).toContain("const before = true;");
    expect(output).toContain("const after = true;");
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

  test("renders terminal-style tool output for direct command results", () => {
    const tree = renderScreen({
      items: [
        {
          role: "system",
          kind: "tool_status",
          tone: "info",
          text: [
            "Tool result: run_command .",
            "status: completed",
            "command: bun",
            "args: --version",
            "cwd: .",
            "exit: 0",
            "output:",
            "1.3.11",
          ].join("\n"),
        },
      ],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("run_command  |  status completed");
    expect(output).toContain("cwd .");
    expect(output).toContain("exit 0");
    expect(output).toContain("bun --version");
    expect(output).toContain("1.3.11");
    expect(output).not.toContain("terminal  run_command");
    expect(output).not.toContain("Tool result: run_command .");
    expect(output).not.toContain("\"tool\"");
  });

  test("renders terminal-style transcript for approved shell input", () => {
    const tree = renderScreen({
      items: [
        {
          role: "system",
          kind: "review_status",
          tone: "success",
          text: [
            "Approved shell-1",
            "path: .",
            "status: completed",
            "shell: pwsh",
            "cwd: subdir",
            "input: python --version",
            "last_exit: 0",
            "output:",
            "$ python --version",
            "Python 3.12.0 (venv)",
          ].join("\n"),
        },
      ],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("write_shell  |  status completed");
    expect(output).toContain("PS>");
    expect(output).toContain("python --version");
    expect(output).toContain("Python 3.12.0 (venv)");
    expect(output).not.toContain("terminal  write_shell");
    expect(output).not.toContain("\"review\"");
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
    expect(output).toContain("panel active");
    expect(output).toContain("Close the active panel to keep typing...");
    expect(output).toContain("panel active  |  close current panel to type");
  });

  test("renders compact provider picker list", () => {
    const tree = renderScreen({
      items: [],
      providerPicker: {
        active: true,
        providers: ["https://provider-a.test/v1", "https://provider-b.test/v1"],
        selectedIndex: 1,
        pageSize: 8,
        currentKeySource: "CYRENE_OPENAI_API_KEY",
        providerProfiles: {
          "https://provider-a.test/v1": "openai",
          "https://provider-b.test/v1": "openai",
        },
        providerProfileSources: {
          "https://provider-a.test/v1": "manual",
          "https://provider-b.test/v1": "inferred",
        },
      },
      currentProvider: "https://provider-a.test/v1",
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Providers  page 1/1  total 2");
    expect(output).toContain("profile OpenAI-compatible");
    expect(output).toContain("source manual");
    expect(output).toContain("source inferred");
    expect(output).toContain("endpoint relay/custom");
    expect(output).toContain("key source openai env");
    expect(output).toContain("provider-b.test");
    expect(output).toContain("[current]");
    expect(output).toContain("Close the active panel to keep typing...");
  });

  test("renders slash command hints in the input card helper line", () => {
    const tree = renderScreen({
      items: [],
      input: "/mo",
      inputCommandState: {
        active: true,
        mode: "command",
        queryText: "/model",
        currentCommand: "/model <name>",
        suggestions: [
          {
            command: "/model <name>",
            description: "switch model directly",
            group: "Model & provider",
            matchRanges: [{ start: 0, end: 3 }],
            baseCommand: "/model",
            template: "<name>",
            argumentHints: [{ label: "name", optional: false }],
            insertValue: "/model ",
          },
          {
            command: "/model refresh",
            description: "refresh available models",
            group: "Model & provider",
            matchRanges: [{ start: 0, end: 3 }],
            baseCommand: "/model",
            template: "refresh",
            argumentHints: [],
            insertValue: "/model refresh",
          },
          {
            command: "/resume",
            description: "open session resume picker",
            group: "Session",
            matchRanges: [],
          },
        ],
        selectedIndex: 0,
        historyPosition: null,
        historySize: 0,
        shellShortcut: {
          active: false,
          action: null,
          command: "",
          actionLabel: "",
          description: "",
        },
        fileMentions: {
          references: [],
          activeQuery: null,
          suggestions: [],
          loading: false,
        },
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("Command palette");
    expect(output).toContain("command palette");
    expect(output).toContain("Model & provider");
    expect(output).toContain("Session");
    expect(output).toContain("/model");
    expect(output).toContain("<name>");
    expect(output).toContain("template");
    expect(output).toContain("args");
    expect(output).toContain("name");
    expect(output).toContain("refresh available models");
    expect(output).toContain("command palette  |  Tab insert template  |  args name");
    expect(output).not.toContain("history 2/5");
  });

  test("keeps partially typed slash commands visible in the composer", () => {
    const tree = renderScreen({
      input: "/mcp",
      inputCursorOffset: "/mcp".length,
      inputCommandState: {
        active: true,
        mode: "command",
        queryText: "/mcp",
        currentCommand: "/mcp",
        suggestions: [],
        selectedIndex: 0,
        historyPosition: null,
        historySize: 0,
        shellShortcut: {
          active: false,
          action: null,
          command: "",
          actionLabel: "",
          description: "",
        },
        fileMentions: {
          references: [],
          activeQuery: null,
          suggestions: [],
          loading: false,
        },
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("/mcp");
    expect(output).toContain("typing /mcp");
    expect(output).toContain("No command match for /mcp.");
  });

  test("renders file mention palette rows in the composer", () => {
    const tree = renderScreen({
      items: [],
      input: "@chat",
      inputCommandState: {
        active: false,
        mode: "file",
        queryText: null,
        currentCommand: null,
        suggestions: [],
        selectedIndex: 1,
        historyPosition: null,
        historySize: 0,
        shellShortcut: {
          active: false,
          action: null,
          command: "",
          actionLabel: "",
          description: "",
        },
        fileMentions: {
          references: ["src/frontend/components/ChatScreen.tsx"],
          activeQuery: "chat",
          suggestions: [
            {
              path: "src/frontend/components/ChatScreen.tsx",
              description: "src/frontend/components",
            },
            {
              path: "tests/ChatScreen.test.tsx",
              description: "tests",
            },
          ],
          loading: false,
          preview: {
            path: "tests/ChatScreen.test.tsx",
            text: 'import React from "react";\n› const preview = true;',
            meta: "context hit  |  lines 1-3",
            loading: false,
          },
        },
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("File mentions");
    expect(output).toContain("search  @chat");
    expect(output).toContain("@src/frontend/components/ChatScreen.tsx");
    expect(output).toContain("@tests/ChatScreen.test.tsx");
    expect(output).toContain("preview  @tests/ChatScreen.test.tsx  |  context hit  |  lines 1-3");
    expect(output).toContain('import React from \\"react\\";');
    expect(output).toContain("› const preview = true;");
    expect(output).toContain("file mentions  |  Tab insert  |  ↑/↓ select");
  });

  test("renders shell shortcut status in the composer", () => {
    const realDateNow = Date.now;
    Date.now = () => 1_710_000_060_000;

    try {
      const tree = renderScreen({
        items: [],
        input: "!shell bun test",
        shellSession: {
          visible: true,
          status: "idle",
          shell: "pwsh",
          cwd: "workspace/subdir",
          busy: false,
          alive: true,
          pendingOutput: true,
          lastExit: "0",
          lastEvent: "opened",
          openedAt: 1_710_000_015_000,
          runningSince: 1_710_000_048_000,
          lastOutputSummary: "Compiling chat renderer  ·  Done in 0.48s",
          lastOutputAt: 1_710_000_057_000,
        },
        inputCommandState: {
          active: false,
          mode: "shell",
          queryText: null,
          currentCommand: null,
          suggestions: [],
          selectedIndex: 0,
          historyPosition: null,
          historySize: 0,
          shellShortcut: {
            active: true,
            action: "run_shell",
            command: "bun test",
            actionLabel: "run_shell",
            description: "Run a one-shot shell command through the review lane.",
          },
          fileMentions: {
            references: [],
            activeQuery: null,
            suggestions: [],
            loading: false,
          },
        },
      });
      const output = JSON.stringify(tree);

      expect(output).toContain("Shell shortcut");
      expect(output).toContain("SHELL IDLE");
      expect(output).toContain("run_shell");
      expect(output).toContain("bun test");
      expect(output).toContain("workspace/subdir");
      expect(output).toContain("live");
      expect(output).toContain("00:45");
      expect(output).toContain("run");
      expect(output).toContain("00:12");
      expect(output).toContain("recent");
      expect(output).toContain("Compiling chat renderer");
      expect(output).toContain("age");
      expect(output).toContain("00:03");
      expect(output).toContain("buffer");
      expect(output).toContain("opened");
      expect(output).toContain(
        "shell shortcut  |  Ctrl+D send  |  open/read/status/interrupt/close"
      );
      expect(output).toContain("!shell open [cwd]");
    } finally {
      Date.now = realDateNow;
    }
  });

  test("renders history indicator in the input card helper line", () => {
    const tree = renderScreen({
      items: [],
      inputCommandState: {
        active: false,
        mode: "idle",
        queryText: null,
        currentCommand: null,
        suggestions: [],
        selectedIndex: 0,
        historyPosition: 2,
        historySize: 5,
        shellShortcut: {
          active: false,
          action: null,
          command: "",
          actionLabel: "",
          description: "",
        },
        fileMentions: {
          references: [],
          activeQuery: null,
          suggestions: [],
          loading: false,
        },
      },
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("history 2/5");
    expect(output).toContain("empty composer: Up/Down recall");
  });

  test("clips oversized assistant transcript blocks and keeps the latest slice visible", () => {
    const hugeCodeBlock = [
      "```txt",
      ...Array.from({ length: 460 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`),
      "```",
    ].join("\n");

    const tree = renderScreen({
      items: [
        {
          role: "assistant",
          text: hugeCodeBlock,
          kind: "transcript",
          tone: "neutral",
        },
      ],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("[render clipped]");
    expect(output).toContain("showing latest slice");
    expect(output).toContain("code | txt");
    expect(output).toContain("\"460\"");
    expect(output).not.toContain("\"001\"");
  });

  test("keeps the tail of long ordered assistant output after it is committed", () => {
    const longList = Array.from(
      { length: 460 },
      (_, index) => `${index + 1}. point-${String(index + 1).padStart(3, "0")}`
    ).join("\n");

    const tree = renderScreen({
      items: [
        {
          role: "assistant",
          text: longList,
          kind: "transcript",
          tone: "neutral",
        },
      ],
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("[render clipped]");
    expect(output).toContain("showing latest slice");
    expect(output).toContain("\"  41. \"");
    expect(output).toContain("point-041");
    expect(output).toContain("\"  460. \"");
    expect(output).toContain("point-460");
    expect(output).not.toContain("point-001");
  });

  test("shows only a recent transcript window for very long sessions", () => {
    const manyItems = Array.from({ length: 100 }, (_, index) => ({
      role: "assistant" as const,
      text: `session-msg-${String(index).padStart(3, "0")}`,
      kind: "transcript" as const,
      tone: "neutral" as const,
    }));

    const tree = renderScreen({
      items: manyItems,
    });
    const output = JSON.stringify(tree);

    expect(output).toContain("[render window] showing latest 80 of 100 messages");
    expect(output).toContain("session-msg-099");
    expect(output).not.toContain("session-msg-000");
  });

  test("shows only the latest slice of oversized live streaming output without extra clip chatter", () => {
    const hugeStreamingBlock = [
      "```txt",
      ...Array.from(
        { length: 220 },
        (_, index) => `stream-${String(index + 1).padStart(3, "0")}`
      ),
      "```",
    ].join("\n");

    const tree = renderScreen({
      items: [],
      liveAssistantText: hugeStreamingBlock,
      status: "streaming",
    });
    const output = JSON.stringify(tree);

    expect(output).not.toContain("[render clipped]");
    expect(output).toContain("stream-220");
    expect(output).not.toContain("stream-001");
  });
});
