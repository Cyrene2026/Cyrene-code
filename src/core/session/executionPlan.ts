import {
  WORKING_STATE_SECTION_ORDER,
  getWorkingStateEntryText,
  parseWorkingStateSummary,
  type WorkingStateSectionMap,
  type WorkingStateSectionName,
} from "./workingState";
import type {
  SessionExecutionPlan,
  SessionExecutionPlanStep,
  SessionExecutionPlanStepStatus,
} from "./types";

export const CYRENE_PLAN_START_TAG = "<cyrene_plan>";
export const CYRENE_PLAN_END_TAG = "</cyrene_plan>";

export type ParsedAssistantPlanUpdate = {
  visibleText: string;
  plan: SessionExecutionPlan | null;
  hasPlanTag: boolean;
  isComplete: boolean;
  parseStatus: "missing_tag" | "incomplete_tag" | "empty_payload" | "invalid_payload" | "valid";
};

type RawPlanStep = {
  id?: unknown;
  title?: unknown;
  details?: unknown;
  status?: unknown;
  evidence?: unknown;
  filePaths?: unknown;
  recentToolResult?: unknown;
};

type RawPlan = {
  version?: unknown;
  projectRoot?: unknown;
  summary?: unknown;
  objective?: unknown;
  acceptedAt?: unknown;
  acceptedSummary?: unknown;
  steps?: unknown;
};

