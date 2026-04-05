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
});
