import { expect, test } from "bun:test";
import {
  extractPendingChoiceFromAssistantText,
  parsePendingChoiceReferenceIndex,
  resolvePendingChoiceInput,
} from "../src/core/session/pendingChoice";

test("extractPendingChoiceFromAssistantText captures consecutive numbered options", () => {
  const pendingChoice = extractPendingChoiceFromAssistantText([
    "如果你愿意，我可以继续：",
    "1. 补 README.md 的 curl 示例",
    "2. 补 Python requests 调用示例",
    "3. 补启动说明",
    "",
    "你回复一个数字，我就继续。",
  ].join("\n"));

  expect(pendingChoice?.options).toEqual([
    { index: 1, label: "补 README.md 的 curl 示例" },
    { index: 2, label: "补 Python requests 调用示例" },
    { index: 3, label: "补启动说明" },
  ]);
});

test("extractPendingChoiceFromAssistantText ignores single numbered lines and code blocks", () => {
  expect(
    extractPendingChoiceFromAssistantText([
      "回复一个数字继续：",
      "```text",
      "1. not a menu inside code",
      "2. still not a menu",
      "```",
      "1. only one visible item",
    ].join("\n"))
  ).toBeNull();
});

test("extractPendingChoiceFromAssistantText requires an explicit menu cue", () => {
  expect(
    extractPendingChoiceFromAssistantText([
      "项目概况：",
      "1. API 层",
      "2. 数据层",
      "3. 测试层",
    ].join("\n"))
  ).toBeNull();
});

test("resolvePendingChoiceInput supports digit and ordinal references", () => {
  const pendingChoice = extractPendingChoiceFromAssistantText([
    "你回复一个数字，我继续。",
    "1. 第一个动作",
    "2. 第二个动作",
  ].join("\n"));

  expect(parsePendingChoiceReferenceIndex("1")).toBe(1);
  expect(parsePendingChoiceReferenceIndex("第一个")).toBe(1);
  expect(parsePendingChoiceReferenceIndex("第2项")).toBe(2);
  expect(parsePendingChoiceReferenceIndex("继续第一个")).toBe(1);
  expect(parsePendingChoiceReferenceIndex("选1")).toBe(1);
  expect(parsePendingChoiceReferenceIndex("上面的1")).toBe(1);

  const resolved = resolvePendingChoiceInput("第一个", pendingChoice);
  expect(resolved.kind).toBe("resolved");
  if (resolved.kind === "resolved") {
    expect(resolved.resolvedQuery).toContain("第一个动作");
    expect(resolved.displayText).toContain("第一个");
  }
});
