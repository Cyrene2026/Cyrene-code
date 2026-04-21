import { describe, expect, test } from "bun:test";
import {
  CYRENE_SKILL_END_TAG,
  CYRENE_SKILL_START_TAG,
  parseAssistantSkillUpdate,
} from "../src/core/skills";

describe("generatedSkill", () => {
  test("parses assistant skill blocks and strips them from visible text", () => {
    const parsed = parseAssistantSkillUpdate(
      [
        "Created a focused docs skill.",
        CYRENE_SKILL_START_TAG,
        JSON.stringify({
          version: 1,
          id: "Docs Search",
          label: "Docs Search",
          description: "Look through docs before answering.",
          prompt: "Search the most relevant docs before proposing code changes.",
          triggers: ["docs", "documentation", "api docs", "docs"],
          tags: ["docs", "reference", "docs"],
          exposure: "scoped",
          enabled: true,
        }),
        CYRENE_SKILL_END_TAG,
      ].join("\n")
    );

    expect(parsed.visibleText).toBe("Created a focused docs skill.");
    expect(parsed.skill).toEqual({
      id: "docs-search",
      label: "Docs Search",
      description: "Look through docs before answering.",
      prompt: "Search the most relevant docs before proposing code changes.",
      triggers: ["docs", "documentation", "api docs"],
      tags: ["docs", "reference"],
      exposure: "scoped",
      enabled: true,
      scope: "project",
    });
  });

  test("rejects invalid generated skill payloads", () => {
    const parsed = parseAssistantSkillUpdate(
      [
        "Attempted a skill.",
        CYRENE_SKILL_START_TAG,
        JSON.stringify({
          version: 1,
          id: "missing-prompt",
          label: "Missing Prompt",
          triggers: ["docs"],
        }),
        CYRENE_SKILL_END_TAG,
      ].join("\n")
    );

    expect(parsed.visibleText).toBe("Attempted a skill.");
    expect(parsed.skill).toBeNull();
    expect(parsed.parseStatus).toBe("invalid_payload");
  });

  test("ignores literal skill tags inside inline code spans", () => {
    const raw = [
      "Explain the protocol tag literally:",
      `Use \`${CYRENE_SKILL_START_TAG}\` and \`${CYRENE_SKILL_END_TAG}\` in docs only.`,
    ].join("\n");

    const parsed = parseAssistantSkillUpdate(raw);

    expect(parsed.visibleText).toBe(raw);
    expect(parsed.skill).toBeNull();
    expect(parsed.hasSkillTag).toBe(false);
    expect(parsed.parseStatus).toBe("missing_tag");
  });

  test("trims trailing partial skill tags during streaming", () => {
    const visibleAnswer = "Visible answer";

    for (let length = 1; length < CYRENE_SKILL_START_TAG.length; length += 1) {
      const raw = `${visibleAnswer}${CYRENE_SKILL_START_TAG.slice(0, length)}`;
      const parsed = parseAssistantSkillUpdate(raw);

      expect(parsed.visibleText).toBe(visibleAnswer);
      expect(parsed.skill).toBeNull();
      expect(parsed.hasSkillTag).toBe(false);
      expect(parsed.isComplete).toBe(false);
      expect(parsed.parseStatus).toBe("missing_tag");
    }
  });
});
