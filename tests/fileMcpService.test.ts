import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  FileMcpService,
  isPathInsideWorkspaceRoot,
} from "../src/core/tools/mcp/fileMcpService";

const tempRoots: string[] = [];

const createService = async (options?: ConstructorParameters<typeof FileMcpService>[1]) => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
  tempRoots.push(root);
  const service = new FileMcpService({
    workspaceRoot: root,
    maxReadBytes: 1024 * 1024,
    requireReview: [
      "create_file",
      "write_file",
      "edit_file",
      "delete_file",
      "copy_path",
      "move_path",
    ],
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

  test("list_dir confirms directory state in result output", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "test_files"), { recursive: true });
    await writeFile(join(root, "test_files", "u1.py"), "print('ok')\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "list_dir",
      path: "test_files",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("[confirmed directory state] test_files");
    expect(result.message).toContain("[F] u1.py");
  });

  test("list_dir short-circuits repeated immediate reads for same directory", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "test_files"), { recursive: true });
    await writeFile(join(root, "test_files", "u1.py"), "print('ok')\n", "utf8");

    const first = await service.handleToolCall("file", {
      action: "list_dir",
      path: "test_files",
    });
    const second = await service.handleToolCall("file", {
      action: "list_dir",
      path: "test_files",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.message).toContain("cached; no mutation since last check");

    await writeFile(join(root, "test_files", "u2.py"), "print('new')\n", "utf8");
    const writeResult = await service.handleToolCall("file", {
      action: "write_file",
      path: "test_files/u3.py",
      content: "print('fresh')\n",
    });
    expect(writeResult.ok).toBe(true);
    if (!writeResult.pending) {
      throw new Error("expected write_file to queue for approval");
    }
    const approved = await service.approve(writeResult.pending.id);
    expect(approved.ok).toBe(true);

    const third = await service.handleToolCall("file", {
      action: "list_dir",
      path: "test_files",
    });
    expect(third.ok).toBe(true);
    expect(third.message).not.toContain("cached; no mutation since last check");
  });

  test("read_file returns explicit empty-file marker", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "empty.txt"), "", "utf8");

    const result = await service.handleToolCall("file", {
      action: "read_file",
      path: "empty.txt",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("(empty file)");
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

  test("search_text accepts placeholder-heavy payloads by defaulting path and query", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "oauth-notes.txt"), "oauth callback flow\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "search_text",
      args: ["oauth"],
      caseSensitive: false,
      command: "",
      content: "",
      cwd: ".",
      destination: "",
      find: "",
      maxResults: 20,
      path: "",
      pattern: "",
      query: "",
      replace: "",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 match(es):");
    expect(result.message).toContain("docs/oauth-notes.txt:1");
    expect(result.message).toContain("oauth callback flow");
  });

  test("find_files accepts placeholder-heavy payloads by defaulting path to workspace root", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "features"), { recursive: true });
    await writeFile(join(root, "features", "oauth-client.ts"), "export {};\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "find_files",
      args: [],
      caseSensitive: true,
      command: "",
      content: "",
      cwd: ".",
      destination: "",
      find: "",
      maxResults: 200,
      path: "",
      pattern: "**/*oauth*",
      query: "",
      replace: "",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 file(s):");
    expect(result.message).toContain("features/oauth-client.ts");
  });

  test("search_text returns targeted guidance when query is still missing", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "search_text",
      args: [],
      caseSensitive: false,
      command: "",
      content: "",
      cwd: ".",
      destination: "",
      find: "",
      maxResults: 20,
      path: "",
      pattern: "",
      query: "",
      replace: "",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid tool input for search_text");
    expect(result.message).toContain("search_text requires `query`");
    expect(result.message).toContain('Use `path: "."` when searching the whole workspace');
  });

  test("find_files returns targeted guidance when pattern is still missing", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "find_files",
      args: [],
      caseSensitive: true,
      command: "",
      content: "",
      cwd: ".",
      destination: "",
      find: "",
      maxResults: 200,
      path: "",
      pattern: "",
      query: "",
      replace: "",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid tool input for find_files");
    expect(result.message).toContain("find_files requires `pattern`");
    expect(result.message).toContain('Use `path: "."` when searching the whole workspace');
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

  test("allows workspace root paths and subpaths under posix semantics", () => {
    expect(isPathInsideWorkspaceRoot("/root/project", "/root/project", posix)).toBe(true);
    expect(isPathInsideWorkspaceRoot("/root/project/src/file.ts", "/root/project", posix)).toBe(
      true
    );
    expect(
      isPathInsideWorkspaceRoot("/root/project-sibling/src/file.ts", "/root/project", posix)
    ).toBe(false);
    expect(isPathInsideWorkspaceRoot("/root/project/../outside.txt", "/root/project", posix)).toBe(
      false
    );
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

  test("stat_path executes immediately and returns stable metadata", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "meta.txt"), "hello", "utf8");

    const result = await service.handleToolCall("file", {
      action: "stat_path",
      path: "meta.txt",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] stat_path meta.txt");
    expect(result.message).toContain("kind: file");
    expect(result.message).toContain("size: 5");
  });

  test("find_files executes immediately and returns matching workspace-relative paths", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "test_files"), { recursive: true });
    await writeFile(join(root, "test_files", "u1.py"), "print('one')\n", "utf8");
    await writeFile(join(root, "test_files", "u2.ts"), "export const two = 2;\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "find_files",
      path: "test_files",
      pattern: "*.py",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 file(s):");
    expect(result.message).toContain("test_files/u1.py");
    expect(result.message).not.toContain("test_files/u2.ts");
  });

  test("search_text executes immediately and returns line-level matches", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.txt"), "alpha\nneedle here\nomega\n", "utf8");
    await writeFile(join(root, "docs", "b.txt"), "another needle hit\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "search_text",
      path: "docs",
      query: "needle",
      maxResults: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 match(es):");
    expect(result.message).toContain("docs/");
    expect(result.message).toContain("needle");
  });

  test("copy_path enters review queue and copies file on approve", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "original.txt"), "copy me", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "copy_path",
      path: "src/original.txt",
      destination: "dest/copied.txt",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.previewSummary).toContain("destination=dest/copied.txt");
    expect(queued.pending?.previewSummary).toContain("[copy preview]");

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(await readFile(join(root, "dest", "copied.txt"), "utf8")).toBe("copy me");
    expect(await readFile(join(root, "src", "original.txt"), "utf8")).toBe("copy me");
  });

  test("move_path enters review queue and moves file on approve", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "move-me.txt"), "move me", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "move_path",
      path: "src/move-me.txt",
      destination: "dest/moved.txt",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.previewSummary).toContain("[move preview]");

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(await readFile(join(root, "dest", "moved.txt"), "utf8")).toBe("move me");
    await expect(readFile(join(root, "src", "move-me.txt"), "utf8")).rejects.toThrow();
  });

  test("copy_path rejects before queue when destination already exists", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "dest"), { recursive: true });
    await writeFile(join(root, "src", "original.txt"), "copy me", "utf8");
    await writeFile(join(root, "dest", "copied.txt"), "existing", "utf8");

    const result = await service.handleToolCall("file", {
      action: "copy_path",
      path: "src/original.txt",
      destination: "dest/copied.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("copy_path destination already exists");
    expect(service.listPending()).toHaveLength(0);
  });

  test("move_path conflicts on source or destination path already queued", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "src", "a.txt"), "a", "utf8");
    await writeFile(join(root, "other", "b.txt"), "b", "utf8");

    const first = await service.handleToolCall("file", {
      action: "move_path",
      path: "src/a.txt",
      destination: "dest/shared.txt",
    });
    const second = await service.handleToolCall("file", {
      action: "copy_path",
      path: "other/b.txt",
      destination: "dest/shared.txt",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toContain(
      "Pending conflict: move_path src/a.txt is already queued."
    );
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

    const queued = await service.handleToolCall("file", {
      action: "run_command",
      path: ".",
      command: "node",
      args: ["--version"],
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending).toBeDefined();
    expect(queued.pending?.request.action).toBe("run_command");

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("[approved]");
    expect(approved.message).toContain("status: completed");
    expect(approved.message).toContain("command: node");
    expect(approved.message).toContain("args: --version");
    expect(approved.message).toContain("cwd: .");
    expect(approved.message).toContain("exit: 0");
    expect(approved.message).toContain("v24.14.0");
  });

  test("run_command allows arbitrary command names but still enters review queue", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "run_command",
      path: ".",
      command: "curl",
      args: ["--version"],
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeDefined();
    expect(result.pending?.request.action).toBe("run_command");
    expect((result.pending?.request as any).command).toBe("curl");
  });

  test("run_command returns stable failed result text when execution fails", async () => {
    const { service } = await createService({
      commandRunner: async () => {
        throw new Error("command exploded");
      },
    });

    const queued = await service.handleToolCall("file", {
      action: "run_command",
      path: ".",
      command: "node",
      args: ["broken.js"],
    });
    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("status: failed");
    expect(approved.message).toContain("exit: unknown");
    expect(approved.message).toContain("command exploded");
  });

  test("run_command marks truncated bounded output explicitly", async () => {
    const { service } = await createService({
      commandRunner: async () => "x".repeat(25_000),
    });

    const queued = await service.handleToolCall("file", {
      action: "run_command",
      path: ".",
      command: "node",
      args: ["--print", "hello"],
    });
    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("output_truncated: true");
  });

  test("run_command keeps stable timeout semantics", async () => {
    const { service } = await createService({
      commandRunner: async () =>
        ({
          status: "timed_out",
          exitCode: null,
          stderr: "Command timed out after 20000ms.",
        }) as any,
    });

    const queued = await service.handleToolCall("file", {
      action: "run_command",
      path: ".",
      command: "node",
      args: ["slow.js"],
    });
    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("status: timed_out");
    expect(approved.message).toContain("exit: timeout");
    expect(approved.message).toContain("Command timed out");
  });

  test("run_shell enters review queue and executes through platform shell on approve", async () => {
    const { root, service } = await createService({
      shellRunner: async (request, cwd, shell) => {
        expect(request.command).toBe("Get-ChildItem test_files");
        expect(cwd).toBe(root);
        expect(shell).toBe(process.platform === "win32" ? "pwsh" : "sh");
        return "ok";
      },
    });

    const queued = await service.handleToolCall("file", {
      action: "run_shell",
      path: ".",
      command: "Get-ChildItem test_files",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.request.action).toBe("run_shell");
    expect(queued.pending?.previewSummary).toContain("[shell preview]");
    expect(queued.pending?.previewSummary).toContain("risk: low");

    const approved = await service.approve(queued.pending!.id);
    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("shell:");
    expect(approved.message).toContain("command: Get-ChildItem test_files");
  });

  test("run_shell blocks pipes and chaining before review", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "run_shell",
      path: ".",
      command: "ls | cat",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("run_shell blocked");
    expect(service.listPending()).toHaveLength(0);
  });

  test("run_shell blocks dangerous root deletion before review", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "run_shell",
      path: ".",
      command: "rm -rf /",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("dangerous root deletion");
    expect(service.listPending()).toHaveLength(0);
  });

  test("run_shell blocks workspace-escaping mutation targets before review", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "run_shell",
      path: ".",
      command: "touch ../outside.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("outside the workspace root");
    expect(service.listPending()).toHaveLength(0);
  });
});
