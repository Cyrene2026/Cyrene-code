import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfiguredAppRoot } from "../src/infra/config/appRoot";
import { createFileSessionStore } from "../src/infra/session/createFileSessionStore";

const tempRoots: string[] = [];

const createStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-session-memory-"));
  tempRoots.push(root);
  return {
    root,
    store: createFileSessionStore(root),
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

  test("default session store path follows configured global root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-session-root-"));
    tempRoots.push(root);
    await mkdir(join(root, ".cyrene"), { recursive: true });
    const cwdElsewhere = await mkdtemp(join(tmpdir(), "cyrene-session-cwd-"));
    tempRoots.push(cwdElsewhere);

    const store = createFileSessionStore(undefined, {
      cwd: cwdElsewhere,
      env: { CYRENE_ROOT: root },
    });
    const session = await store.createSession("root aware");

    const persisted = await readFile(
      join(root, ".cyrene", "session", `${session.id}.json`),
      "utf8"
    );

    expect(persisted).toContain("\"title\": \"root aware\"");
  });
});
