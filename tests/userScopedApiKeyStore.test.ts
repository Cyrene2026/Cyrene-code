import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __internalUserScopedApiKeyStore,
  createUserScopedApiKeyStore,
} from "../src/infra/auth/userScopedApiKeyStore";

const tempRoots: string[] = [];

const createTempHome = async () => {
  const home = await mkdtemp(join(tmpdir(), "cyrene-auth-store-"));
  tempRoots.push(home);
  return home;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
  mock.restore();
});

describe("createUserScopedApiKeyStore", () => {
  test("writes zsh managed blocks without duplication and clears them cleanly", async () => {
    const home = await createTempHome();
    const targetFile = join(home, ".zshrc");
    await writeFile(targetFile, "# existing\n", "utf8");

    const store = createUserScopedApiKeyStore({
      platform: "linux",
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      homeDir: home,
    });

    expect((await store.getTarget()).path).toBe(targetFile);

    await store.save("sk-first");
    await store.save("sk-second");

    const saved = await readFile(targetFile, "utf8");
    expect(saved.match(new RegExp(__internalUserScopedApiKeyStore.MANAGED_BLOCK_START, "g"))).toHaveLength(1);
    expect(saved).toContain("sk-second");
    expect(await store.read()).toBe("sk-second");

    await store.clear();
    const cleared = await readFile(targetFile, "utf8");
    expect(cleared).not.toContain(__internalUserScopedApiKeyStore.MANAGED_BLOCK_START);
    expect(cleared).toContain("# existing");
  });

  test("remembers separate provider-specific keys in the same managed block", async () => {
    const home = await createTempHome();
    const targetFile = join(home, ".zshrc");

    const store = createUserScopedApiKeyStore({
      platform: "linux",
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      homeDir: home,
    });

    await store.save("openai-key", "CYRENE_OPENAI_API_KEY");
    await store.save("gemini-key", "CYRENE_GEMINI_API_KEY");

    const saved = await readFile(targetFile, "utf8");
    expect(saved).toContain('export CYRENE_OPENAI_API_KEY="openai-key"');
    expect(saved).toContain('export CYRENE_GEMINI_API_KEY="gemini-key"');
    expect(await store.read("CYRENE_OPENAI_API_KEY")).toBe("openai-key");
    expect(await store.read("CYRENE_GEMINI_API_KEY")).toBe("gemini-key");
    expect(await store.readAll?.()).toEqual({
      CYRENE_OPENAI_API_KEY: "openai-key",
      CYRENE_GEMINI_API_KEY: "gemini-key",
    });

    await store.clear("CYRENE_OPENAI_API_KEY");
    const partiallyCleared = await readFile(targetFile, "utf8");
    expect(partiallyCleared).not.toContain("CYRENE_OPENAI_API_KEY");
    expect(partiallyCleared).toContain("CYRENE_GEMINI_API_KEY");
  });

  test("round-trips a long api key exactly through the managed shell block parser", async () => {
    const home = await createTempHome();
    const targetFile = join(home, ".zshrc");
    const expectedKey =
      "k-ant-oat01-NZFmUq4NVsEctq_wdz7-x7nm2IHEPrVgkJEVMIWZ9ahKJVBPxO9lXyN-xF5n";

    const store = createUserScopedApiKeyStore({
      platform: "linux",
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      homeDir: home,
    });

    await store.save(expectedKey, "CYRENE_ANTHROPIC_API_KEY");

    expect(await store.read("CYRENE_ANTHROPIC_API_KEY")).toBe(expectedKey);
    expect((await store.readAll?.())?.CYRENE_ANTHROPIC_API_KEY).toBe(expectedKey);
    expect(await readFile(targetFile, "utf8")).toContain(expectedKey);
  });

  test("chooses expected bash, fish, and posix targets", async () => {
    const bashHome = await createTempHome();
    await writeFile(join(bashHome, ".bash_profile"), "# bash profile\n", "utf8");
    const bashStore = createUserScopedApiKeyStore({
      platform: "linux",
      env: { SHELL: "/usr/bin/bash" } as NodeJS.ProcessEnv,
      homeDir: bashHome,
    });
    expect((await bashStore.getTarget()).path).toBe(join(bashHome, ".bash_profile"));

    const fishHome = await createTempHome();
    const fishStore = createUserScopedApiKeyStore({
      platform: "linux",
      env: { SHELL: "/usr/bin/fish" } as NodeJS.ProcessEnv,
      homeDir: fishHome,
    });
    const fishTarget = await fishStore.getTarget();
    expect(fishTarget.path).toBe(join(fishHome, ".config", "fish", "conf.d", "cyrene-auth.fish"));
    await fishStore.save("fish-key");
    expect(await fishStore.read()).toBe("fish-key");
    await fishStore.clear();
    expect(await fishStore.read()).toBeUndefined();

    const posixHome = await createTempHome();
    const posixStore = createUserScopedApiKeyStore({
      platform: "linux",
      env: { SHELL: "/bin/sh" } as NodeJS.ProcessEnv,
      homeDir: posixHome,
    });
    expect((await posixStore.getTarget()).path).toBe(join(posixHome, ".profile"));
  });

  test("uses Windows user environment persistence hooks", async () => {
    let persistedValue = "";
    const execFile = mock(
      async (_file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        const command = args.join(" ");
        if (command.includes("GetEnvironmentVariable")) {
          return {
            stdout: persistedValue,
            stderr: "",
          };
        }
        if (command.includes("SetEnvironmentVariable") && command.includes("$null")) {
          persistedValue = "";
          return {
            stdout: "",
            stderr: "",
          };
        }
        persistedValue = options?.env?.CYRENE_AUTH_VALUE ?? "";
        return {
          stdout: "",
          stderr: "",
        };
      }
    );

    const store = createUserScopedApiKeyStore({
      platform: "win32",
      env: {} as NodeJS.ProcessEnv,
      homeDir: "C:/Users/Test",
      execFile,
    });

    const target = await store.getTarget();
    expect(target.path).toBe("HKCU\\Environment");

    await store.save("win-key");
    expect(await store.read()).toBe("win-key");
    await store.clear();
    expect(await store.read()).toBeUndefined();
    expect(execFile).toHaveBeenCalled();
  });
});
