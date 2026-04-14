import { describe, expect, test } from "bun:test";
import {
  buildSkillCreationTaskFromSummary,
  chooseSkillCreationTask,
  detectStableSkillPattern,
} from "../src/core/skills";

describe("skillSuggestion", () => {
  test("prefers structured session summary for skill creation context", () => {
    const summary = [
      "OBJECTIVE:",
      "- review provider overrides and normalize profile/type/format handling",
      "",
      "CONFIRMED FACTS:",
      "- provider profile commands share the same validation path",
      "",
      "REMAINING:",
      "- unify provider override mutation flow",
      "",
      "NEXT BEST ACTIONS:",
      "- extract shared override helpers",
    ].join("\n");

    expect(chooseSkillCreationTask(summary, "last user task")).toContain(
      "OBJECTIVE:"
    );
    expect(buildSkillCreationTaskFromSummary(summary)).toContain(
      "- review provider overrides and normalize profile/type/format handling"
    );
  });

  test("falls back to latest user task when summary is empty", () => {
    expect(chooseSkillCreationTask("", "fix auth refresh flow")).toBe(
      "fix auth refresh flow"
    );
  });

  test("detects stable repeated workflow patterns from summary", () => {
    const summary = [
      "OBJECTIVE:",
      "- tighten provider override workflows",
      "",
      "COMPLETED:",
      "- review provider profile override command handling",
      "- update provider profile override validation",
      "",
      "REMAINING:",
      "- verify provider profile override persistence",
      "",
      "NEXT BEST ACTIONS:",
      "- document provider profile override behavior",
    ].join("\n");

    const suggestion = detectStableSkillPattern(summary);
    expect(suggestion).not.toBeNull();
    expect(suggestion?.phrase.length ?? 0).toBeGreaterThan(0);
    expect(suggestion?.sampleLines.length).toBeGreaterThanOrEqual(2);
    expect(suggestion?.sampleLines.join("\n")).toContain("override");
  });

  test("does not suggest a skill for summaries already about skill generation", () => {
    const summary = [
      "OBJECTIVE:",
      "- build skill create support",
      "",
      "REMAINING:",
      "- wire /skills create into bridge",
      "- write skills.yaml globally",
    ].join("\n");

    expect(detectStableSkillPattern(summary)).toBeNull();
  });
});
