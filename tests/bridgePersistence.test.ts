import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BubbleTeaBridge } from "../src/frontend/components/v2/bridge";
import { createFileSessionStore } from "../src/infra/session/createFileSessionStore";

const tempRoots: string[] = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

const createStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-bridge-persist-"));
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
  process.stdout.write = originalStdoutWrite;
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

describe("bridge session persistence", () => {
  test("persists assistant transcript items into the session store", async () => {
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const { store } = await createStore();
    const session = await store.createSession("persist transcript");
    const bridge = new BubbleTeaBridge();

    (bridge as any).sessionStore = store;

    await (bridge as any).persistSessionItem(session.id, {
      role: "assistant",
      kind: "transcript",
      text: "resume 后不能丢这段回答",
    });

    const loaded = await store.loadSession(session.id);

    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]).toMatchObject({
      role: "assistant",
      kind: "transcript",
      text: "resume 后不能丢这段回答",
    });
  });

  test("persists pending digest facts immediately after a tool result", async () => {
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const { store } = await createStore();
    const session = await store.createSession("persist tool facts");
    const bridge = new BubbleTeaBridge();

    (bridge as any).sessionStore = store;

    await (bridge as any).applyToolResultPendingDigest(
      session.id,
      "fix src/app.ts only",
      "file",
      {
        action: "read_range",
        path: "src/app.ts",
        startLine: 1,
        endLine: 80,
      },
      "[tool result] read_range src/app.ts\n1 | export const current = true;\n",
      {
        kind: "file",
        action: "read_range",
        workspacePath: "src/app.ts",
        read: {
          mode: "range",
          startLine: 1,
          endLine: 80,
        },
      }
    );

    const loaded = await store.loadSession(session.id);

    expect(loaded?.pendingDigest).toContain("KNOWN PATHS:\n- src/app.ts");
    expect(loaded?.pendingDigest).toContain(
      "CONFIRMED FACTS:\n- 目标文件是 `src/app.ts`"
    );
    expect(loaded?.pendingDigest).toContain("COMPLETED:\n- 已确认读取 `src/app.ts` 第 1-80 行");
    expect(loaded?.pendingDigest).toContain("NEXT BEST ACTIONS:\n- (none)");
  });

  test("records structured tool-result memory with source anchors", async () => {
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const { store } = await createStore();
    const session = await store.createSession("persist tool anchors");
    const bridge = new BubbleTeaBridge();

    (bridge as any).sessionStore = store;

    await (bridge as any).applyToolResultPendingDigest(
      session.id,
      "inspect src/app.ts",
      "file",
      {
        action: "read_range",
        path: "src/app.ts",
        startLine: 41,
        endLine: 80,
      },
      "[tool result] read_range src/app.ts\n41 | export const current = true;\n",
      {
        kind: "file",
        action: "read_range",
        workspacePath: "src/app.ts",
        read: {
          mode: "range",
          startLine: 41,
          endLine: 80,
        },
      }
    );

    const index = await store.getMemoryIndex(session.id);
    const toolEntry = index.entries.find(entry => entry.kind === "tool_result");

    expect(toolEntry).toBeTruthy();
    expect(toolEntry?.text).toContain("read_range `src/app.ts` 覆盖第 41-80 行");
    expect(toolEntry?.entities.path).toContain("src/app.ts");
  });
});
