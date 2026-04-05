import { describe, expect, test } from "bun:test";
import {
  applyParsedStateUpdate,
  buildFallbackPendingDigest,
  buildStateReducerPrompt,
  sanitizeStoredWorkingState,
} from "../src/core/session/stateReducer";

describe("stateReducer", () => {
  test("prompt encodes the hard reducer rules", () => {
    const prompt = buildStateReducerPrompt({
      mode: "merge_and_digest",
      durableSummary: "OBJECTIVE:\n- stabilize reducer state",
      pendingDigest: "REMAINING:\n- tighten summary hygiene",
      summaryRecoveryNeeded: false,
    });

    expect(prompt).toContain(
      "Hard rules: never write planner chatter such as 我来 / 我先 / 让我 / 再看一下 / let me / I'll."
    );
    expect(prompt).toContain(
      "Hard rules: never copy the user's raw request into CONFIRMED FACTS."
    );
    expect(prompt).toContain(
      "Hard rules: RECENT FAILURES only stores real failures, conflicts, or blockers."
    );
    expect(prompt).toContain(
      "Hard rules: COMPLETED and REMAINING must stay mutually exclusive."
    );
  });

  test("applyParsedStateUpdate strips chatter, user-echo facts, fake failures, and completed/remaining overlap", () => {
    const applied = applyParsedStateUpdate({
      durableSummary: "",
      pendingDigest: "",
      update: {
        version: 1,
        mode: "full_rebuild_and_digest",
        summaryPatch: {
          OBJECTIVE: {
            op: "replace",
            set: ["我来分析项目结构"],
          },
          "CONFIRMED FACTS": {
            op: "merge",
            add: [
              "请你读一下这个项目，分析项目结构",
              "这是一个 Bun CLI 项目",
              "入口",
            ],
          },
          COMPLETED: {
            op: "merge",
            add: ["implemented reducer sanitizer"],
          },
          REMAINING: {
            op: "merge",
            add: ["implemented reducer sanitizer", "检查 query 如何把 memory 注入 prompt"],
          },
          "KNOWN PATHS": {
            op: "merge",
            add: ["src/query.ts", "入口"],
          },
          "RECENT FAILURES": {
            op: "merge",
            add: [
              "用来判断一条消息是不是 max_output_tokens 类型的 assistant 错误",
              "Tool error: search failed with timeout",
            ],
          },
        },
        nextPendingDigest: {
          OBJECTIVE: ["我先优化 reducer 约束"],
          "CONFIRMED FACTS": [
            "请你读一下这个项目",
            "项目使用 Bun 作为包管理器",
          ],
          COMPLETED: ["wrote reducer tests"],
          REMAINING: ["wrote reducer tests", "检查 stateReducer prompt"],
          "KNOWN PATHS": ["src/core/session/stateReducer.ts"],
          "RECENT FAILURES": [
            "如果是，这类错误会先被压住",
            "Tool error: read_file timed out",
          ],
        },
      },
    });

    expect(applied.summary).toContain("OBJECTIVE:\n- 分析项目结构");
    expect(applied.summary).toContain("CONFIRMED FACTS:\n- 这是一个 Bun CLI 项目");
    expect(applied.summary).toContain("COMPLETED:\n- implemented reducer sanitizer");
    expect(applied.summary).toContain("REMAINING:\n- 检查 query 如何把 memory 注入 prompt");
    expect(applied.summary).toContain("KNOWN PATHS:\n- src/query.ts");
    expect(applied.summary).toContain(
      "RECENT FAILURES:\n- Tool error: search failed with timeout"
    );
    expect(applied.summary).not.toContain("我来");
    expect(applied.summary).not.toContain("请你读一下这个项目");
    expect(applied.summary).not.toContain("用来判断一条消息");
    expect(applied.summary).not.toContain("REMAINING:\n- implemented reducer sanitizer");

    expect(applied.pendingDigest).toContain("OBJECTIVE:\n- 优化 reducer 约束");
    expect(applied.pendingDigest).toContain(
      "CONFIRMED FACTS:\n- 项目使用 Bun 作为包管理器"
    );
    expect(applied.pendingDigest).toContain("COMPLETED:\n- wrote reducer tests");
    expect(applied.pendingDigest).toContain(
      "REMAINING:\n- 检查 stateReducer prompt"
    );
    expect(applied.pendingDigest).toContain(
      "KNOWN PATHS:\n- src/core/session/stateReducer.ts"
    );
    expect(applied.pendingDigest).toContain(
      "RECENT FAILURES:\n- Tool error: read_file timed out"
    );
    expect(applied.pendingDigest).not.toContain("我先");
    expect(applied.pendingDigest).not.toContain("请你读一下这个项目");
    expect(applied.pendingDigest).not.toContain("如果是，这类错误会先被压住");
    expect(applied.pendingDigest).not.toContain("REMAINING:\n- wrote reducer tests");
  });

  test("buildFallbackPendingDigest keeps durable facts and drops chatter", () => {
    const digest = buildFallbackPendingDigest({
      userText: "inspect the project",
      assistantText: [
        "我来看看这个项目",
        "plain visible answer only",
        "项目使用 Bun 作为包管理器",
        "路径 src/query.ts",
      ].join("\n"),
    });

    expect(digest).toContain("OBJECTIVE:\n- inspect the project");
    expect(digest).toContain("CONFIRMED FACTS:\n- 项目使用 Bun 作为包管理器");
    expect(digest).toContain("KNOWN PATHS:\n- src/query.ts");
    expect(digest).not.toContain("我来看看这个项目");
    expect(digest).not.toContain("plain visible answer only");
  });

  test("sanitizeStoredWorkingState repairs polluted persisted state and drops unknown paths", () => {
    const sanitized = sanitizeStoredWorkingState({
      summary: [
        "OBJECTIVE:",
        "- 沿着 `src/memdir/memdir.ts` 继续梳理 memory 的调用链与落盘点",
        "",
        "CONFIRMED FACTS:",
        "- 项目名是 `@anthropic-ai/claude-code`。",
        "- `dev` / `start` / `version` → `src/bootstrap-entry.ts`",
        "- 当有自定义 system prompt，且设置了 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`",
        "- `truncateEntrypointContent`",
        "",
        "CONSTRAINTS:",
        "- 这是个兼容性修复，避免 `yarnpkg` 被自动写进用户 `package.json`。",
        "",
        "KNOWN PATHS:",
        "- package.json",
        "- src/bootstrap-entry.ts",
        "- src/entrypoints/cli.tsx",
      ].join("\n"),
      pendingDigest: [
        "OBJECTIVE:",
        "- 下面基于已经拿到的 `src/memdir/memdir.ts` 结果，继续做详细分析",
        "",
        "CONFIRMED FACTS:",
        "- `ensureMemoryDirExists`",
        "",
        "REMAINING:",
        "- 这说明它的职责不是“执行记忆写入”，而是",
        "- 沿 `src/memdir/memdir.ts` 继续看 memory 文件读取、截断和 prompt 组装",
        "",
        "KNOWN PATHS:",
        "- src/memdir/memdir.ts",
        "- src/entrypoints/cli.tsx",
      ].join("\n"),
      allowedPaths: [
        "package.json",
        "src/bootstrap-entry.ts",
        "src/memdir/memdir.ts",
      ],
    });

    expect(sanitized.summary).toContain(
      "OBJECTIVE:\n- 沿着 `src/memdir/memdir.ts` 继续梳理 memory 的调用链与落盘点"
    );
    expect(sanitized.summary).toContain(
      "CONFIRMED FACTS:\n- 项目名是 `@anthropic-ai/claude-code`。"
    );
    expect(sanitized.summary).toContain(
      "CONSTRAINTS:\n- 避免 `yarnpkg` 被自动写进用户 `package.json`"
    );
    expect(sanitized.summary).toContain(
      "KNOWN PATHS:\n- package.json\n- src/bootstrap-entry.ts"
    );
    expect(sanitized.summary).not.toContain("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
    expect(sanitized.summary).not.toContain("truncateEntrypointContent");
    expect(sanitized.summary).not.toContain("src/entrypoints/cli.tsx");

    expect(sanitized.pendingDigest).toContain("OBJECTIVE:\n- (none)");
    expect(sanitized.pendingDigest).toContain(
      "REMAINING:\n- 沿 `src/memdir/memdir.ts` 继续看 memory 文件读取"
    );
    expect(sanitized.pendingDigest).toContain("KNOWN PATHS:\n- src/memdir/memdir.ts");
    expect(sanitized.pendingDigest).not.toContain("ensureMemoryDirExists");
    expect(sanitized.pendingDigest).not.toContain("这说明它的职责不是");
    expect(sanitized.pendingDigest).not.toContain("下面基于已经拿到的");
  });
});
