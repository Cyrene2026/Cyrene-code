import { describe, expect, mock, test } from "bun:test";
import {
  applyParsedStateUpdate,
  buildFallbackPendingDigest,
  buildStateReducerPrompt,
  CYRENE_STATE_UPDATE_END_TAG,
  CYRENE_STATE_UPDATE_START_TAG,
  parseAssistantStateUpdate,
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
    expect(prompt).toContain(
      "Cold-start rule: if durable context is still sparse, leave summaryPatch empty"
    );
    expect(prompt).toContain(
      "Cold-start priority: during early exploration, first capture the startup mechanism, launch command, entrypoint files, and bootstrap chain"
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
              "src/frontend/main.tsx：不存在",
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
            "src/frontend/styles.css 不存在",
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
    expect(applied.summary).toContain("- 项目中不存在 `src/frontend/main.tsx`");
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
    expect(applied.pendingDigest).toContain("- 项目中不存在 `src/frontend/styles.css`");
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
    expect(sanitized.summary).toContain("CONFIRMED FACTS:");
    expect(sanitized.summary).toContain("- 项目名是 `@anthropic-ai/claude-code`");
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

  test("sanitizeStoredWorkingState drops filler, reclassifies constraints/completed lines, and safely salvages explicit endpoint labels", () => {
    const sanitized = sanitizeStoredWorkingState({
      summary: [
        "OBJECTIVE:",
        "- app/db.py 中数据库逻辑已完整实现",
        "",
        "CONFIRMED FACTS:",
        "- FastAPI 应用实例",
        "- 基础路由",
        "- GET /items：列表查询",
        "- 已创建 FastAPI 应用",
        "",
        "CONSTRAINTS:",
        "- 支持 skip / limit 分页",
        "- 需要 token=fastapi-demo",
        "- 需要先激活 conda 环境 backend 再执行 pip",
        "- 看下需要接上的调用点",
        "",
        "COMPLETED:",
        "- 看看项目完成怎么样了",
        "- 已完成的部分",
        "",
        "REMAINING:",
        "- 写吧",
        "- 好，继续",
        "- 我就马上开写",
        "- 可继续执行 GET /items 接口联调验证",
        "",
        "KNOWN PATHS:",
        "- main.py",
        "- app/db.py",
      ].join("\n"),
      pendingDigest: [
        "OBJECTIVE:",
        "- 这个项目的 FastAPI 功能实现如下",
        "",
        "CONFIRMED FACTS:",
        "- 启动入口：main.py",
        "- 配置了 CORS，允许所有来源、方法、请求头。",
        "",
        "COMPLETED:",
        "- 已创建 FastAPI 应用",
        "",
        "REMAINING:",
        "- 创建了 FastAPI 应用",
        "",
        "NEXT BEST ACTIONS:",
        "- 创建了 FastAPI 应用",
      ].join("\n"),
      allowedPaths: ["main.py", "app/db.py"],
    });

    expect(sanitized.summary).toContain("OBJECTIVE:\n- (none)");
    expect(sanitized.summary).toContain("CONFIRMED FACTS:\n- `GET /items` 是列表查询");
    expect(sanitized.summary).toContain("CONSTRAINTS:\n- 支持 skip / limit 分页");
    expect(sanitized.summary).toContain("- 需要 token=fastapi-demo");
    expect(sanitized.summary).toContain("- 需要先激活 conda 环境 backend 再执行 pip");
    expect(sanitized.summary).toContain("COMPLETED:");
    expect(sanitized.summary).toContain("- 已创建 FastAPI 应用");
    expect(sanitized.summary).toContain("KNOWN PATHS:\n- main.py\n- app/db.py");
    expect(sanitized.summary).not.toContain("FastAPI 应用实例");
    expect(sanitized.summary).not.toContain("基础路由");
    expect(sanitized.summary).not.toContain("看下需要接上的调用点");
    expect(sanitized.summary).not.toContain("写吧");
    expect(sanitized.summary).not.toContain("可继续执行 GET /items 接口联调验证");

    expect(sanitized.pendingDigest).toContain("OBJECTIVE:\n- (none)");
    expect(sanitized.pendingDigest).toContain("CONFIRMED FACTS:\n- 入口文件是 `main.py`");
    expect(sanitized.pendingDigest).toContain("COMPLETED:\n- 已创建 FastAPI 应用");
    expect(sanitized.pendingDigest).toContain("REMAINING:\n- (none)");
    expect(sanitized.pendingDigest).toContain("NEXT BEST ACTIONS:\n- (none)");
    expect(sanitized.pendingDigest).not.toContain("创建了 FastAPI 应用");
  });

  test("sanitizeStoredWorkingState keeps sparse cold-start state in pendingDigest only", () => {
    const sanitized = sanitizeStoredWorkingState({
      summary: [
        "OBJECTIVE:",
        "- 查看项目启动机制",
        "",
        "KNOWN PATHS:",
        "- package.json",
      ].join("\n"),
      pendingDigest: [
        "OBJECTIVE:",
        "- 查看项目启动机制",
        "",
        "CONFIRMED FACTS:",
        "- 入口文件是 main.py",
        "",
        "KNOWN PATHS:",
        "- package.json",
        "- main.py",
      ].join("\n"),
      allowedPaths: ["package.json", "main.py"],
    });

    expect(sanitized.summary).toBe("");
    expect(sanitized.pendingDigest).toContain("OBJECTIVE:\n- 查看项目启动机制");
    expect(sanitized.pendingDigest).toContain(
      "CONFIRMED FACTS:\n- 入口文件是 main.py"
    );
    expect(sanitized.pendingDigest).toContain("KNOWN PATHS:\n- package.json\n- main.py");
  });

  test("sanitizeStoredWorkingState preserves startup command and script facts in pendingDigest", () => {
    const sanitized = sanitizeStoredWorkingState({
      summary: "",
      pendingDigest: [
        "CONFIRMED FACTS:",
        "- package.json 使用 bun run dev 启动项目",
        "- package.json 的 dev 脚本使用 bun run src/main.ts",
        "",
        "KNOWN PATHS:",
        "- package.json",
        "- src/main.ts",
      ].join("\n"),
      allowedPaths: ["package.json", "src/main.ts"],
    });

    expect(sanitized.summary).toBe("");
    expect(sanitized.pendingDigest).toContain(
      "CONFIRMED FACTS:\n- `package.json` 使用 `bun run dev` 启动项目"
    );
    expect(sanitized.pendingDigest).toContain(
      "- `package.json` 的 `dev` 脚本使用 `bun run src/main.ts`"
    );
    expect(sanitized.pendingDigest).toContain("KNOWN PATHS:\n- package.json\n- src/main.ts");
  });

  test("sanitizeStoredWorkingState preserves launch-command and run-command labels in pendingDigest", () => {
    const sanitized = sanitizeStoredWorkingState({
      summary: "",
      pendingDigest: [
        "CONFIRMED FACTS:",
        "- 启动命令：bun run dev",
        "- 运行命令：node ./bin/cyrene.js",
      ].join("\n"),
    });

    expect(sanitized.summary).toBe("");
    expect(sanitized.pendingDigest).toContain("CONFIRMED FACTS:");
    expect(sanitized.pendingDigest).toContain("- 启动命令是 `bun run dev`");
    expect(sanitized.pendingDigest).toContain("- 运行命令是 `node ./bin/cyrene.js`");
  });

  test("sanitizeStoredWorkingState preserves bootstrap-chain labels in pendingDigest", () => {
    const sanitized = sanitizeStoredWorkingState({
      summary: "",
      pendingDigest: [
        "CONFIRMED FACTS:",
        "- bootstrap chain: package.json -> src/bootstrap-entry.ts -> src/entrypoints/cli.tsx",
        "- package.json 的 bootstrap chain 是 src/bootstrap-entry.ts -> src/entrypoints/cli.tsx",
        "",
        "KNOWN PATHS:",
        "- package.json",
        "- src/bootstrap-entry.ts",
        "- src/entrypoints/cli.tsx",
      ].join("\n"),
      allowedPaths: [
        "package.json",
        "src/bootstrap-entry.ts",
        "src/entrypoints/cli.tsx",
      ],
    });

    expect(sanitized.summary).toBe("");
    expect(sanitized.pendingDigest).toContain("CONFIRMED FACTS:");
    expect(sanitized.pendingDigest).toContain(
      "- bootstrap chain 是 `package.json -> src/bootstrap-entry.ts -> src/entrypoints/cli.tsx`"
    );
    expect(sanitized.pendingDigest).toContain(
      "- `package.json` 的 bootstrap chain 是 `src/bootstrap-entry.ts -> src/entrypoints/cli.tsx`"
    );
    expect(sanitized.pendingDigest).toContain(
      "KNOWN PATHS:\n- package.json\n- src/bootstrap-entry.ts"
    );
  });

  test("applyParsedStateUpdate keeps sparse rebuilt state in pendingDigest until durable baseline exists", () => {
    const applied = applyParsedStateUpdate({
      durableSummary: "",
      pendingDigest: "",
      update: {
        version: 1,
        mode: "full_rebuild_and_digest",
        summaryPatch: {
          OBJECTIVE: {
            op: "replace",
            set: ["查看项目启动机制"],
          },
          "CONFIRMED FACTS": {
            op: "merge",
            add: ["入口文件是 main.py"],
          },
          "KNOWN PATHS": {
            op: "merge",
            add: ["main.py"],
          },
        },
        nextPendingDigest: {
          OBJECTIVE: ["查看项目启动机制"],
          "CONFIRMED FACTS": ["入口文件是 main.py"],
          "KNOWN PATHS": ["main.py"],
        },
      },
    });

    expect(applied.summary).toBe("");
    expect(applied.pendingDigest).toContain("OBJECTIVE:\n- 查看项目启动机制");
    expect(applied.pendingDigest).toContain(
      "CONFIRMED FACTS:\n- 入口文件是 main.py"
    );
    expect(applied.pendingDigest).toContain("KNOWN PATHS:\n- main.py");
  });

  test("parseAssistantStateUpdate ignores literal state tags inside inline code spans", () => {
    const raw = [
      "核心点：",
      `• 定义了隐藏标签：\`${CYRENE_STATE_UPDATE_START_TAG}\` / \`${CYRENE_STATE_UPDATE_END_TAG}\``,
      "• 这只是说明文档，不是隐藏协议输出。",
    ].join("\n");

    const parsed = parseAssistantStateUpdate(raw);

    expect(parsed.visibleText).toBe(raw);
    expect(parsed.hasStateTag).toBe(false);
    expect(parsed.parseStatus).toBe("missing_tag");
  });

  test("parseAssistantStateUpdate invokes incomplete-tag callback for unterminated state blocks", () => {
    const raw = [
      "Visible answer",
      CYRENE_STATE_UPDATE_START_TAG,
      '{"version":1,"mode":"digest_only"',
    ].join("\n");
    const onIncompleteTag = mock(() => {});

    const parsed = parseAssistantStateUpdate(raw, { onIncompleteTag });

    expect(parsed.parseStatus).toBe("incomplete_tag");
    expect(onIncompleteTag).toHaveBeenCalledTimes(1);
    expect(onIncompleteTag).toHaveBeenCalledWith({
      rawAssistantText: raw,
      visibleText: "Visible answer",
    });
  });

  test("parseAssistantStateUpdate trims trailing partial reducer tags during streaming", () => {
    const visibleAnswer = "Visible answer";

    for (let length = 1; length < CYRENE_STATE_UPDATE_START_TAG.length; length += 1) {
      const raw = `${visibleAnswer}${CYRENE_STATE_UPDATE_START_TAG.slice(0, length)}`;
      const parsed = parseAssistantStateUpdate(raw);

      expect(parsed.visibleText).toBe(visibleAnswer);
      expect(parsed.hasStateTag).toBe(false);
      expect(parsed.isComplete).toBe(false);
      expect(parsed.parseStatus).toBe("missing_tag");
    }
  });

  test("parseAssistantStateUpdate treats truncated closing reducer tags as incomplete", () => {
    const raw = [
      "Visible answer",
      `${CYRENE_STATE_UPDATE_START_TAG}{"version":1,"mode":"digest_only"}${CYRENE_STATE_UPDATE_END_TAG.slice(0, -3)}`,
    ].join("\n");

    const parsed = parseAssistantStateUpdate(raw);

    expect(parsed.visibleText).toBe("Visible answer");
    expect(parsed.hasStateTag).toBe(true);
    expect(parsed.isComplete).toBe(false);
    expect(parsed.parseStatus).toBe("incomplete_tag");
  });

  test("parseAssistantStateUpdate leaves damaged reducer tags visible when the start tag is corrupted", () => {
    const corruptedStartTag = "<cyrene_state_updXte>";
    const raw = [
      "Visible answer",
      `${corruptedStartTag}{"version":1,"mode":"digest_only"}${CYRENE_STATE_UPDATE_END_TAG}`,
    ].join("\n");

    const parsed = parseAssistantStateUpdate(raw);

    expect(parsed.visibleText).toBe(raw);
    expect(parsed.hasStateTag).toBe(false);
    expect(parsed.isComplete).toBe(false);
    expect(parsed.parseStatus).toBe("missing_tag");
  });
});
