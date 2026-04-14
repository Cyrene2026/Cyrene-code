import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkillsRuntime,
  loadSkillsConfig,
} from "../src/core/skills";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-skills-test-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  return root;
};

describe("skills runtime", () => {
  test("loads global+project skills and supports remove_skills override", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });

    await writeFile(
      join(globalHome, "skills.yaml"),
      [
        "skills:",
        "  - id: docs-search",
        "    label: Docs Search",
        "    prompt: Use docs skill first.",
        "    triggers: [docs, documentation]",
        "    enabled: true",
      ].join("\n"),
      "utf8"
    );

    await writeFile(
      join(root, ".cyrene", "skills.yaml"),
      [
        "remove_skills:",
        "  - mcp-ops",
        "skills:",
        "  - id: docs-search",
        "    enabled: false",
      ].join("\n"),
      "utf8"
    );

    const config = await loadSkillsConfig(undefined, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    expect(config.skills.some(skill => skill.id === "mcp-ops")).toBe(false);
    expect(config.skills.find(skill => skill.id === "docs-search")?.enabled).toBe(false);
  });

  test("resolves skills by trigger and explicit $mention", async () => {
    const root = await createWorkspace();
    await writeFile(
      join(root, ".cyrene", "skills.yaml"),
      [
        "skills:",
        "  - id: docs-hint",
        "    label: Docs Hint",
        "    prompt: Only explicit mention should activate this.",
        "    triggers: [docs]",
        "    exposure: hinted",
        "  - id: hidden-memory",
        "    label: Hidden Memory",
        "    prompt: Hidden skill should stay out of auto-selection.",
        "    triggers: [memory]",
        "    exposure: hidden",
      ].join("\n"),
      "utf8"
    );
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: {},
    });

    const byTrigger = runtime.resolveForQuery("please review this patch");
    expect(byTrigger.some(skill => skill.id === "code-review")).toBe(true);

    const hintedByTrigger = runtime.resolveForQuery("please read the docs first");
    expect(hintedByTrigger.some(skill => skill.id === "docs-hint")).toBe(false);

    const byMention = runtime.resolveForQuery("use $code-review for this");
    expect(byMention.some(skill => skill.id === "code-review")).toBe(true);

    const hintedByMention = runtime.resolveForQuery("use $docs-hint for this");
    expect(hintedByMention.some(skill => skill.id === "docs-hint")).toBe(true);

    const hiddenByTrigger = runtime.resolveForQuery("memory issue");
    expect(hiddenByTrigger.some(skill => skill.id === "hidden-memory")).toBe(false);
  });

  test("setSkillEnabled persists to global config", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    const disableResult = await runtime.setSkillEnabled?.("code-review", false);
    expect(disableResult?.ok).toBe(true);

    const skillsText = await readFile(join(globalHome, "skills.yaml"), "utf8");
    expect(skillsText).toContain("id: code-review");
    expect(skillsText).toContain("enabled: false");
  });

  test("setSkillExposure persists exposure override to global config", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    const result = await runtime.setSkillExposure?.("code-review", "hinted");
    expect(result?.ok).toBe(true);

    const skillsText = await readFile(join(globalHome, "skills.yaml"), "utf8");
    expect(skillsText).toContain("id: code-review");
    expect(skillsText).toContain("exposure: hinted");
  });

  test("removeSkill persists remove_skills override to global config", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    const removeResult = await runtime.removeSkill?.("code-review");
    expect(removeResult?.ok).toBe(true);

    const skillsText = await readFile(join(globalHome, "skills.yaml"), "utf8");
    expect(skillsText).toContain("remove_skills:");
    expect(skillsText).toContain("- code-review");
  });

  test("createSkill persists a new skill to global config", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    const result = await runtime.createSkill?.({
      id: "Docs Search",
      label: "Docs Search",
      description: "Search project and vendor docs first.",
      prompt: "Search relevant documentation before proposing changes.",
      triggers: ["docs", "documentation", "api docs", "docs"],
      tags: ["docs", "reference", "docs"],
    });
    expect(result?.ok).toBe(true);
    expect(result?.skillId).toBe("docs-search");

    const skillsText = await readFile(join(globalHome, "skills.yaml"), "utf8");
    expect(skillsText).toContain("id: docs-search");
    expect(skillsText).toContain('label: "Docs Search"');
    expect(skillsText).toContain(
      'prompt: "Search relevant documentation before proposing changes."'
    );
    expect(skillsText).toContain("- docs");

    const reloaded = await loadSkillsConfig(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });
    expect(reloaded.skills.find(skill => skill.id === "docs-search")).toMatchObject({
      source: "global",
      triggers: ["docs", "documentation", "api docs"],
    });
  });

  test("createSkill rejects duplicate skill ids", async () => {
    const root = await createWorkspace();
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: {},
    });

    const result = await runtime.createSkill?.({
      id: "code-review",
      label: "Code Review Clone",
      prompt: "duplicate",
      triggers: ["review"],
    });
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("Skill already exists: code-review");
  });

  test("global runtime summary points to global editable config path", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    expect(runtime.describeRuntime?.().editableConfigPath).toBe(
      join(globalHome, "skills.yaml")
    );
  });

  test("global skill mutations reject project-defined skills", async () => {
    const root = await createWorkspace();
    const globalHome = join(root, "user-home");
    await mkdir(globalHome, { recursive: true });
    await writeFile(
      join(root, ".cyrene", "skills.yaml"),
      [
        "skills:",
        "  - id: local-docs",
        "    label: Local Docs",
        "    prompt: project only",
        "    triggers: [docs]",
      ].join("\n"),
      "utf8"
    );
    const runtime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: globalHome },
    });

    const enableResult = await runtime.setSkillEnabled?.("local-docs", false);
    expect(enableResult?.ok).toBe(false);
    expect(enableResult?.message).toContain("project config");
  });
});
