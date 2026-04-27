import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfiguredAppRoot, setConfiguredAppRoot } from "../src/infra/config/appRoot";
import { createFileSessionStore } from "../src/infra/session/createFileSessionStore";

const tempRoots: string[] = [];

const createStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-session-memory-"));
  tempRoots.push(root);
  return {
    root,
    store: createFileSessionStore(root, {
      cwd: root,
      env: { CYRENE_ROOT: root } as NodeJS.ProcessEnv,
    }),
  };
};

afterEach(async () => {
  resetConfiguredAppRoot();
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

describe("session memory index", () => {
  test("persists in-flight committed assistant prefix for resume", async () => {
    const { store } = await createStore();
    const session = await store.createSession("resume ordering");

    await store.updateInFlightTurn(session.id, {
      userText: "continue",
      assistantText: "first visible part\nsecond visible part",
      committedVisibleText: "first visible part\n",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const loaded = await store.loadSession(session.id);

    expect(loaded?.inFlightTurn?.committedVisibleText).toBe("first visible part\n");
    expect(loaded?.inFlightTurn?.assistantText).toContain("second visible part");
  });

  test("lazy rebuilds sidecar index for legacy session data", async () => {
    const { root, store } = await createStore();
    const legacyId = "legacy-session";

    await writeFile(
      join(root, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          title: "legacy",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          summary: "",
          focus: ["legacy pin"],
          messages: [
            {
              role: "user",
              text: "please create test_files/u4.py",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
            {
              role: "assistant",
              text: "Created file test_files/u4.py",
              createdAt: "2026-01-01T00:00:02.000Z",
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const loaded = await store.loadSession(legacyId);
    const index = await store.getMemoryIndex(legacyId);
    const sidecar = JSON.parse(
      await readFile(join(root, `${legacyId}.index.json`), "utf8")
    ) as { entries: Array<{ kind: string; text: string }> };

    expect(loaded?.focus).toEqual(["legacy pin"]);
    expect(index.entries.some(entry => entry.kind === "pin" && entry.text === "legacy pin")).toBe(
      true
    );
    expect(
      sidecar.entries.some(entry => entry.kind === "task" && entry.text.includes("u4.py"))
    ).toBe(true);
  });

  test("legacy rebuild filters low-signal chatter and keeps only durable memories", async () => {
    const { root, store } = await createStore();
    const legacyId = "legacy-chatter-session";

    await writeFile(
      join(root, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          title: "legacy chatter",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          summary: "",
          focus: [],
          tags: [],
          messages: [
            {
              role: "user",
              text: "好",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
            {
              role: "user",
              text: "inspect src/query.ts",
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            {
              role: "assistant",
              text: "让我继续查看 src/query.ts 文件的更多内容。让我读取接下来的部分。",
              createdAt: "2026-01-01T00:00:03.000Z",
            },
            {
              role: "assistant",
              text: "Created file test_files/u4.py",
              createdAt: "2026-01-01T00:00:04.000Z",
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const index = await store.getMemoryIndex(legacyId);

    expect(index.entries.some(entry => entry.kind === "task" && entry.text === "好")).toBe(false);
    expect(index.entries.some(entry => entry.text.includes("让我继续查看"))).toBe(false);
    expect(
      index.entries.some(
        entry => entry.kind === "fact" && entry.text.includes("test_files/u4.py")
      )
    ).toBe(true);
  });

  test("loading an existing session self-repairs polluted working state and unknown paths", async () => {
    const { root, store } = await createStore();
    const legacyId = "legacy-working-state";

    await writeFile(
      join(root, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          title: "legacy state",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          summary: [
            "OBJECTIVE:",
            "- 沿着 `src/memdir/memdir.ts` 继续梳理 memory 的调用链与落盘点",
            "",
            "CONFIRMED FACTS:",
            "- 项目名是 `@anthropic-ai/claude-code`。",
            "- `truncateEntrypointContent`",
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
            "REMAINING:",
            "- 这说明它的职责不是“执行记忆写入”，而是",
            "- 沿 `src/memdir/memdir.ts` 继续看 memory 文件读取、截断和 prompt 组装",
            "",
            "KNOWN PATHS:",
            "- src/memdir/memdir.ts",
            "- src/entrypoints/cli.tsx",
          ].join("\n"),
          focus: [],
          tags: [],
          messages: [
            {
              role: "user",
              text: "inspect package.json and src/bootstrap-entry.ts",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
            {
              role: "assistant",
              text: "package.json points to src/bootstrap-entry.ts",
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            {
              role: "user",
              text: "trace src/memdir/memdir.ts",
              createdAt: "2026-01-01T00:00:03.000Z",
            },
            {
              role: "assistant",
              text: "src/entrypoints/cli.tsx looks relevant",
              createdAt: "2026-01-01T00:00:04.000Z",
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const loaded = await store.loadSession(legacyId);

    expect(loaded?.summary).toContain(
      "OBJECTIVE:\n- 沿着 `src/memdir/memdir.ts` 继续梳理 memory 的调用链与落盘点"
    );
    expect(loaded?.summary).toContain("CONFIRMED FACTS:");
    expect(loaded?.summary).toContain("- 项目名是 `@anthropic-ai/claude-code`");
    expect(loaded?.summary).toContain(
      "KNOWN PATHS:\n- package.json\n- src/bootstrap-entry.ts"
    );
    expect(loaded?.summary).not.toContain("truncateEntrypointContent");
    expect(loaded?.summary).not.toContain("src/entrypoints/cli.tsx");
    expect(loaded?.pendingDigest).toContain(
      "REMAINING:\n- 沿 `src/memdir/memdir.ts` 继续看 memory 文件读取"
    );
    expect(loaded?.pendingDigest).toContain("KNOWN PATHS:\n- src/memdir/memdir.ts");
    expect(loaded?.pendingDigest).not.toContain("这说明它的职责不是");
    expect(loaded?.pendingDigest).not.toContain("下面基于已经拿到的");
  });

  test("dedupes repeated tool and error memories instead of appending duplicates", async () => {
    const { store } = await createStore();
    const session = await store.createSession("memory dedupe");

    await store.recordMemory(session.id, {
      kind: "tool_result",
      text: "Tool: write_file test_files/u4.py | Wrote file: test_files/u4.py",
      priority: 70,
      entities: {
        path: ["test_files/u4.py"],
        action: ["write_file"],
        status: ["ok"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "tool_result",
      text: "Tool: write_file test_files/u4.py | Wrote file: test_files/u4.py",
      priority: 70,
      entities: {
        path: ["test_files/u4.py"],
        action: ["write_file"],
        status: ["ok"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "error",
      text: "Approval error\npath: test_files/u4.py\nEEXIST",
      priority: 90,
      entities: {
        path: ["test_files/u4.py"],
        action: ["create_file"],
        status: ["error"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "error",
      text: "Approval error\npath: test_files/u4.py\nEEXIST",
      priority: 90,
      entities: {
        path: ["test_files/u4.py"],
        action: ["create_file"],
        status: ["error"],
      },
    });

    const index = await store.getMemoryIndex(session.id);
    const toolEntries = index.entries.filter(entry => entry.kind === "tool_result");
    const errorEntries = index.entries.filter(entry => entry.kind === "error");

    expect(toolEntries).toHaveLength(1);
    expect(errorEntries).toHaveLength(1);
    expect(toolEntries[0]?.hitCount).toBe(2);
    expect(errorEntries[0]?.hitCount).toBe(2);
  });

  test("persists system message kinds for resume transcript hydration", async () => {
    const { root, store } = await createStore();
    const session = await store.createSession("resume tool history");

    await store.appendMessage(session.id, {
      role: "system",
      kind: "tool_status",
      text: ["Tool: edit_file src/demo.ts | Updated file", "+    1 | const next = 1;"].join("\n"),
      createdAt: "2026-04-18T00:00:01.000Z",
    });
    await store.appendMessage(session.id, {
      role: "system",
      kind: "review_status",
      text: [
        "Approval required | edit_file src/demo.ts | rev-1",
        "[patch preview]",
        "+    1 | const next = 1;",
      ].join("\n"),
      createdAt: "2026-04-18T00:00:02.000Z",
    });

    const loaded = await store.loadSession(session.id);
    const stored = JSON.parse(
      await readFile(join(root, `${session.id}.json`), "utf8")
    ) as {
      messages: Array<{ kind?: string; text: string }>;
    };

    expect(loaded?.messages).toMatchObject([
      {
        role: "system",
        kind: "tool_status",
        text: "Tool: edit_file src/demo.ts | Updated file\n+    1 | const next = 1;",
      },
      {
        role: "system",
        kind: "review_status",
        text: [
          "Approval required | edit_file src/demo.ts | rev-1",
          "[patch preview]",
          "+    1 | const next = 1;",
        ].join("\n"),
      },
    ]);
    expect(stored.messages.map(message => message.kind)).toEqual([
      "tool_status",
      "review_status",
    ]);
  });

  test("prompt context prioritizes pins and query-matching indexed memories", async () => {
    const { store } = await createStore();
    const session = await store.createSession("retrieval");

    await store.appendMessage(session.id, {
      role: "user",
      text: "remember the dynamic programming task for test_files/u4.py",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.addFocus(session.id, "Always preserve dynamic programming examples");
    await store.recordMemory(session.id, {
      kind: "tool_result",
      text: "Tool: write_file test_files/u4.py | Wrote file: test_files/u4.py",
      priority: 70,
      entities: {
        path: ["test_files/u4.py"],
        action: ["write_file"],
        toolName: ["write_file"],
        status: ["ok"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "approval",
      text: "Approved\naction: create_file\npath: test_files/u4.py",
      priority: 80,
      entities: {
        path: ["test_files/u4.py"],
        action: ["create_file"],
        status: ["approved"],
      },
    });

    const context = await store.getPromptContext(session.id, "update test_files/u4.py");

    expect(context.pins[0]).toBe("Always preserve dynamic programming examples");
    expect(context.relevantMemories.some(item => item.includes("test_files/u4.py"))).toBe(true);
    expect(context.relevantMemories[0]?.includes("u4.py")).toBe(true);
    expect(context.archiveSections?.COMPLETED?.some(item => item.includes("u4.py"))).toBe(
      true
    );
    expect(context.archiveSections?.["KNOWN PATHS"]).toContain("test_files/u4.py");
  });

  test("prompt context prefers tool results over assistant facts for the same path", async () => {
    const { store } = await createStore();
    const session = await store.createSession("tool preference");

    await store.recordMemory(session.id, {
      kind: "fact",
      text: "src/query.ts is a complex query loop module",
      priority: 60,
      entities: {
        path: ["src/query.ts"],
        queryTerms: ["query", "module"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "tool_result",
      text: "Tool: read_file src/query.ts | // biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered",
      priority: 72,
      entities: {
        path: ["src/query.ts"],
        action: ["read_file"],
        toolName: ["read_file"],
        status: ["ok"],
      },
    });

    const context = await store.getPromptContext(session.id, "src/query.ts");

    expect(context.archiveSections?.["CONFIRMED FACTS"]?.[0]?.includes("[tool_result]")).toBe(
      true
    );
    expect(
      context.archiveSections?.["CONFIRMED FACTS"]?.some(item =>
        item.includes("src/query.ts")
      )
    ).toBe(true);
  });

  test("loading an existing sidecar index self-repairs polluted chatter entries", async () => {
    const { root, store } = await createStore();
    const sessionId = "polluted-index-session";
    const now = "2026-01-01T00:00:00.000Z";

    await writeFile(
      join(root, `${sessionId}.json`),
      JSON.stringify(
        {
          id: sessionId,
          title: "polluted index",
          createdAt: now,
          updatedAt: now,
          summary: "",
          focus: [],
          tags: [],
          messages: [],
        },
        null,
        2
      ),
      "utf8"
    );

    await writeFile(
      join(root, `${sessionId}.index.json`),
      JSON.stringify(
        {
          version: 1,
          sessionId,
          updatedAt: now,
          entries: [
            {
              id: "fact-1",
              sessionId,
              kind: "fact",
              text: "让我继续查看 src/query.ts 文件的更多内容。让我读取接下来的部分。",
              priority: 40,
              createdAt: now,
              tags: ["让我继续查看", "src/query.ts"],
              entities: {
                path: ["src/query.ts"],
                queryTerms: ["让我继续查看", "src/query.ts"],
              },
              dedupeKey: "fact:raw-chatter",
              hitCount: 1,
            },
            {
              id: "tool-1",
              sessionId,
              kind: "tool_result",
              text: "Tool: read_file src/query.ts | // biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered",
              priority: 72,
              createdAt: now,
              tags: ["src/query.ts", "read_file", "ok"],
              entities: {
                path: ["src/query.ts"],
                toolName: ["read_file"],
                action: ["read_file"],
                status: ["ok"],
                queryTerms: ["src/query.ts", "read_file"],
              },
              dedupeKey: "tool_result:read_file:src/query.ts:ok",
              hitCount: 1,
            },
          ],
          byKind: {
            fact: ["fact-1"],
            tool_result: ["tool-1"],
          },
          byPath: {
            "src/query.ts": ["fact-1", "tool-1"],
          },
          byTool: {
            read_file: ["tool-1"],
          },
          byAction: {
            read_file: ["tool-1"],
          },
          byPriority: ["tool-1", "fact-1"],
        },
        null,
        2
      ),
      "utf8"
    );

    const index = await store.getMemoryIndex(sessionId);
    const persisted = JSON.parse(
      await readFile(join(root, `${sessionId}.index.json`), "utf8")
    ) as { entries: Array<{ text: string }> };

    expect(index.entries.some(entry => entry.text.includes("让我继续查看"))).toBe(false);
    expect(index.entries.some(entry => entry.kind === "tool_result")).toBe(true);
    expect(persisted.entries.some(entry => entry.text.includes("让我继续查看"))).toBe(false);
  });

  test("working-state remaining/known-path signals help archive retrieval even for generic follow-up queries", async () => {
    const { store } = await createStore();
    const session = await store.createSession("continue task");

    await store.recordMemory(session.id, {
      kind: "tool_result",
      text: "Tool: write_file src/auth/oauth.ts | Wrote file: src/auth/oauth.ts",
      priority: 78,
      entities: {
        path: ["src/auth/oauth.ts"],
        action: ["write_file"],
        toolName: ["write_file"],
        status: ["ok"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "error",
      text: "Approval error\npath: src/auth/oauth.ts\npending review still required",
      priority: 88,
      entities: {
        path: ["src/auth/oauth.ts"],
        action: ["edit_file"],
        status: ["error"],
      },
    });
    await store.updateSummary(
      session.id,
      [
        "OBJECTIVE:",
        "- continue oauth follow-up",
        "",
        "CONFIRMED FACTS:",
        "- src/auth/oauth.ts was already edited once",
        "",
        "CONSTRAINTS:",
        "- approval is still required before further mutation",
        "",
        "COMPLETED:",
        "- initial oauth file write finished",
        "",
        "REMAINING:",
        "- continue work in src/auth/oauth.ts",
        "",
        "KNOWN PATHS:",
        "- src/auth/oauth.ts",
        "",
        "RECENT FAILURES:",
        "- approval error on src/auth/oauth.ts",
        "",
        "NEXT BEST ACTIONS:",
        "- resume the oauth task without re-scanning unrelated files",
      ].join("\n")
    );

    const context = await store.getPromptContext(session.id, "continue");

    expect(context.archiveSections?.["KNOWN PATHS"]).toContain("src/auth/oauth.ts");
    expect(
      context.archiveSections?.["RECENT FAILURES"]?.some(item =>
        item.includes("oauth.ts")
      )
    ).toBe(true);
    expect(context.relevantMemories.some(item => item.includes("src/auth/oauth.ts"))).toBe(true);
  });

  test("archive section retrieval filters polluted failures and generic next actions", async () => {
    const { store } = await createStore();
    const session = await store.createSession("polluted archive");

    await store.recordMemory(session.id, {
      kind: "error",
      text: "src/memdir/paths.js 不存在",
      priority: 92,
      entities: {
        path: ["src/memdir/paths.js"],
        status: ["error"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "fact",
      text: "这会导致模型被旧信息、无关信息甚至错误信息影响",
      priority: 80,
    });
    await store.recordMemory(session.id, {
      kind: "task",
      text: "目标是尽量恢复到“可运行、可继续修复”的状态",
      priority: 90,
    });
    await store.recordMemory(session.id, {
      kind: "task",
      text: "直接编辑 src/bootstrap-entry.ts",
      priority: 90,
      entities: {
        path: ["src/bootstrap-entry.ts"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "error",
      text: "Tool error: run_command bun test timed out",
      priority: 93,
      entities: {
        action: ["run_command"],
        toolName: ["run_command"],
        status: ["error"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "task",
      text: "验证 `src/core/session/stateReducer.ts` 的 summary 过滤测试",
      priority: 91,
      entities: {
        path: ["src/core/session/stateReducer.ts"],
      },
    });

    const context = await store.getPromptContext(session.id, "summary 过滤");

    expect(context.archiveSections?.["RECENT FAILURES"]).toContain(
      "[error] Tool error: run_command bun test timed out"
    );
    expect(context.archiveSections?.["RECENT FAILURES"]?.join("\n")).not.toContain(
      "src/memdir/paths.js 不存在"
    );
    expect(context.archiveSections?.["RECENT FAILURES"]?.join("\n")).not.toContain(
      "旧信息"
    );
    expect(context.archiveSections?.["NEXT BEST ACTIONS"]).toContain(
      "验证 `src/core/session/stateReducer.ts` 的 summary 过滤测试"
    );
    expect(context.archiveSections?.["NEXT BEST ACTIONS"]?.join("\n")).not.toContain(
      "目标是尽量恢复"
    );
  });

  test("rebuild drops disposable memory noise and missing-path entries do not restore known paths", async () => {
    const { root, store } = await createStore();
    const sessionId = "discard-memory-noise";
    const now = "2026-01-01T00:00:00.000Z";

    await writeFile(
      join(root, `${sessionId}.json`),
      JSON.stringify(
        {
          id: sessionId,
          title: "discard noise",
          createdAt: now,
          updatedAt: now,
          summary: "",
          pendingDigest: [
            "CONFIRMED FACTS:",
            "- 项目中不存在 `src/memdir/paths.js`",
            "",
            "KNOWN PATHS:",
            "- src/memdir/paths.js",
          ].join("\n"),
          focus: [],
          tags: [],
          messages: [],
        },
        null,
        2
      ),
      "utf8"
    );

    await writeFile(
      join(root, `${sessionId}.index.json`),
      JSON.stringify(
        {
          version: 1,
          sessionId,
          updatedAt: now,
          entries: [
            {
              id: "fact-noise",
              sessionId,
              kind: "fact",
              text: "这会导致模型被旧信息、无关信息甚至错误信息影响",
              priority: 80,
              createdAt: now,
              tags: [],
              entities: {},
              dedupeKey: "fact:noise",
            },
            {
              id: "task-noise",
              sessionId,
              kind: "task",
              text: "目标是尽量恢复到“可运行、可继续修复”的状态",
              priority: 90,
              createdAt: now,
              tags: [],
              entities: {},
              dedupeKey: "task:noise",
            },
            {
              id: "missing-error",
              sessionId,
              kind: "error",
              text: "read_file `src/memdir/paths.js` 失败: ENOENT: no such file or directory",
              priority: 92,
              createdAt: now,
              tags: ["src/memdir/paths.js", "error"],
              entities: {
                path: ["src/memdir/paths.js"],
                action: ["read_file"],
                status: ["error"],
              },
              dedupeKey: "error:read_file:src/memdir/paths.js:enoent",
            },
          ],
          byKind: {
            fact: ["fact-noise"],
            task: ["task-noise"],
            error: ["missing-error"],
          },
          byPath: {
            "src/memdir/paths.js": ["missing-error"],
          },
          byTool: {},
          byAction: {
            read_file: ["missing-error"],
          },
          byPriority: ["missing-error", "task-noise", "fact-noise"],
        },
        null,
        2
      ),
      "utf8"
    );

    const loaded = await store.loadSession(sessionId);
    const index = await store.getMemoryIndex(sessionId);
    const context = await store.getPromptContext(sessionId, "continue");

    expect(index.entries.some(entry => entry.text.includes("旧信息"))).toBe(false);
    expect(index.entries.some(entry => entry.text.includes("可运行、可继续修复"))).toBe(false);
    expect(loaded?.pendingDigest).toContain(
      "CONFIRMED FACTS:\n- 项目中不存在 `src/memdir/paths.js`"
    );
    expect(loaded?.pendingDigest).not.toContain("KNOWN PATHS:\n- src/memdir/paths.js");
    expect(context.archiveSections?.["KNOWN PATHS"] ?? []).not.toContain(
      "src/memdir/paths.js"
    );
  });

  test("prompt context retrieves a larger archive slice for low-information continuations", async () => {
    const { store } = await createStore();
    const session = await store.createSession("archive budget");

    for (const [index, path] of [
      "src/refactor/a.ts",
      "src/refactor/b.ts",
      "src/refactor/c.ts",
      "src/refactor/d.ts",
      "src/refactor/e.ts",
    ].entries()) {
      await store.recordMemory(session.id, {
        kind: "tool_result",
        text: `Tool: write_file ${path} | Wrote file: ${path}`,
        priority: 78,
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
        entities: {
          path: [path],
          action: ["write_file"],
          toolName: ["write_file"],
          status: ["ok"],
        },
      });
    }

    const context = await store.getPromptContext(session.id, "continue");

    expect(context.archiveSections?.COMPLETED).toHaveLength(4);
    expect(context.archiveSections?.COMPLETED?.some(item => item.includes("src/refactor/e.ts"))).toBe(
      true
    );
    expect(context.archiveSections?.COMPLETED?.some(item => item.includes("src/refactor/d.ts"))).toBe(
      true
    );
    expect(context.archiveSections?.["KNOWN PATHS"]).toHaveLength(5);
    expect(context.archiveSections?.["KNOWN PATHS"]).toContain("src/refactor/a.ts");
    expect(context.archiveSections?.["KNOWN PATHS"]).toContain("src/refactor/e.ts");
  });

  test("compacts oversized memory indexes while preserving high-signal entries", async () => {
    const { store } = await createStore();
    const session = await store.createSession("compaction");

    for (let index = 0; index < 210; index += 1) {
      await store.recordMemory(session.id, {
        kind: "fact",
        text: `generic note ${index + 1}`,
        priority: 10,
        createdAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      });
    }

    await store.recordMemory(session.id, {
      kind: "tool_result",
      text: "Tool: write_file src/critical/path.ts | Wrote file: src/critical/path.ts",
      priority: 85,
      entities: {
        path: ["src/critical/path.ts"],
        action: ["write_file"],
        toolName: ["write_file"],
        status: ["ok"],
      },
    });
    await store.recordMemory(session.id, {
      kind: "error",
      text: "Approval error\npath: src/critical/path.ts\npermission denied",
      priority: 92,
      entities: {
        path: ["src/critical/path.ts"],
        action: ["edit_file"],
        status: ["error"],
      },
    });

    const index = await store.getMemoryIndex(session.id);

    expect(index.entries.length).toBeLessThanOrEqual(140);
    expect(
      index.entries.some(entry => entry.text.includes("src/critical/path.ts"))
    ).toBe(true);
  });

  test("removeFocus updates derived pin memory without corrupting prompt context", async () => {
    const { store } = await createStore();
    const session = await store.createSession("pins");

    await store.addFocus(session.id, "first pin");
    await store.addFocus(session.id, "second pin");

    const before = await store.loadSession(session.id);
    expect(before?.focus).toEqual(["second pin", "first pin"]);

    await store.removeFocus(session.id, 0);

    const after = await store.loadSession(session.id);
    const context = await store.getPromptContext(session.id, "pin");

    expect(after?.focus).toEqual(["first pin"]);
    expect(context.pins).toEqual(["first pin"]);
  });

  test("removeFocus keeps newest pin ordering stable when timestamps tie", async () => {
    const { store } = await createStore();
    const session = await store.createSession("pins");
    const originalToISOString = Date.prototype.toISOString;

    Date.prototype.toISOString = function () {
      return "2026-01-01T00:00:00.000Z";
    };

    try {
      await store.addFocus(session.id, "first pin");
      await store.addFocus(session.id, "second pin");
    } finally {
      Date.prototype.toISOString = originalToISOString;
    }

    const before = await store.loadSession(session.id);
    expect(before?.focus).toEqual(["second pin", "first pin"]);

    await store.removeFocus(session.id, 0);

    const after = await store.loadSession(session.id);
    const context = await store.getPromptContext(session.id, "pin");

    expect(after?.focus).toEqual(["first pin"]);
    expect(context.pins).toEqual(["first pin"]);
  });

  test("tag operations persist on session and searchSessions can filter by tag", async () => {
    const { store } = await createStore();
    const alpha = await store.createSession("alpha feature rollout");
    const beta = await store.createSession("beta cleanup");

    await store.addTag(alpha.id, "feature");
    await store.addTag(alpha.id, "#urgent");
    await store.addTag(beta.id, "maintenance");

    const loaded = await store.loadSession(alpha.id);
    expect(loaded?.tags).toEqual(["feature", "urgent"]);

    const tagMatches = await store.searchSessions("", { tag: "feature" });
    expect(tagMatches.map(item => item.id)).toContain(alpha.id);
    expect(tagMatches.map(item => item.id)).not.toContain(beta.id);

    const queryMatches = await store.searchSessions("cleanup");
    expect(queryMatches.map(item => item.id)).toContain(beta.id);

    await store.removeTag(alpha.id, "urgent");
    const afterRemove = await store.loadSession(alpha.id);
    expect(afterRemove?.tags).toEqual(["feature"]);
  });

  test("default session store path follows configured global root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-session-root-"));
    tempRoots.push(root);
    const cyreneHome = join(root, ".cyrene");
    await mkdir(cyreneHome, { recursive: true });
    const cwdElsewhere = await mkdtemp(join(tmpdir(), "cyrene-session-cwd-"));
    tempRoots.push(cwdElsewhere);

    const store = createFileSessionStore(undefined, {
      cwd: cwdElsewhere,
      env: { CYRENE_HOME: cyreneHome, CYRENE_ROOT: root },
    });
    const session = await store.createSession("root aware");

    const persisted = await readFile(
      join(cyreneHome, "session", `${session.id}.json`),
      "utf8"
    );

    expect(persisted).toContain("\"title\": \"root aware\"");
    expect(persisted).toContain(`\"projectRoot\": \"${root.replace(/\\/g, "\\\\")}\"`);
  });

  test("session store context ignores unrelated configured app root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-session-root-"));
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "cyrene-session-other-root-"));
    tempRoots.push(root, unrelatedRoot);
    const cyreneHome = join(root, ".cyrene");
    await mkdir(cyreneHome, { recursive: true });
    await mkdir(join(unrelatedRoot, ".cyrene"), { recursive: true });
    setConfiguredAppRoot(unrelatedRoot);

    const store = createFileSessionStore(undefined, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome, CYRENE_ROOT: root },
    });
    const session = await store.createSession("scoped root");

    const expectedPath = join(cyreneHome, "session", `${session.id}.json`);
    const unexpectedPath = join(unrelatedRoot, ".cyrene", "session", `${session.id}.json`);

    const persisted = await readFile(expectedPath, "utf8");
    expect(persisted).toContain("\"title\": \"scoped root\"");

    await expect(stat(unexpectedPath)).rejects.toBeTruthy();
  });

  test("prompt context carries execution plan and linked working state", async () => {
    const { root, store } = await createStore();
    const session = await store.createSession("plan task");
    await store.appendMessage(session.id, {
      role: "user",
      text: "refactor the reducer flow",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await store.updateExecutionPlan(session.id, {
      capturedAt: "2026-01-01T00:00:05.000Z",
      sourcePreview: "refactor the reducer flow",
      projectRoot: root,
      summary: "Refactor the reducer flow in three steps",
      objective: "refactor the reducer flow",
      acceptedAt: "",
      acceptedSummary: "",
      steps: [
        {
          id: "step-1",
          title: "inspect reducer entry points",
          details: "",
          status: "completed",
          evidence: [],
          filePaths: ["src/core/session/stateReducer.ts"],
          recentToolResult: "Read state reducer",
        },
        {
          id: "step-2",
          title: "patch reducer transitions",
          details: "",
          status: "in_progress",
          evidence: [],
          filePaths: ["src/core/session/stateReducer.ts"],
          recentToolResult: "",
        },
        {
          id: "step-3",
          title: "run reducer tests",
          details: "",
          status: "pending",
          evidence: [],
          filePaths: ["tests/stateReducer.test.ts"],
          recentToolResult: "",
        },
      ],
    });

    const context = await store.getPromptContext(session.id, "continue");
    expect(context.executionPlan?.steps).toHaveLength(3);
    expect(context.executionPlan?.steps[1]?.title).toBe("patch reducer transitions");
    expect(context.durableSummary).toContain("OBJECTIVE:\n- refactor the reducer flow");
    expect(context.pendingDigest).toContain(
      "NEXT BEST ACTIONS:\n- Continue with active plan step: patch reducer transitions"
    );
  });

  test("only one session can retain an execution plan at a time", async () => {
    const { root, store } = await createStore();
    const alpha = await store.createSession("alpha task");
    const beta = await store.createSession("beta task");

    await store.updateExecutionPlan(alpha.id, {
      capturedAt: "2026-01-01T00:00:05.000Z",
      sourcePreview: "alpha",
      projectRoot: root,
      summary: "Alpha plan",
      objective: "alpha objective",
      acceptedAt: "",
      acceptedSummary: "",
      steps: [
        {
          id: "step-1",
          title: "alpha step",
          details: "",
          status: "in_progress",
          evidence: [],
          filePaths: [],
          recentToolResult: "",
        },
      ],
    });

    await store.updateExecutionPlan(beta.id, {
      capturedAt: "2026-01-01T00:00:06.000Z",
      sourcePreview: "beta",
      projectRoot: root,
      summary: "Beta plan",
      objective: "beta objective",
      acceptedAt: "",
      acceptedSummary: "",
      steps: [
        {
          id: "step-1",
          title: "beta step",
          details: "",
          status: "in_progress",
          evidence: [],
          filePaths: [],
          recentToolResult: "",
        },
      ],
    });

    const alphaAfter = await store.loadSession(alpha.id);
    const betaAfter = await store.loadSession(beta.id);

    expect(alphaAfter?.executionPlan).toBeNull();
    expect(alphaAfter?.summary).not.toContain("Remaining plan step:");
    expect(alphaAfter?.pendingDigest).not.toContain("Continue with active plan step:");
    expect(betaAfter?.executionPlan?.projectRoot).toBe(root);
    expect(betaAfter?.executionPlan?.summary).toBe("Beta plan");
  });
});
