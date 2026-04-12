import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { handleCyreneCli } from "../bin/lib/cyrene-cli.js";

const createBufferStream = () => {
  let text = "";
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        text += String(chunk);
        return true;
      },
    },
    read: () => text,
  };
};

const createRuntime = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-cli-root-"));
  const home = await mkdtemp(join(tmpdir(), "cyrene-cli-home-"));
  const stdout = createBufferStream();
  const stderr = createBufferStream();
  return {
    root,
    home,
    stdout,
    stderr,
    env: {
      HOME: home,
    } as NodeJS.ProcessEnv,
  };
};

describe("cyrene CLI runtime", () => {
  test("prints help without launching the packaged binary", async () => {
    const runtime = await createRuntime();
    const result = await handleCyreneCli(["--help"], {
      cwd: runtime.root,
      env: runtime.env,
      stdout: runtime.stdout.stream as never,
      stderr: runtime.stderr.stream as never,
    });

    expect(result).toEqual({
      kind: "handled",
      exitCode: 0,
    });
    expect(runtime.stdout.read()).toContain("cyrene provider list");
    expect(runtime.stdout.read()).toContain("cyrene config [show]");
  });

  test("paths command resolves global config home and workspace paths", async () => {
    const runtime = await createRuntime();
    const result = await handleCyreneCli(
      ["paths", "--json", "--root", runtime.root],
      {
        cwd: runtime.root,
        env: runtime.env,
        stdout: runtime.stdout.stream as never,
        stderr: runtime.stderr.stream as never,
      }
    );

    expect(result).toEqual({
      kind: "handled",
      exitCode: 0,
    });

    const payload = JSON.parse(runtime.stdout.read());
    expect(payload.appRoot).toBe(runtime.root);
    expect(payload.configHome).toBe(join(runtime.home, ".cyrene"));
    expect(payload.legacyHome).toBe(join(runtime.root, ".cyrene"));
  });

  test("config command reports effective config and prompt sources", async () => {
    const runtime = await createRuntime();
    const configHome = join(runtime.home, ".cyrene");
    await mkdir(configHome, { recursive: true });
    await writeFile(
      join(configHome, "config.yaml"),
      [
        "pin_max_count: 12",
        "query_max_tool_steps: 30",
        "auto_summary_refresh: false",
        "request_temperature: 0.7",
        "system_prompt: Project operator mode",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(configHome, ".cyrene.md"), "Follow repo policy.\n", "utf8");

    const result = await handleCyreneCli(
      ["config", "--json", "--root", runtime.root],
      {
        cwd: runtime.root,
        env: runtime.env,
        stdout: runtime.stdout.stream as never,
        stderr: runtime.stderr.stream as never,
      }
    );

    expect(result).toEqual({
      kind: "handled",
      exitCode: 0,
    });

    const payload = JSON.parse(runtime.stdout.read());
    expect(payload.config.pinMaxCount).toBe(12);
    expect(payload.config.queryMaxToolSteps).toBe(30);
    expect(payload.config.autoSummaryRefresh).toBe(false);
    expect(payload.config.requestTemperature).toBe(0.7);
    expect(payload.promptPolicy.systemPrompt).toBe("Project operator mode");
    expect(payload.promptPolicy.systemPromptSource).toBe("config.yaml");
    expect(payload.promptPolicy.projectPromptLength).toBeGreaterThan(0);
  });

  test("provider name set creates a model catalog and persists provider metadata", async () => {
    const runtime = await createRuntime();
    runtime.env.CYRENE_MODEL = "gpt-5.4";

    const setResult = await handleCyreneCli(
      ["provider", "name", "set", "openai", "Primary OpenAI", "--root", runtime.root],
      {
        cwd: runtime.root,
        env: runtime.env,
        stdout: runtime.stdout.stream as never,
        stderr: runtime.stderr.stream as never,
      }
    );

    expect(setResult).toEqual({
      kind: "handled",
      exitCode: 0,
    });
    expect(runtime.stdout.read()).toContain("provider name saved");

    const modelYaml = await readFile(
      join(runtime.home, ".cyrene", "model.yaml"),
      "utf8"
    );
    expect(modelYaml).toContain("default_model: gpt-5.4");
    expect(modelYaml).toContain("provider: https://api.openai.com/v1");
    expect(modelYaml).toContain("name: Primary OpenAI");

    const listStdout = createBufferStream();
    const listStderr = createBufferStream();
    const listResult = await handleCyreneCli(
      ["provider", "list", "--json", "--root", runtime.root],
      {
        cwd: runtime.root,
        env: runtime.env,
        stdout: listStdout.stream as never,
        stderr: listStderr.stream as never,
      }
    );

    expect(listResult).toEqual({
      kind: "handled",
      exitCode: 0,
    });
    const payload = JSON.parse(listStdout.read());
    expect(payload.providerCount).toBe(1);
    expect(payload.providers[0]).toMatchObject({
      provider: "https://api.openai.com/v1",
      name: "Primary OpenAI",
      current: true,
    });
  });
});
