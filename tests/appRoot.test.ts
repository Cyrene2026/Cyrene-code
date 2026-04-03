import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  configureAppRootFromArgs,
  getCyreneConfigDir,
  parseRootArg,
  resetConfiguredAppRoot,
  resolveAppRoot,
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

  test("builds .cyrene config path from resolved app root", () => {
    expect(parseRootArg(["--root", "./repo"])).toBe("./repo");
    expect(getCyreneConfigDir(resolve("workspace", "repo"))).toBe(
      join(resolve("workspace", "repo"), ".cyrene")
    );
  });
});
