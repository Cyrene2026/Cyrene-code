import { normalizeExtensionExposureMode } from "../extensions/metadata";
import type { SkillCreationInput } from "./types";

export const CYRENE_SKILL_START_TAG = "<cyrene_skill>";
export const CYRENE_SKILL_END_TAG = "</cyrene_skill>";

export type ParsedAssistantSkillUpdate = {
  visibleText: string;
  skill: SkillCreationInput | null;
  hasSkillTag: boolean;
  isComplete: boolean;
  parseStatus:
    | "missing_tag"
    | "incomplete_tag"
    | "empty_payload"
    | "invalid_payload"
    | "valid";
};

type RawSkillPayload = {
  version?: unknown;
  id?: unknown;
  label?: unknown;
  description?: unknown;
  prompt?: unknown;
  triggers?: unknown;
  tags?: unknown;
  exposure?: unknown;
  enabled?: unknown;
  scope?: unknown;
};

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const normalizeStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map(item => normalizeWhitespace(item))
        .filter(Boolean)
    : [];

const dedupeStrings = (values: string[]) => Array.from(new Set(values));

const normalizeSkillId = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
};

const normalizeSkillPayload = (payload: RawSkillPayload): SkillCreationInput | null => {
  if (payload.version !== 1) {
    return null;
  }

  const id = normalizeSkillId(payload.id);
  const label = typeof payload.label === "string" ? normalizeWhitespace(payload.label) : "";
  const description =
    typeof payload.description === "string"
      ? normalizeWhitespace(payload.description)
      : undefined;
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const triggers = dedupeStrings(normalizeStringArray(payload.triggers));
  const tags = dedupeStrings(normalizeStringArray(payload.tags));
  const exposure = normalizeExtensionExposureMode(payload.exposure) ?? "scoped";
  const scope =
    payload.scope === "global" || payload.scope === "project" ? payload.scope : "project";

  if (!id || !label || !prompt || triggers.length === 0) {
    return null;
  }

  return {
    id,
    label,
    description,
    prompt,
    triggers,
    exposure,
    tags,
    enabled: payload.enabled === false ? false : true,
    scope,
  };
};

export const parseAssistantSkillUpdate = (
  text: string
): ParsedAssistantSkillUpdate => {
  const start = text.indexOf(CYRENE_SKILL_START_TAG);
  if (start < 0) {
    return {
      visibleText: text.trim(),
      skill: null,
      hasSkillTag: false,
      isComplete: false,
      parseStatus: "missing_tag",
    };
  }

  const before = text.slice(0, start);
  const afterStart = text.slice(start + CYRENE_SKILL_START_TAG.length);
  const end = afterStart.indexOf(CYRENE_SKILL_END_TAG);
  if (end < 0) {
    return {
      visibleText: before.trim(),
      skill: null,
      hasSkillTag: true,
      isComplete: false,
      parseStatus: "incomplete_tag",
    };
  }

  const payload = afterStart.slice(0, end).trim();
  const remainder = afterStart.slice(end + CYRENE_SKILL_END_TAG.length);
  const visibleText = [before, remainder].join("").trim();

  if (!payload) {
    return {
      visibleText,
      skill: null,
      hasSkillTag: true,
      isComplete: true,
      parseStatus: "empty_payload",
    };
  }

  try {
    const parsed = JSON.parse(payload) as RawSkillPayload;
    const skill = normalizeSkillPayload(parsed);
    if (!skill) {
      return {
        visibleText,
        skill: null,
        hasSkillTag: true,
        isComplete: true,
        parseStatus: "invalid_payload",
      };
    }
    return {
      visibleText,
      skill,
      hasSkillTag: true,
      isComplete: true,
      parseStatus: "valid",
    };
  } catch {
    return {
      visibleText,
      skill: null,
      hasSkillTag: true,
      isComplete: true,
      parseStatus: "invalid_payload",
    };
  }
};
