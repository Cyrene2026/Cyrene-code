import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMcpService } from "../src/core/tools/mcp/fileMcpService";

const tempRoots: string[] = [];

const createService = async (options?: ConstructorParameters<typeof FileMcpService>[1]) => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
  tempRoots.push(root);
  const service = new FileMcpService({
    workspaceRoot: root,
    maxReadBytes: 1024 * 1024,
    requireReview: ["create_file", "write_file", "edit_file", "delete_file"],
  }, options);
  return { root, service };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

describe("FileMcpService", () => {
  test("read_file executes immediately without review", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "hello.txt"), "hello world", "utf8");

    const result = await service.handleToolCall("file", {
      action: "read_file",
      path: "hello.txt",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] read_file hello.txt");
    expect(result.message).toContain("hello world");
  });

  test("create_file enters review queue and approve writes file", async () => {
    const { root, service } = await createService();

    const queued = await service.handleToolCall("file", {
      action: "create_file",
      path: "nested/example.py",
      content: "print('ok')\n",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending).toBeDefined();
    expect(service.listPending()).toHaveLength(1);

    const pending = queued.pending!;
    const approved = await service.approve(pending.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("[approved]");
    expect(service.listPending()).toHaveLength(0);

    const content = await readFile(join(root, "nested", "example.py"), "utf8");
    expect(content).toBe("print('ok')\n");
  });

  test("approve returns error when create_file target already exists", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "test_files"), { recursive: true });
    await writeFile(join(root, "test_files", "u4.py"), "print('existing')\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "create_file",
      path: "test_files/u4.py",
      content: "print('new')\n",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("create_file target already exists");
    expect(service.listPending()).toHaveLength(0);

    const content = await readFile(join(root, "test_files", "u4.py"), "utf8");
    expect(content).toBe("print('existing')\n");
  });

  test("reject removes pending item", async () => {
    const { service } = await createService();

    const queued = await service.handleToolCall("file", {
      action: "write_file",
      path: "draft.txt",
      content: "draft",
    });

    expect(service.listPending()).toHaveLength(1);

    const rejected = service.reject(queued.pending!.id);

    expect(rejected.ok).toBe(true);
    expect(rejected.message).toContain("[rejected]");
    expect(service.listPending()).toHaveLength(0);
  });

  test("delete_file approves and removes the target file", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "remove-me.txt"), "bye", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "delete_file",
      path: "remove-me.txt",
    });

    expect(queued.pending).toBeDefined();

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    await expect(readFile(join(root, "remove-me.txt"), "utf8")).rejects.toThrow();
  });

  test("edit_file rejects before queue when find text does not exist", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "edit.txt"), "hello world", "utf8");

    const result = await service.handleToolCall("file", {
      action: "edit_file",
      path: "edit.txt",
      find: "missing",
      replace: "patched",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("edit_file find text not found");
    expect(service.listPending()).toHaveLength(0);
  });

  test("rejects unsupported tool name", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("unknown", {
      action: "read_file",
      path: "hello.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unsupported tool");
  });

  test("rejects invalid tool input", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      foo: "bar",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid tool input");
  });

  test("blocks paths that escape workspace root", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "read_file",
      path: "../outside.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Path escapes workspace root");
  });

  test("rejects duplicate pending create_file for same path", async () => {
    const { service } = await createService();

    const first = await service.handleToolCall("file", {
      action: "create_file",
      path: "test_files/file1.py",
      content: "print('one')\n",
    });
    const second = await service.handleToolCall("file", {
      action: "create_file",
      path: ".\\test_files\\file1.py",
      content: "print('two')\n",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toContain(
      "Pending conflict: create_file test_files/file1.py is already queued."
    );
    expect(service.listPending()).toHaveLength(1);
  });

  test("rejects mixed pending write conflict for same path", async () => {
    const { service } = await createService();

    const first = await service.handleToolCall("file", {
      action: "write_file",
      path: "test_files/conflict.py",
      content: "print('one')\n",
    });
    const second = await service.handleToolCall("file", {
      action: "edit_file",
      path: "test_files/conflict.py",
      find: "one",
      replace: "two",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toContain(
      "Pending conflict: write_file test_files/conflict.py is already queued."
    );
    expect(service.listPending()).toHaveLength(1);
  });

  test("rejects delete_file when a write operation for same path is already queued", async () => {
    const { service } = await createService();

    const first = await service.handleToolCall("file", {
      action: "write_file",
      path: "test_files/delete-conflict.py",
      content: "print('one')\n",
    });
    const second = await service.handleToolCall("file", {
      action: "delete_file",
      path: "test_files/delete-conflict.py",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toContain(
      "Pending conflict: write_file test_files/delete-conflict.py is already queued."
    );
  });

  test("delete_file rejects before queue when target does not exist", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "delete_file",
      path: "missing.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("delete_file target does not exist");
    expect(service.listPending()).toHaveLength(0);
  });

  test("write_file preview shows overwrite diff for existing target", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "overwrite.txt"), "old line\n", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "write_file",
      path: "overwrite.txt",
      content: "new line\n",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.previewSummary).toContain("[write preview | overwrite]");
    expect(queued.pending?.previewSummary).toContain("[old - to be overwritten]");
    expect(queued.pending?.previewSummary).toContain("[new + to be written]");
  });

  test("write_file allows missing target and creates file after approval", async () => {
    const { root, service } = await createService();

    const queued = await service.handleToolCall("file", {
      action: "write_file",
      path: "new-write.txt",
      content: "written\n",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.previewSummary).toContain("[write preview | new file]");

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(await readFile(join(root, "new-write.txt"), "utf8")).toBe("written\n");
  });

  test("create_file preview marks new-only semantics", async () => {
    const { service } = await createService();

    const queued = await service.handleToolCall("file", {
      action: "create_file",
      path: "brand_new.py",
      content: "print('new')\n",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.previewSummary).toContain("[create preview | new only]");
  });

  test("edit_file rejects before queue when target does not exist", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "edit_file",
      path: "missing-edit.txt",
      find: "old",
      replace: "new",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("edit_file target does not exist");
    expect(service.listPending()).toHaveLength(0);
  });

  test("run_command enters review queue and executes allowed command on approve", async () => {
    const { root, service } = await createService({
      commandRunner: async (request, cwd) => {
        expect(request.command).toBe("node");
        expect(request.args).toEqual(["--version"]);
        expect(cwd).toBe(root);
        return "v24.14.0";
      },
    });

    const queued = await service.handleToolCall("shell", {
      command: "node",
      args: ["--version"],
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending).toBeDefined();
    expect(queued.pending?.request.action).toBe("run_command");

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("[approved]");
    expect(approved.message).toContain("v24.14.0");
  });

  test("run_command allows arbitrary command names but still enters review queue", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("shell", {
      command: "curl",
      args: ["--version"],
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeDefined();
    expect(result.pending?.request.action).toBe("run_command");
    expect((result.pending?.request as any).command).toBe("curl");
  });
});
