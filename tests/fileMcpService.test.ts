import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  FileMcpService,
  isPathInsideWorkspaceRoot,
} from "../src/core/mcp";

const tempRoots: string[] = [];
const services: FileMcpService[] = [];

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
      "apply_patch",
      "delete_file",
      "copy_path",
      "move_path",
      "open_shell",
      "write_shell",
    ],
  }, options);
  services.push(service);
  return { root, service };
};

const createIsolatedService = async (
  options?: ConstructorParameters<typeof FileMcpService>[1]
) => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
  const service = new FileMcpService({
    workspaceRoot: root,
    maxReadBytes: 1024 * 1024,
    requireReview: [
      "create_file",
      "write_file",
      "edit_file",
      "apply_patch",
      "delete_file",
      "copy_path",
      "move_path",
      "open_shell",
      "write_shell",
    ],
  }, options);

  return {
    root,
    service,
    cleanup: async () => {
      service.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
};

const createFakePersistentShellFactory = () => {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: string | number }) => void> =
    [];
  const state = {
    cwd: "",
    env: {} as Record<string, string>,
    writes: [] as string[],
    killedSignals: [] as string[],
    openFile: "",
  };

  const emit = (data: string) => {
    for (const listener of dataListeners) {
      listener(data);
    }
  };

  const emitExit = (exitCode: number, signal?: string | number) => {
    for (const listener of exitListeners) {
      listener({ exitCode, signal });
    }
  };

  const parseCommandId = (payload: string) =>
    /__CYRENE_STATUS__([a-z0-9-]+)__/i.exec(payload)?.[1] ?? "unknown";

  const parseWrappedInput = (payload: string) => {
    const lines = payload
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    return (
      lines.find(
        line =>
          line !== "& {" &&
          line !== "{" &&
          line !== "}" &&
          !line.startsWith("$cyreneSuccess") &&
          !line.startsWith("$cyreneExit") &&
          !line.startsWith("$cyrenePwd") &&
          !line.startsWith("__cyrene_exit=") &&
          !line.startsWith("__cyrene_pwd=") &&
          !line.includes("__CYRENE_STATUS__") &&
          !line.includes("__CYRENE_CWD__") &&
          !line.startsWith("Write-Output")
      ) ?? ""
    );
  };

  const emitMarkers = (commandId: string, exitCode: number) => {
    emit(
      `__CYRENE_STATUS__${commandId}__${exitCode}\n__CYRENE_CWD__${commandId}__${state.cwd}\n`
    );
  };

  const factory = async (options: {
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    name: string;
    cols: number;
    rows: number;
  }) => {
    state.cwd = options.cwd;
    state.env = { ...options.env };
    state.openFile = options.file;
    emit("shell ready\n");

    return {
      write(data: string) {
        state.writes.push(data);
        if (data === "\u0003") {
          emit("^C\n");
          return;
        }

        const commandId = parseCommandId(data);
        const input = parseWrappedInput(data);
        if (!input) {
          return;
        }

        if (input === "cd subdir") {
          state.cwd = join(state.cwd, "subdir");
          emit("changed directory\n");
          emitMarkers(commandId, 0);
          return;
        }

        if (input === ". .venv/bin/activate" || input === ".\\.venv\\Scripts\\Activate.ps1") {
          state.env.VIRTUAL_ENV = join(state.cwd, ".venv");
          emit("venv activated\n");
          emitMarkers(commandId, 0);
          return;
        }

        if (input === "python --version") {
          emit(
            `${state.env.VIRTUAL_ENV ? "Python 3.12.0 (venv)" : "Python 3.12.0 (system)"}\n`
          );
          emitMarkers(commandId, 0);
          return;
        }

        if (input === "long_running") {
          emit("still running\n");
          return;
        }

        emit(`ran ${input}\n`);
        emitMarkers(commandId, 0);
      },
      kill(signal?: string) {
        state.killedSignals.push(signal ?? "");
        emitExit(0, signal);
      },
      onData(listener: (data: string) => void) {
        dataListeners.push(listener);
        return {
          dispose: () => {
            const index = dataListeners.indexOf(listener);
            if (index >= 0) {
              dataListeners.splice(index, 1);
            }
          },
        };
      },
      onExit(listener: (event: { exitCode: number; signal?: string | number }) => void) {
        exitListeners.push(listener);
        return {
          dispose: () => {
            const index = exitListeners.indexOf(listener);
            if (index >= 0) {
              exitListeners.splice(index, 1);
            }
          },
        };
      },
    };
  };

  return {
    state,
    emit,
    emitExit,
    factory,
  };
};

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.dispose();
  }
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

  test("read_files executes immediately and returns multiple file bodies", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "a.txt"), "alpha", "utf8");
    await writeFile(join(root, "b.txt"), "", "utf8");

    const result = await service.handleToolCall("file", {
      action: "read_files",
      path: "a.txt",
      paths: ["b.txt"],
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] read_files a.txt");
    expect(result.message).toContain("[file] a.txt");
    expect(result.message).toContain("alpha");
    expect(result.message).toContain("[file] b.txt");
    expect(result.message).toContain("(empty file)");
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
    expect(approved.message).toContain("[confirmed file mutation] create_file nested/example.py");
    expect(approved.message).toContain("postcondition: file now exists and content was written successfully");
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

  test("undoLastMutation returns explicit error when no reversible history exists", async () => {
    const { service } = await createService();

    const result = await service.undoLastMutation();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Nothing to undo");
  });

  test("undoLastMutation restores previous content after approved write_file", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "notes.txt"), "before", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "write_file",
      path: "notes.txt",
      content: "after",
    });
    const approved = await service.approve(queued.pending!.id);
    expect(approved.ok).toBe(true);
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("after");

    const undone = await service.undoLastMutation();

    expect(undone.ok).toBe(true);
    expect(undone.message).toContain("[undo]");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("before");
  });

  test("undoLastMutation restores deleted file after approved delete_file", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "remove-me.txt"), "bye", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "delete_file",
      path: "remove-me.txt",
    });
    const approved = await service.approve(queued.pending!.id);
    expect(approved.ok).toBe(true);
    await expect(readFile(join(root, "remove-me.txt"), "utf8")).rejects.toThrow();

    const undone = await service.undoLastMutation();

    expect(undone.ok).toBe(true);
    expect(await readFile(join(root, "remove-me.txt"), "utf8")).toBe("bye");
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
    expect(approved.message).toContain("[confirmed file mutation] write_file new-write.txt");
    expect(approved.message).toContain("next: do not call read_file on this path just to confirm the write");
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

  test("stat_paths executes immediately and returns metadata for multiple exact paths", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "export const ok = true;\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "stat_paths",
      path: ".",
      paths: ["src/main.ts", "missing.ts"],
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] stat_paths .");
    expect(result.message).toContain("Stat 3 path(s):");
    expect(result.message).toContain("[path] .");
    expect(result.message).toContain("[path] src/main.ts");
    expect(result.message).toContain("exists: true");
    expect(result.message).toContain("[path] missing.ts");
    expect(result.message).toContain("exists: false");
  });

  test("read_range executes immediately and returns numbered line slices", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "range.txt"), "alpha\nbeta\ngamma\ndelta\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "read_range",
      path: "range.txt",
      startLine: 2,
      endLine: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] read_range range.txt");
    expect(result.message).toContain("lines: 2-3");
    expect(result.message).toContain("2 | beta");
    expect(result.message).toContain("3 | gamma");
    expect(result.message).not.toContain("1 | alpha");
  });

  test("read_range rejects invalid ranges", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "read_range",
      path: "range.txt",
      startLine: 4,
      endLine: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("read_range requires `startLine` to be less than or equal to `endLine`");
  });

  test("read_range streams requested lines from oversized files instead of failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
    tempRoots.push(root);
    const service = new FileMcpService({
      workspaceRoot: root,
      maxReadBytes: 120_000,
      requireReview: [
        "create_file",
        "write_file",
        "edit_file",
        "apply_patch",
        "delete_file",
        "copy_path",
        "move_path",
        "open_shell",
        "write_shell",
      ],
    });
    services.push(service);

    const filler = "const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';";
    const content = [
      "export class HugeRangeDemo {}",
      ...Array.from({ length: 2500 }, () => filler),
      "export function bottomMarker() {",
      "  return true;",
      "}",
    ].join("\n");
    await writeFile(join(root, "huge-range.ts"), content, "utf8");

    const result = await service.handleToolCall("file", {
      action: "read_range",
      path: "huge-range.ts",
      startLine: 2501,
      endLine: 2504,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] read_range huge-range.ts");
    expect(result.message).toContain("lines: 2501-2504");
    expect(result.message).toContain("note: large-file mode streamed requested lines");
    expect(result.message).toContain("2501 | const filler =");
    expect(result.message).toContain("2502 | export function bottomMarker() {");
    expect(result.message).toContain("2503 |   return true;");
    expect(result.message).toContain("2504 | }");
  });

  test("read_json executes immediately and can return a nested jsonPath value", async () => {
    const { root, service } = await createService();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "cyrene-demo",
          scripts: {
            test: "bun test",
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "read_json",
      path: "package.json",
      jsonPath: "scripts.test",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] read_json package.json");
    expect(result.message).toContain("jsonPath: scripts.test");
    expect(result.message).toContain('"bun test"');
  });

  test("read_yaml executes immediately and can return a nested yamlPath value", async () => {
    const { root, service } = await createService();
    await writeFile(
      join(root, "config.yaml"),
      [
        "app:",
        "  name: cyrene",
        "  enabled: true",
        "  ports:",
        "    - 3000",
        "    - 3001",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "read_yaml",
      path: "config.yaml",
      yamlPath: "app.ports[1]",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] read_yaml config.yaml");
    expect(result.message).toContain("yamlPath: app.ports[1]");
    expect(result.message).toContain("3001");
  });

  test("outline_file executes immediately and returns lightweight symbol outline", async () => {
    const { root, service } = await createService();
    await writeFile(
      join(root, "outline.py"),
      [
        "class Demo:",
        "    pass",
        "",
        "def run_app():",
        "    return True",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "outline_file",
      path: "outline.py",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] outline_file outline.py");
    expect(result.message).toContain("Outline for outline.py");
    expect(result.message).toContain("1 | class Demo:");
    expect(result.message).toContain("4 | def run_app():");
  });

  test("outline_file falls back to large-file scan instead of failing on oversized source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
    tempRoots.push(root);
    const service = new FileMcpService({
      workspaceRoot: root,
      maxReadBytes: 120_000,
      requireReview: [
        "create_file",
        "write_file",
        "edit_file",
        "apply_patch",
        "delete_file",
        "copy_path",
        "move_path",
        "open_shell",
        "write_shell",
      ],
    });
    services.push(service);

    const filler = "const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';";
    const content = [
      "export class HugeDemo {}",
      ...Array.from({ length: 2500 }, () => filler),
      "export function runHugeDemo() {",
      "  return true;",
      "}",
    ].join("\n");
    await writeFile(join(root, "huge.ts"), content, "utf8");

    const result = await service.handleToolCall("file", {
      action: "outline_file",
      path: "huge.ts",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] outline_file huge.ts");
    expect(result.message).toContain("large-file mode: scanned");
    expect(result.message).toContain("1 | export class HugeDemo {}");
    expect(result.message).toContain("2502 | export function runHugeDemo() {");
  });

  test("find_symbol executes immediately and returns matching definition lines", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "app.ts"),
      [
        "export class DemoService {}",
        "export function runApp() {",
        "  return true;",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "find_symbol",
      path: "src",
      symbol: "runApp",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] find_symbol src");
    expect(result.message).toContain("Found 1 symbol match(es):");
    expect(result.message).toContain("src/app.ts:2 | export function runApp()");
  });

  test("find_symbol falls back to large-file scan for oversized source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
    tempRoots.push(root);
    const service = new FileMcpService({
      workspaceRoot: root,
      maxReadBytes: 120_000,
      requireReview: [
        "create_file",
        "write_file",
        "edit_file",
        "apply_patch",
        "delete_file",
        "copy_path",
        "move_path",
        "open_shell",
        "write_shell",
      ],
    });
    services.push(service);

    await mkdir(join(root, "src"), { recursive: true });
    const filler = "const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';";
    await writeFile(
      join(root, "src", "huge.ts"),
      [
        "export class HugeDemoService {}",
        ...Array.from({ length: 2500 }, () => filler),
        "export function runHugeDemo() {",
        "  return true;",
        "}",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "find_symbol",
      path: "src",
      symbol: "runHugeDemo",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 symbol match(es):");
    expect(result.message).toContain("note: large-file mode scanned 1 oversized file(s)");
    expect(result.message).toContain("src/huge.ts:2502 | export function runHugeDemo()");
  });

  test("find_references executes immediately and returns usage lines instead of symbol definitions", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "demo.ts"), "export class DemoService {}\n", "utf8");
    await writeFile(
      join(root, "src", "app.ts"),
      [
        'import { DemoService } from "./demo";',
        "const service = new DemoService();",
        "console.log(DemoService);",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "find_references",
      path: "src",
      symbol: "DemoService",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] find_references src");
    expect(result.message).toContain("Found 3 reference match(es):");
    expect(result.message).toContain('src/app.ts:1 | import { DemoService } from "./demo";');
    expect(result.message).toContain("src/app.ts:2 | const service = new DemoService();");
    expect(result.message).not.toContain("src/demo.ts:1 | export class DemoService {}");
  });

  test("find_references falls back to large-file scan for oversized source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
    tempRoots.push(root);
    const service = new FileMcpService({
      workspaceRoot: root,
      maxReadBytes: 120_000,
      requireReview: [
        "create_file",
        "write_file",
        "edit_file",
        "apply_patch",
        "delete_file",
        "copy_path",
        "move_path",
        "open_shell",
        "write_shell",
      ],
    });
    services.push(service);

    await mkdir(join(root, "src"), { recursive: true });
    const filler = "const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';";
    await writeFile(
      join(root, "src", "huge-ref.ts"),
      [
        "export class HugeDemoService {}",
        ...Array.from({ length: 2500 }, () => filler),
        "console.log(HugeDemoService);",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "find_references",
      path: "src",
      symbol: "HugeDemoService",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 reference match(es):");
    expect(result.message).toContain("note: large-file mode scanned 1 oversized file(s)");
    expect(result.message).toContain("src/huge-ref.ts:2502 | console.log(HugeDemoService);");
    expect(result.message).not.toContain("src/huge-ref.ts:1 | export class HugeDemoService {}");
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

  test("find_files matches nested basenames when the pattern omits directories", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src", "entrypoint"), { recursive: true });
    await writeFile(
      join(root, "src", "entrypoint", "cli.tsx"),
      "export const main = true;\n",
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "find_files",
      path: ".",
      pattern: "*cli.tsx*",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 file(s):");
    expect(result.message).toContain("src/entrypoint/cli.tsx");
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

  test("search_text skips common large directories during workspace-wide search", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "demo-pkg"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "import queryRunner from './query';\n", "utf8");
    await writeFile(
      join(root, "node_modules", "demo-pkg", "index.ts"),
      "import queryRunner from 'ignored-package';\n",
      "utf8"
    );
    await writeFile(join(root, ".git", "HEAD"), "import queryRunner from 'git';\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "search_text",
      path: ".",
      query: "import query",
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 match(es):");
    expect(result.message).toContain("note: skipped common large directories:");
    expect(result.message).toContain(".git");
    expect(result.message).toContain("node_modules");
    expect(result.message).toContain("src/app.ts:1 | import queryRunner from './query';");
    expect(result.message).not.toContain("node_modules/demo-pkg/index.ts");
  });

  test("search_text still searches inside node_modules when path explicitly targets it", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "node_modules", "demo-pkg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "demo-pkg", "index.ts"),
      "import queryRunner from 'pkg';\n",
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "search_text",
      path: "node_modules",
      query: "import query",
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 match(es):");
    expect(result.message).toContain("node_modules/demo-pkg/index.ts:1 | import queryRunner from 'pkg';");
    expect(result.message).not.toContain("note: skipped common large directories:");
  });

  test("search_text falls back to large-file scan for oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
    tempRoots.push(root);
    const service = new FileMcpService({
      workspaceRoot: root,
      maxReadBytes: 120_000,
      requireReview: [
        "create_file",
        "write_file",
        "edit_file",
        "apply_patch",
        "delete_file",
        "copy_path",
        "move_path",
        "open_shell",
        "write_shell",
      ],
    });
    services.push(service);

    await mkdir(join(root, "docs"), { recursive: true });
    const filler = "const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';";
    await writeFile(
      join(root, "docs", "huge.txt"),
      [
        ...Array.from({ length: 2500 }, () => filler),
        "needle is here",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "search_text",
      path: "docs",
      query: "needle",
      maxResults: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 match(es):");
    expect(result.message).toContain("note: large-file mode scanned 1 oversized file(s)");
    expect(result.message).toContain("docs/huge.txt:2501 | needle is here");
  });

  test("search_text_context executes immediately and returns match windows with surrounding lines", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "context.txt"), "alpha\nneedle here\nomega\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "search_text_context",
      path: "docs",
      query: "needle",
      before: 1,
      after: 1,
      maxResults: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] search_text_context docs");
    expect(result.message).toContain("Found 1 contextual match(es):");
    expect(result.message).toContain("[match] docs/context.txt:2");
    expect(result.message).toContain("1 | alpha");
    expect(result.message).toContain(">    2 | needle here");
    expect(result.message).toContain("3 | omega");
  });

  test("search_text_context falls back to large-file scan for oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyrene-mcp-test-"));
    tempRoots.push(root);
    const service = new FileMcpService({
      workspaceRoot: root,
      maxReadBytes: 120_000,
      requireReview: [
        "create_file",
        "write_file",
        "edit_file",
        "apply_patch",
        "delete_file",
        "copy_path",
        "move_path",
        "open_shell",
        "write_shell",
      ],
    });
    services.push(service);

    await mkdir(join(root, "docs"), { recursive: true });
    const filler = "const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';";
    await writeFile(
      join(root, "docs", "huge-context.txt"),
      [
        ...Array.from({ length: 2499 }, () => filler),
        "before line",
        "needle is here",
        "after line",
      ].join("\n"),
      "utf8"
    );

    const result = await service.handleToolCall("file", {
      action: "search_text_context",
      path: "docs",
      query: "needle",
      before: 1,
      after: 1,
      maxResults: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("Found 1 contextual match(es):");
    expect(result.message).toContain("note: large-file mode scanned 1 oversized file(s)");
    expect(result.message).toContain("[match] docs/huge-context.txt:2501");
    expect(result.message).toContain("2500 | before line");
    expect(result.message).toContain("> 2501 | needle is here");
    expect(result.message).toContain("2502 | after line");
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

  test("undoLastMutation reverts approved move_path", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "move-me.txt"), "move me", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "move_path",
      path: "src/move-me.txt",
      destination: "dest/moved.txt",
    });
    const approved = await service.approve(queued.pending!.id);
    expect(approved.ok).toBe(true);

    const undone = await service.undoLastMutation();

    expect(undone.ok).toBe(true);
    expect(await readFile(join(root, "src", "move-me.txt"), "utf8")).toBe("move me");
    await expect(readFile(join(root, "dest", "moved.txt"), "utf8")).rejects.toThrow();
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

  test("git_status executes immediately without review", async () => {
    const { root, service } = await createService({
      gitRunner: async (args, cwd) => {
        expect(args).toEqual(["status", "--short", "--branch"]);
        expect(cwd).toBe(root);
        return "## main\n M src/app.ts";
      },
    });
    await mkdir(join(root, ".git"), { recursive: true });

    const result = await service.handleToolCall("file", {
      action: "git_status",
      path: ".",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(result.message).toContain("[tool result] git_status .");
    expect(result.message).toContain("repo: .");
    expect(result.message).toContain("## main");
  });

  test("git_diff executes immediately for a scoped file path", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const { root, service } = await createService({
      gitRunner: async (args, cwd) => {
        calls.push({ args, cwd });
        if (args.includes("--cached")) {
          return "";
        }
        return "diff --git a/src/app.ts b/src/app.ts\n+console.log('hi')";
      },
    });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "console.log('hi')\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "git_diff",
      path: "src/app.ts",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(calls).toEqual([
      {
        args: ["diff", "--no-ext-diff", "--minimal", "--", "src/app.ts"],
        cwd: root,
      },
      {
        args: ["diff", "--cached", "--no-ext-diff", "--minimal", "--", "src/app.ts"],
        cwd: root,
      },
    ]);
    expect(result.message).toContain("[tool result] git_diff src/app.ts");
    expect(result.message).toContain("[unstaged]");
    expect(result.message).toContain("[staged]");
    expect(result.message).toContain("diff --git");
    expect(result.message).toContain("(none)");
  });

  test("git_log executes immediately without review for a scoped path", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const { root, service } = await createService({
      gitRunner: async (args, cwd) => {
        calls.push({ args, cwd });
        return "abc1234 2026-04-03 add app\nbcd2345 2026-04-02 init";
      },
    });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const app = true;\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "git_log",
      path: "src/app.ts",
      maxResults: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(calls).toEqual([
      {
        args: ["log", "-n5", "--date=short", "--pretty=format:%h %ad %s", "--", "src/app.ts"],
        cwd: root,
      },
    ]);
    expect(result.message).toContain("[tool result] git_log src/app.ts");
    expect(result.message).toContain("scope: src/app.ts");
    expect(result.message).toContain("abc1234 2026-04-03 add app");
  });

  test("git_show executes immediately for a revision and scoped path", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const { root, service } = await createService({
      gitRunner: async (args, cwd) => {
        calls.push({ args, cwd });
        return "commit abc1234\nAuthor: Test User\n\ndiff --git a/src/app.ts b/src/app.ts\n+console.log('hi')";
      },
    });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "console.log('hi')\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "git_show",
      path: "src/app.ts",
      revision: "abc1234",
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(calls).toEqual([
      {
        args: [
          "show",
          "--stat",
          "--patch",
          "--no-ext-diff",
          "--minimal",
          "abc1234",
          "--",
          "src/app.ts",
        ],
        cwd: root,
      },
    ]);
    expect(result.message).toContain("[tool result] git_show src/app.ts");
    expect(result.message).toContain("revision: abc1234");
    expect(result.message).toContain("diff --git a/src/app.ts b/src/app.ts");
  });

  test("git_blame executes immediately for a scoped file range", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const { root, service } = await createService({
      gitRunner: async (args, cwd) => {
        calls.push({ args, cwd });
        return "abc1234 (Test User 2026-04-03 1) export const app = true;";
      },
    });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const app = true;\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "git_blame",
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(calls).toEqual([
      {
        args: ["blame", "--date=short", "-L", "1,1", "--", "src/app.ts"],
        cwd: root,
      },
    ]);
    expect(result.message).toContain("[tool result] git_blame src/app.ts");
    expect(result.message).toContain("lines: 1-1");
    expect(result.message).toContain("abc1234 (Test User 2026-04-03 1)");
  });

  test("apply_patch enters review queue and patches file on approve", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "patch-me.ts"), "const label = 'before';\n", "utf8");

    const queued = await service.handleToolCall("file", {
      action: "apply_patch",
      path: "patch-me.ts",
      find: "before",
      replace: "after",
    });

    expect(queued.ok).toBe(true);
    expect(queued.pending?.previewSummary).toContain("[patch preview]");

    const approved = await service.approve(queued.pending!.id);

    expect(approved.ok).toBe(true);
    expect(approved.message).toContain("Patched file: patch-me.ts");
    expect(approved.message).toContain("[confirmed file mutation] apply_patch patch-me.ts");
    expect(await readFile(join(root, "patch-me.ts"), "utf8")).toBe("const label = 'after';\n");
  });

  test("apply_patch rejects before queue when find text does not exist", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "patch-missing.ts"), "const label = 'before';\n", "utf8");

    const result = await service.handleToolCall("file", {
      action: "apply_patch",
      path: "patch-missing.ts",
      find: "missing",
      replace: "after",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("apply_patch find text not found");
    expect(service.listPending()).toHaveLength(0);
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

  test("open_shell executes directly and opens a single persistent shell", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service, cleanup } = await createIsolatedService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });
    try {
      const opened = await service.handleToolCall("file", {
        action: "open_shell",
        path: ".",
      });

      expect(opened.ok).toBe(true);
      expect(opened.pending).toBeUndefined();
      expect(opened.message).toContain("status: opened");
      expect(opened.message).toContain("shell:");
      expect(opened.message).toContain("cwd: .");
      expect(service.listPending()).toHaveLength(0);

      const secondOpen = await service.handleToolCall("file", {
        action: "open_shell",
        path: ".",
      });
      expect(secondOpen.ok).toBe(false);
      expect(secondOpen.message).toContain("already exists");
      if (process.platform === "win32") {
        expect(fakePty.state.openFile).toBe("pwsh");
      } else {
        expect(["/bin/bash", "/bin/sh"]).toContain(fakePty.state.openFile);
      }
    } finally {
      await cleanup();
    }
  });

  test("low-risk write_shell inputs execute directly and preserve cwd and environment", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { root, service, cleanup } = await createIsolatedService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });
    try {
      await mkdir(join(root, "subdir"), { recursive: true });
      await mkdir(join(root, ".venv"), { recursive: true });

      const opened = await service.handleToolCall("file", {
        action: "open_shell",
        path: ".",
      });
      expect(opened.ok).toBe(true);
      expect(opened.pending).toBeUndefined();

      const activateResult = await service.handleToolCall("file", {
        action: "write_shell",
        path: ".",
        input:
          process.platform === "win32"
            ? ".\\.venv\\Scripts\\Activate.ps1"
            : ". .venv/bin/activate",
      });
      expect(activateResult.ok).toBe(true);
      expect(activateResult.pending).toBeUndefined();
      expect(activateResult.message).toContain("status: completed");
      expect(activateResult.message).toContain("venv activated");

      const cdResult = await service.handleToolCall("file", {
        action: "write_shell",
        path: ".",
        input: "cd subdir",
      });
      expect(cdResult.ok).toBe(true);
      expect(cdResult.pending).toBeUndefined();
      expect(cdResult.message).toContain("cwd: subdir");

      const pythonResult = await service.handleToolCall("file", {
        action: "write_shell",
        path: ".",
        input: "python --version",
      });
      expect(pythonResult.ok).toBe(true);
      expect(pythonResult.pending).toBeUndefined();
      expect(pythonResult.message).toContain("Python 3.12.0 (venv)");

      const pipListResult = await service.handleToolCall("file", {
        action: "write_shell",
        path: ".",
        input: "pip list",
      });
      expect(pipListResult.ok).toBe(true);
      expect(pipListResult.pending).toBeUndefined();
      expect(pipListResult.message).toContain("ran pip list");

      const gitStatusResult = await service.handleToolCall("file", {
        action: "write_shell",
        path: ".",
        input: "git status",
      });
      expect(gitStatusResult.ok).toBe(true);
      expect(gitStatusResult.pending).toBeUndefined();
      expect(gitStatusResult.message).toContain("ran git status");

      const status = await service.handleToolCall("file", {
        action: "shell_status",
        path: ".",
      });
      expect(status.ok).toBe(true);
      expect(status.message).toContain("status: idle");
      expect(status.message).toContain("cwd: subdir");
    } finally {
      await cleanup();
    }
  });

  test("write_shell executes safe multiline blocks sequentially in the persistent shell", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service, cleanup } = await createIsolatedService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });
    try {
      await service.handleToolCall("file", {
        action: "open_shell",
        path: ".",
      });

      const result = await service.handleToolCall("file", {
        action: "write_shell",
        path: ".",
        input: ["cd subdir", "python --version"].join("\n"),
      });

      expect(result.ok).toBe(true);
      expect(result.pending).toBeUndefined();
      expect(result.message).toContain("$ cd subdir");
      expect(result.message).toContain("$ python --version");
      expect(result.message).toContain("changed directory");
      expect(result.message).toContain("Python 3.12.0 (system)");
      expect(result.message).toContain("cwd: subdir");
    } finally {
      await cleanup();
    }
  });

  test("run_shell rejects multiline commands and nudges callers toward persistent shell", async () => {
    const { service } = await createService();

    const result = await service.handleToolCall("file", {
      action: "run_shell",
      path: ".",
      command: "echo one\necho two",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not accept multiline");
    expect(result.message).toContain("open_shell plus write_shell");
  });

  test("write_shell blocks workspace-escaping cd before review", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service } = await createService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });

    await service.handleToolCall("file", {
      action: "open_shell",
      path: ".",
    });

    const result = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "cd ../outside",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("outside the workspace root");
    expect(service.listPending()).toHaveLength(0);
  });

  test("medium-risk and unknown write_shell inputs still enter review", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service } = await createService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });

    await service.handleToolCall("file", {
      action: "open_shell",
      path: ".",
    });

    const mkdirQueued = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "mkdir foo",
    });
    expect(mkdirQueued.ok).toBe(true);
    expect(mkdirQueued.pending?.request.action).toBe("write_shell");
    expect(mkdirQueued.pending?.previewSummary).toContain("policy: review");
    expect(mkdirQueued.pending?.previewSummary).toContain("risk: medium");

    const unknownQueued = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "pytest",
    });
    expect(unknownQueued.ok).toBe(true);
    expect(unknownQueued.pending?.request.action).toBe("write_shell");
    expect(unknownQueued.pending?.previewSummary).toContain("policy: review");
    expect(unknownQueued.pending?.previewSummary).toContain("risk: low");
  });

  test("high-risk write_shell inputs are blocked before review", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service } = await createService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });

    await service.handleToolCall("file", {
      action: "open_shell",
      path: ".",
    });

    const result = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "rm -rf /",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("dangerous root deletion pattern");
    expect(service.listPending()).toHaveLength(0);
  });

  test("read_shell returns only unread output and shell_status reflects running state", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service } = await createService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });

    await service.handleToolCall("file", {
      action: "open_shell",
      path: ".",
    });

    fakePty.emit("later line\n");
    const firstRead = await service.handleToolCall("file", {
      action: "read_shell",
      path: ".",
    });
    expect(firstRead.ok).toBe(true);
    expect(firstRead.message).toContain("later line");

    const secondRead = await service.handleToolCall("file", {
      action: "read_shell",
      path: ".",
    });
    expect(secondRead.ok).toBe(true);
    expect(secondRead.message).toContain("(no new output)");

    const runningQueued = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "long_running",
    });
    expect(runningQueued.ok).toBe(true);
    expect(runningQueued.pending?.request.action).toBe("write_shell");
    const runningApproved = await service.approve(runningQueued.pending!.id);
    expect(runningApproved.ok).toBe(true);
    expect(runningApproved.message).toContain("status: running");

    const status = await service.handleToolCall("file", {
      action: "shell_status",
      path: ".",
    });
    expect(status.ok).toBe(true);
    expect(status.message).toContain("status: running");
  });

  test("interrupt_shell and close_shell manage persistent shell lifecycle", async () => {
    const fakePty = createFakePersistentShellFactory();
    const { service } = await createService({
      ptyFactory: fakePty.factory,
      shellSettleMs: 0,
    });

    await service.handleToolCall("file", {
      action: "open_shell",
      path: ".",
    });

    const runningQueued = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "long_running",
    });
    await service.approve(runningQueued.pending!.id);

    const interrupted = await service.handleToolCall("file", {
      action: "interrupt_shell",
      path: ".",
    });
    expect(interrupted.ok).toBe(true);
    expect(interrupted.message).toContain("status: interrupted");

    const closed = await service.handleToolCall("file", {
      action: "close_shell",
      path: ".",
    });
    expect(closed.ok).toBe(true);
    expect(closed.message).toContain("status: closed");
    expect(fakePty.state.killedSignals).toContain("SIGTERM");

    const writeAfterClose = await service.handleToolCall("file", {
      action: "write_shell",
      path: ".",
      input: "python --version",
    });
    expect(writeAfterClose.ok).toBe(false);
    expect(writeAfterClose.message).toContain("open_shell first");
  });
});
