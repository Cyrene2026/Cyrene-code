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
});