const PLAN_STEP_STATUSES = new Set<SessionExecutionPlanStepStatus>([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const clip = (value: string, maxLength: number) => {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const clipSectionLine = (value: string, maxLength = 220) => clip(value, maxLength);

const buildSourcePreview = (visibleText: string, plan: SessionExecutionPlan) => {
  const previewSource = visibleText.trim() || plan.summary || plan.objective;
  return clip(previewSource, 160);
};

const trimTrailingPartialPlanTag = (text: string) => {
  for (let length = CYRENE_PLAN_START_TAG.length - 1; length > 0; length -= 1) {
    const partial = CYRENE_PLAN_START_TAG.slice(0, length);
    if (text.endsWith(partial)) {
      return text.slice(0, -length);
    }
  }
  return text;
};

const isInsideMarkdownCodeContext = (text: string, index: number) => {
  let inFence = false;
  const lines = text.slice(0, index).split(/\r?\n/);
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
    }
  }
  if (inFence) {
    return true;
  }

  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const linePrefix = text.slice(lineStart, index);
  const inlineBacktickCount = (linePrefix.match(/`/g) ?? []).length;
  return inlineBacktickCount % 2 === 1;
};

const findAssistantPlanTagIndex = (text: string) => {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const candidate = text.indexOf(CYRENE_PLAN_START_TAG, searchFrom);
    if (candidate < 0) {
      return -1;
    }
    if (!isInsideMarkdownCodeContext(text, candidate)) {
      return candidate;
    }
    searchFrom = candidate + CYRENE_PLAN_START_TAG.length;
  }
  return -1;
};

const normalizePlanStep = (step: RawPlanStep, index: number): SessionExecutionPlanStep | null => {
  const title = typeof step.title === "string" ? normalizeWhitespace(step.title) : "";
  if (!title) {
    return null;
  }
  const details = typeof step.details === "string" ? normalizeWhitespace(step.details) : "";
  const status =
    typeof step.status === "string" && PLAN_STEP_STATUSES.has(step.status as SessionExecutionPlanStepStatus)
      ? (step.status as SessionExecutionPlanStepStatus)
      : "pending";
  const idSource =
    typeof step.id === "string" && normalizeWhitespace(step.id)
      ? normalizeWhitespace(step.id)
      : `step-${index + 1}`;
  const evidence =
    Array.isArray(step.evidence)
      ? step.evidence
          .filter((item): item is string => typeof item === "string")
          .map(item => clip(item, 180))
          .filter(Boolean)
          .slice(0, 6)
      : [];
  const filePaths =
    Array.isArray(step.filePaths)
      ? step.filePaths
          .filter((item): item is string => typeof item === "string")
          .map(item => normalizeWhitespace(item))
          .filter(Boolean)
          .slice(0, 8)
      : [];
  const recentToolResult =
    typeof step.recentToolResult === "string"
      ? clip(step.recentToolResult, 180)
      : "";

  return {
    id: idSource,
    title,
    details,
    status,
    evidence,
    filePaths,
    recentToolResult,
  };
};

const normalizePlanRecord = (
  value: RawPlan,
  visibleText: string,
  capturedAt: string
): SessionExecutionPlan | null => {
  if (value.version !== 1 || !Array.isArray(value.steps)) {
    return null;
  }

  const summary = typeof value.summary === "string" ? normalizeWhitespace(value.summary) : "";
  const objective = typeof value.objective === "string" ? normalizeWhitespace(value.objective) : "";
  const projectRoot =
    typeof value.projectRoot === "string" ? normalizeWhitespace(value.projectRoot) : "";
  const acceptedAt =
    typeof value.acceptedAt === "string" ? normalizeWhitespace(value.acceptedAt) : "";
  const acceptedSummary =
    typeof value.acceptedSummary === "string" ? normalizeWhitespace(value.acceptedSummary) : "";
  const steps = value.steps
    .map((step, index) =>
      step && typeof step === "object"
        ? normalizePlanStep(step as RawPlanStep, index)
        : null
    )
    .filter((step): step is SessionExecutionPlanStep => Boolean(step))
    .slice(0, 12);

  if (!summary && !objective && steps.length === 0) {
    return null;
  }

  return {
    capturedAt,
    sourcePreview: "",
    projectRoot,
    summary,
    objective,
    acceptedAt,
    acceptedSummary,
    steps,
  };
};

export const parseAssistantPlanUpdate = (
  text: string,
  capturedAt = new Date().toISOString()
): ParsedAssistantPlanUpdate => {
  const start = findAssistantPlanTagIndex(text);
  if (start < 0) {
    return {
      visibleText: trimTrailingPartialPlanTag(text).trim(),
      plan: null,
      hasPlanTag: false,
      isComplete: false,
      parseStatus: "missing_tag",
    };
  }

  const before = text.slice(0, start);
  const afterStart = text.slice(start + CYRENE_PLAN_START_TAG.length);
  const end = afterStart.indexOf(CYRENE_PLAN_END_TAG);
  if (end < 0) {
    return {
      visibleText: before.trim(),
      plan: null,
      hasPlanTag: true,
      isComplete: false,
      parseStatus: "incomplete_tag",
    };
  }

  const payload = afterStart.slice(0, end).trim();
  const remainder = afterStart.slice(end + CYRENE_PLAN_END_TAG.length);
  const visibleText = [before, remainder].join("").trim();

  if (!payload) {
    return {
      visibleText,
      plan: null,
      hasPlanTag: true,
      isComplete: true,
      parseStatus: "empty_payload",
    };
  }

  try {
    const parsed = JSON.parse(payload) as RawPlan;
    const normalizedPlan = normalizePlanRecord(parsed, visibleText, capturedAt);
    if (!normalizedPlan) {
      return {
        visibleText,
        plan: null,
        hasPlanTag: true,
        isComplete: true,
        parseStatus: "invalid_payload",
      };
    }
    normalizedPlan.sourcePreview = buildSourcePreview(visibleText, normalizedPlan);
    return {
      visibleText,
      plan: normalizedPlan,
      hasPlanTag: true,
      isComplete: true,
      parseStatus: "valid",
    };
  } catch {
    return {
      visibleText,
      plan: null,
      hasPlanTag: true,
      isComplete: true,
      parseStatus: "invalid_payload",
    };
  }
};

export const formatExecutionPlan = (plan: SessionExecutionPlan | null) => {
  if (!plan || plan.steps.length === 0) {
    return "(none)";
  }

  const headerLines = [
    plan.projectRoot ? `project: ${plan.projectRoot}` : "",
    plan.summary ? `summary: ${plan.summary}` : "",
    plan.objective ? `objective: ${plan.objective}` : "",
    plan.acceptedAt
      ? `accepted: ${plan.acceptedAt}${plan.acceptedSummary ? ` | ${plan.acceptedSummary}` : ""}`
      : "",
  ].filter(Boolean);

  const stepLines = plan.steps.map(
    (step, index) => {
      const suffix: string[] = [];
      if (step.details) {
        suffix.push(step.details);
      }
      if (step.filePaths.length > 0) {
        suffix.push(`paths ${step.filePaths.slice(0, 3).join(", ")}`);
      }
      if (step.recentToolResult) {
        suffix.push(`tool ${step.recentToolResult}`);
      }
      return `${index + 1}. [${step.status}] ${step.title}${suffix.length > 0 ? ` | ${suffix.join(" | ")}` : ""}`;
    }
  );

  return [...headerLines, ...stepLines].join("\n");
};

const mergeUniqueLines = (existing: string[], next: string[]) => {
  const merged = [...existing];
  for (const item of next) {
    if (item && !merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
};

const PLAN_COMPLETED_PREFIX = "Completed plan step: ";
const PLAN_REMAINING_PREFIX = "Remaining plan step: ";
const PLAN_NEXT_ACTION_PREFIXES = [
  "Continue with active plan step: ",
  "Next plan step: ",
] as const;
const PLAN_BLOCKED_PREFIX = "Blocked plan step: ";
const PLAN_ACCEPTED_PREFIX = "Execution plan accepted at ";

const normalizePlanLinkedLine = (line: string) =>
  getWorkingStateEntryText(line) ||
  line
    .trim()
    .replace(/^-\s+/, "")
    .trim();

const stripPrefixedLines = (lines: string[], prefixes: readonly string[]) =>
  lines.filter(line => {
    const normalized = normalizePlanLinkedLine(line);
    return !prefixes.some(prefix => normalized.startsWith(prefix));
  });

const renderWorkingState = (sections: WorkingStateSectionMap) =>
  WORKING_STATE_SECTION_ORDER.map(section => {
    const lines = sections[section] ?? [];
    return `${section}:\n${lines.length > 0 ? lines.map(line => `- ${line}`).join("\n") : "(none)"}`;
  }).join("\n\n");

const upsertSection = (
  sections: WorkingStateSectionMap,
  section: WorkingStateSectionName,
  lines: string[],
  mode: "replace" | "merge"
) => {
  const normalized = lines.map(line => clipSectionLine(line)).filter(Boolean);
  if (mode === "replace") {
    sections[section] = normalized;
    return;
  }
  sections[section] = mergeUniqueLines(sections[section] ?? [], normalized);
};

export const applyExecutionPlanToWorkingState = (input: {
  summary: string;
  pendingDigest: string;
  plan: SessionExecutionPlan | null;
}) => {
  if (!input.plan) {
    return {
      summary: input.summary.trim(),
      pendingDigest: input.pendingDigest.trim(),
    };
  }

  const summarySections = parseWorkingStateSummary(input.summary);
  const pendingSections = parseWorkingStateSummary(input.pendingDigest);
  const completed = input.plan.steps
    .filter(step => step.status === "completed")
    .map(step => `${PLAN_COMPLETED_PREFIX}${step.title}`);
  const remaining = input.plan.steps
    .filter(step => step.status === "pending" || step.status === "in_progress" || step.status === "blocked")
    .map(step =>
      step.status === "blocked" && step.details
        ? `${PLAN_REMAINING_PREFIX}${step.title} (blocked: ${step.details})`
        : `${PLAN_REMAINING_PREFIX}${step.title}`
    );
  const nextActions = input.plan.steps
    .filter(step => step.status === "in_progress" || step.status === "pending")
    .slice(0, 3)
    .map(step =>
      step.status === "in_progress"
        ? `${PLAN_NEXT_ACTION_PREFIXES[0]}${step.title}`
        : `${PLAN_NEXT_ACTION_PREFIXES[1]}${step.title}`
    );
  const blocked = input.plan.steps
    .filter(step => step.status === "blocked")
    .map(step =>
      step.details
        ? `${PLAN_BLOCKED_PREFIX}${step.title} - ${step.details}`
        : `${PLAN_BLOCKED_PREFIX}${step.title}`
    );
  const objectiveLine = input.plan.objective || input.plan.summary;
  const acceptanceLine = input.plan.acceptedAt
    ? `${PLAN_ACCEPTED_PREFIX}${input.plan.acceptedAt}${
        input.plan.acceptedSummary ? `: ${input.plan.acceptedSummary}` : ""
      }`
    : "";

  if (objectiveLine) {
    upsertSection(summarySections, "OBJECTIVE", [objectiveLine], "replace");
    upsertSection(pendingSections, "OBJECTIVE", [objectiveLine], "replace");
  }
  if (acceptanceLine) {
    upsertSection(summarySections, "COMPLETED", [acceptanceLine], "merge");
    upsertSection(pendingSections, "COMPLETED", [acceptanceLine], "merge");
  }
  upsertSection(summarySections, "COMPLETED", completed, "merge");
  upsertSection(summarySections, "REMAINING", remaining, "replace");
  upsertSection(summarySections, "NEXT BEST ACTIONS", nextActions, "replace");
  upsertSection(summarySections, "RECENT FAILURES", blocked, "merge");

  upsertSection(pendingSections, "COMPLETED", completed, "replace");
  upsertSection(pendingSections, "REMAINING", remaining, "replace");
  upsertSection(pendingSections, "NEXT BEST ACTIONS", nextActions, "replace");
  upsertSection(pendingSections, "RECENT FAILURES", blocked, "replace");

  return {
    summary: renderWorkingState(summarySections),
    pendingDigest: renderWorkingState(pendingSections),
  };
};

export const stripExecutionPlanFromWorkingState = (input: {
  summary: string;
  pendingDigest: string;
  plan: SessionExecutionPlan | null;
}) => {
  if (!input.plan) {
    return {
      summary: input.summary.trim(),
      pendingDigest: input.pendingDigest.trim(),
    };
  }

  const summarySections = parseWorkingStateSummary(input.summary);
  const pendingSections = parseWorkingStateSummary(input.pendingDigest);
  const planObjective = input.plan.objective || input.plan.summary;

  summarySections.COMPLETED = stripPrefixedLines(summarySections.COMPLETED ?? [], [
    PLAN_COMPLETED_PREFIX,
    PLAN_ACCEPTED_PREFIX,
  ]);
  summarySections.REMAINING = stripPrefixedLines(summarySections.REMAINING ?? [], [
    PLAN_REMAINING_PREFIX,
  ]);
  summarySections["NEXT BEST ACTIONS"] = stripPrefixedLines(
    summarySections["NEXT BEST ACTIONS"] ?? [],
    PLAN_NEXT_ACTION_PREFIXES
  );
  summarySections["RECENT FAILURES"] = stripPrefixedLines(
    summarySections["RECENT FAILURES"] ?? [],
    [PLAN_BLOCKED_PREFIX]
  );
  if (planObjective) {
    summarySections.OBJECTIVE = (summarySections.OBJECTIVE ?? []).filter(
      line => normalizePlanLinkedLine(line) !== planObjective
    );
  }

  pendingSections.COMPLETED = stripPrefixedLines(pendingSections.COMPLETED ?? [], [
    PLAN_COMPLETED_PREFIX,
    PLAN_ACCEPTED_PREFIX,
  ]);
  pendingSections.REMAINING = stripPrefixedLines(pendingSections.REMAINING ?? [], [
    PLAN_REMAINING_PREFIX,
  ]);
  pendingSections["NEXT BEST ACTIONS"] = stripPrefixedLines(
    pendingSections["NEXT BEST ACTIONS"] ?? [],
    PLAN_NEXT_ACTION_PREFIXES
  );
  pendingSections["RECENT FAILURES"] = stripPrefixedLines(
    pendingSections["RECENT FAILURES"] ?? [],
    [PLAN_BLOCKED_PREFIX]
  );
  if (planObjective) {
    pendingSections.OBJECTIVE = (pendingSections.OBJECTIVE ?? []).filter(
      line => normalizePlanLinkedLine(line) !== planObjective
    );
  }

  return {
    summary: renderWorkingState(summarySections),
    pendingDigest: renderWorkingState(pendingSections),
  };
};
