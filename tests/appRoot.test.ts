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

    expect(parseRootArg(["--root", "./repo"])).toBe("./repo");
    expect(
      resolveUserHomeDir({
        cwd,
        env: {
          USERPROFILE: "C:/Users/tester",
        },
      })
    ).toBe(resolve("C:/Users/tester"));
    expect(
      getCyreneConfigDir({
        cwd,
        env: {
          USERPROFILE: "C:/Users/tester",
        },
      })
    ).toBe(join(resolve("C:/Users/tester"), ".cyrene"));
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
