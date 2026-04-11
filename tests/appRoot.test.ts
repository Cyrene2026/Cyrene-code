import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  configureAppRootFromArgs,
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  parseRootArg,
  resetConfiguredAppRoot,
  resolveAppRoot,
  resolveUserHomeDir,
} from "../src/infra/config/appRoot";

afterEach(() => {
  resetConfiguredAppRoot();
});

describe("app root resolver", () => {
  test("prefers --root CLI arg over env and cwd", () => {
    const root = configureAppRootFromArgs({
      cwd: resolve("workspace", "current"),
      argv: ["--root", "../target"],
      env: {
        CYRENE_ROOT: "./env-root",
      },
    });

    expect(root).toBe(resolve("workspace", "target"));
  });

  test("supports --root=value form and env fallback", () => {
    expect(
      configureAppRootFromArgs({
        cwd: resolve("workspace", "current"),
        argv: ["--root=./cli-root"],
        env: {},
      })
    ).toBe(resolve("workspace", "current", "cli-root"));

    resetConfiguredAppRoot();
    expect(
      resolveAppRoot({
        cwd: resolve("workspace", "current"),
        argv: [],
        env: {
          CYRENE_ROOT: "../env-root",
        },
      })
    ).toBe(resolve("workspace", "env-root"));
  });

  test("builds global .cyrene path from user home and keeps legacy project path helper", () => {
    const cwd = resolve("workspace", "repo");
    const userHome = process.platform === "win32" ? "C:/Users/tester" : "/Users/tester";
    const userHomeEnv =
      process.platform === "win32"
        ? { USERPROFILE: userHome }
        : { HOME: userHome, USERPROFILE: "C:/should-not-win-on-posix" };

    expect(parseRootArg(["--root", "./repo"])).toBe("./repo");
    expect(
      resolveUserHomeDir({
        cwd,
        env: userHomeEnv,
      })
    ).toBe(resolve(userHome));
    expect(
      getCyreneConfigDir({
        cwd,
        env: userHomeEnv,
      })
    ).toBe(join(resolve(userHome), ".cyrene"));
    expect(
      getCyreneConfigDir({
        cwd,
        env: {
          CYRENE_HOME: "./global-cyrene",
        },
      })
    ).toBe(resolve(cwd, "global-cyrene"));
    expect(getLegacyProjectCyreneDir(cwd)).toBe(
      join(cwd, ".cyrene")
    );
  });

  test("resolves Linux global .cyrene from HOME", () => {
    const cwd = "/workspace/repo";
    const env = {
      HOME: "/home/tester",
      USERPROFILE: "C:/Users/ignored",
    };

    expect(
      resolveUserHomeDir({
        cwd,
        env,
        platform: "linux",
      })
    ).toBe("/home/tester");
    expect(
      getCyreneConfigDir({
        cwd,
        env,
        platform: "linux",
      })
    ).toBe("/home/tester/.cyrene");
  });

  test("resolves macOS global .cyrene from HOME", () => {
    const cwd = "/Users/tester/work/repo";
    const env = {
      HOME: "/Users/tester",
      USERPROFILE: "C:/Users/ignored",
    };

    expect(
      resolveUserHomeDir({
        cwd,
        env,
        platform: "darwin",
      })
    ).toBe("/Users/tester");
    expect(
      getCyreneConfigDir({
        cwd,
        env,
        platform: "darwin",
      })
    ).toBe("/Users/tester/.cyrene");
  });

  test("resolves Windows global .cyrene from USERPROFILE and preserves absolute CYRENE_HOME", () => {
    const cwd = "D:/workspace/repo";
    const env = {
      USERPROFILE: "C:/Users/tester",
      HOMEDRIVE: "C:",
      HOMEPATH: "/Users/tester",
    };

    expect(
      resolveUserHomeDir({
        cwd,
        env,
        platform: "win32",
      })
    ).toBe("C:/Users/tester");
    expect(
      getCyreneConfigDir({
        cwd,
        env,
        platform: "win32",
      })
    ).toBe("C:/Users/tester/.cyrene");
    expect(
      getCyreneConfigDir({
        cwd,
        env: {
          ...env,
          CYRENE_HOME: "E:/cyrene-data",
        },
        platform: "win32",
      })
    ).toBe("E:/cyrene-data");
  });

  test("falls back to HOMEDRIVE and HOMEPATH on Windows", () => {
    const cwd = "D:/workspace/repo";
    const env = {
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\tester",
    };

    expect(
      resolveUserHomeDir({
        cwd,
        env,
        platform: "win32",
      })
    ).toBe("C:\\Users\\tester");
  });
});
