import { z } from "zod";
import {
  WORKING_STATE_SECTION_ORDER,
  parseWorkingStateSummary,
  repairWorkingStateSummary,
  type WorkingStateSectionMap,
  type WorkingStateSectionName,
} from "./workingState";

export const CYRENE_STATE_UPDATE_START_TAG = "<cyrene_state_update>";
export const CYRENE_STATE_UPDATE_END_TAG = "</cyrene_state_update>";

export type ReducerMode =
  | "disabled"
  | "digest_only"
  | "merge_and_digest"
  | "full_rebuild_and_digest";

export type WorkingStatePatchOperation = {
  op: "keep" | "replace" | "merge";
  set?: string[];
  add?: string[];
  remove?: string[];
};

export type CyreneStateUpdate = {
  version: 1;
  mode: Exclude<ReducerMode, "disabled">;
  summaryPatch?: Partial<
    Record<WorkingStateSectionName, WorkingStatePatchOperation>
  >;
  nextPendingDigest?: WorkingStateSectionMap;
};

export type ParsedAssistantStateUpdate = {
  visibleText: string;
  update: CyreneStateUpdate | null;
  hasStateTag: boolean;
  isComplete: boolean;
  parseStatus:
    | "missing_tag"
    | "incomplete_tag"
    | "empty_payload"
    | "invalid_payload"
    | "valid";
};

type BuildReducerPromptOptions = {
  mode: ReducerMode;
  durableSummary: string;
  pendingDigest: string;
  summaryRecoveryNeeded: boolean;
};

const STATE_LINE_LIMIT = 220;
const PENDING_DIGEST_TOTAL_CHAR_LIMIT = 800;
const PENDING_SECTION_ITEM_LIMIT = 2;

const SECTION_ITEM_LIMITS: Record<WorkingStateSectionName, number> = {
  OBJECTIVE: 1,
  "CONFIRMED FACTS": 5,
  CONSTRAINTS: 5,
  COMPLETED: 5,
  REMAINING: 4,
  "KNOWN PATHS": 5,
  "RECENT FAILURES": 4,
  "NEXT BEST ACTIONS": 3,
};

const PENDING_DIGEST_TRIM_ORDER: WorkingStateSectionName[] = [
  "KNOWN PATHS",
  "CONFIRMED FACTS",
  "CONSTRAINTS",
  "RECENT FAILURES",
  "COMPLETED",
  "REMAINING",
  "NEXT BEST ACTIONS",
  "OBJECTIVE",
];

const sectionNames = WORKING_STATE_SECTION_ORDER.map(section =>
  z.array(z.string()).optional()
) as [
  z.ZodOptional<z.ZodArray<z.ZodString>>,
  ...z.ZodOptional<z.ZodArray<z.ZodString>>[],
];

const sectionShape = Object.fromEntries(
  WORKING_STATE_SECTION_ORDER.map((section, index) => [
    section,
    sectionNames[index] ?? z.array(z.string()).optional(),
  ])
) as Record<WorkingStateSectionName, z.ZodOptional<z.ZodArray<z.ZodString>>>;

const patchEntrySchema = z.object({
  op: z.enum(["keep", "replace", "merge"]),
  set: z.array(z.string()).optional(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

const stateUpdateSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["digest_only", "merge_and_digest", "full_rebuild_and_digest"]),
  summaryPatch: z.object(
    Object.fromEntries(
      WORKING_STATE_SECTION_ORDER.map(section => [section, patchEntrySchema.optional()])
    ) as Record<WorkingStateSectionName, z.ZodOptional<typeof patchEntrySchema>>
  )
    .partial()
    .optional(),
  nextPendingDigest: z.object(sectionShape).partial().optional(),
});

const clipStateLine = (text: string, max = STATE_LINE_LIMIT) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
};

const normalizeLooseLine = (line: string) =>
  clipStateLine(
    line
      .trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
  );

const createEmptySectionMap = (): Record<WorkingStateSectionName, string[]> =>
  Object.fromEntries(
    WORKING_STATE_SECTION_ORDER.map(section => [section, [] as string[]])
  ) as Record<WorkingStateSectionName, string[]>;

const normalizeUniqueLines = (
  lines: string[] | undefined,
  limit: number
) => {
  if (!lines || lines.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of lines) {
    const candidate = normalizeLooseLine(line);
    if (!candidate || candidate === "(none)" || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
};

const hasMeaningfulSectionContent = (sections: WorkingStateSectionMap) =>
  WORKING_STATE_SECTION_ORDER.some(section => (sections[section]?.length ?? 0) > 0);

const renderSectionMap = (
  sections: WorkingStateSectionMap,
  options?: {
    pending?: boolean;
    preserveEmpty?: boolean;
  }
) => {
  const pending = options?.pending ?? false;
  const sectionMap = createEmptySectionMap();

  for (const section of WORKING_STATE_SECTION_ORDER) {
    const limit = pending
      ? PENDING_SECTION_ITEM_LIMIT
      : SECTION_ITEM_LIMITS[section];
    sectionMap[section] = normalizeUniqueLines(sections[section], limit);
  }

  if (pending) {
    let rendered = WORKING_STATE_SECTION_ORDER.map(section => {
      const lines = sectionMap[section];
      if (lines.length === 0) {
        return `${section}:\n- (none)`;
      }
      return `${section}:\n${lines.map(line => `- ${line}`).join("\n")}`;
    }).join("\n\n");

    if (!hasMeaningfulSectionContent(sectionMap)) {
      return "";
    }

    while (rendered.length > PENDING_DIGEST_TOTAL_CHAR_LIMIT) {
      let trimmedAny = false;
      for (const section of PENDING_DIGEST_TRIM_ORDER) {
        if ((sectionMap[section]?.length ?? 0) === 0) {
          continue;
        }
        sectionMap[section] = sectionMap[section]!.slice(
          0,
          Math.max(0, sectionMap[section]!.length - 1)
        );
        trimmedAny = true;
        break;
      }
      if (!trimmedAny || !hasMeaningfulSectionContent(sectionMap)) {
        break;
      }
      rendered = WORKING_STATE_SECTION_ORDER.map(section => {
        const lines = sectionMap[section];
        if (lines.length === 0) {
          return `${section}:\n- (none)`;
        }
        return `${section}:\n${lines.map(line => `- ${line}`).join("\n")}`;
      }).join("\n\n");
    }

    return hasMeaningfulSectionContent(sectionMap) ? rendered : "";
  }

  if (!options?.preserveEmpty && !hasMeaningfulSectionContent(sectionMap)) {
    return "";
  }

  return WORKING_STATE_SECTION_ORDER.map(section => {
    const lines = sectionMap[section];
    if (lines.length === 0) {
      return `${section}:\n- (none)`;
    }
    return `${section}:\n${lines.map(line => `- ${line}`).join("\n")}`;
  }).join("\n\n");
};

const parseStructuredStateText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return createEmptySectionMap();
  }
  const repaired = repairWorkingStateSummary(trimmed);
  const parsed = parseWorkingStateSummary(repaired);
  const sectionMap = createEmptySectionMap();
  for (const section of WORKING_STATE_SECTION_ORDER) {
    sectionMap[section] = normalizeUniqueLines(
      parsed[section],
      SECTION_ITEM_LIMITS[section]
    );
  }
  return sectionMap;
};

const normalizeSectionMapInput = (
  sectionMap: WorkingStateSectionMap | undefined,
  pending = false
) => {
  const normalized = createEmptySectionMap();
  for (const section of WORKING_STATE_SECTION_ORDER) {
    normalized[section] = normalizeUniqueLines(
      sectionMap?.[section],
      pending ? PENDING_SECTION_ITEM_LIMIT : SECTION_ITEM_LIMITS[section]
    );
  }
  return normalized;
};

const normalizeForComparison = (lines: string[]) =>
  new Set(lines.map(line => normalizeLooseLine(line)).filter(Boolean));

const trimTrailingPartialStateTag = (text: string) => {
  for (
    let length = CYRENE_STATE_UPDATE_START_TAG.length - 1;
    length > 0;
    length -= 1
  ) {
    const partial = CYRENE_STATE_UPDATE_START_TAG.slice(0, length);
    if (text.endsWith(partial)) {
      return text.slice(0, -length);
    }
  }
  return text;
};

export const deriveReducerMode = (params: {
  enabled: boolean;
  durableSummary: string;
  pendingDigest: string;
  priorMessageCount: number;
  priorAssistantMessageCount: number;
}): ReducerMode => {
  if (!params.enabled) {
    return "disabled";
  }
  if (params.durableSummary.trim() || params.pendingDigest.trim()) {
    return "merge_and_digest";
  }
  if (params.priorMessageCount === 0 || params.priorAssistantMessageCount === 0) {
    return "digest_only";
  }
  return "full_rebuild_and_digest";
};

export const buildStateReducerPrompt = ({
  mode,
  durableSummary,
  pendingDigest,
  summaryRecoveryNeeded,
}: BuildReducerPromptOptions) => {
  if (mode === "disabled") {
    return "";
  }

  const modeLine =
    mode === "digest_only"
      ? "Current reducer mode: digest_only. Do not update the durable summary yet. Produce nextPendingDigest for the current turn only."
      : mode === "full_rebuild_and_digest"
        ? "Current reducer mode: full_rebuild_and_digest. Rebuild the durable summary from prior evidence before the current user turn, then produce nextPendingDigest for the current turn."
        : "Current reducer mode: merge_and_digest. summaryPatch must advance the durable summary using prior persisted state and the previous pending digest only; nextPendingDigest captures the current turn only.";

  const recoveryLine =
    summaryRecoveryNeeded && !durableSummary.trim()
      ? "The persisted durable summary is missing or stale. Use archive memory and transcript context to rebuild it in summaryPatch."
      : "";

  return [
    "STATE REDUCER PROTOCOL:",
    "After the visible answer, append exactly one hidden block with no Markdown fences:",
    `${CYRENE_STATE_UPDATE_START_TAG}{JSON}${CYRENE_STATE_UPDATE_END_TAG}`,
    modeLine,
    pendingDigest.trim()
      ? "The previous pending digest is the only lagging state that should move into summaryPatch."
      : "There is no previous pending digest to merge.",
    durableSummary.trim()
      ? "Preserve durable summary facts unless contradicted by newer evidence."
      : "There is no persisted durable summary yet.",
    recoveryLine,
    "Use only these section names: OBJECTIVE, CONFIRMED FACTS, CONSTRAINTS, COMPLETED, REMAINING, KNOWN PATHS, RECENT FAILURES, NEXT BEST ACTIONS.",
    "Keep each line short, concrete, and deduplicated. Never put the current-turn digest into summaryPatch.",
    "JSON shape:",
    `{"version":1,"mode":"${mode === "disabled" ? "digest_only" : mode}","summaryPatch":{"OBJECTIVE":{"op":"keep|replace","set":["..."]},"CONFIRMED FACTS":{"op":"merge","add":["..."],"remove":["..."]}},"nextPendingDigest":{"OBJECTIVE":["..."]}}`,
  ]
    .filter(Boolean)
    .join("\n");
};

export const parseAssistantStateUpdate = (
  rawAssistantText: string
): ParsedAssistantStateUpdate => {
  const startIndex = rawAssistantText.indexOf(CYRENE_STATE_UPDATE_START_TAG);
  if (startIndex < 0) {
    return {
      visibleText: trimTrailingPartialStateTag(rawAssistantText),
      update: null,
      hasStateTag: false,
      isComplete: false,
      parseStatus: "missing_tag",
    };
  }

  const visibleText = rawAssistantText.slice(0, startIndex).replace(/\s+$/, "");
  const payloadStart = startIndex + CYRENE_STATE_UPDATE_START_TAG.length;
  const endIndex = rawAssistantText.indexOf(
    CYRENE_STATE_UPDATE_END_TAG,
    payloadStart
  );

  if (endIndex < 0) {
    return {
      visibleText,
      update: null,
      hasStateTag: true,
      isComplete: false,
      parseStatus: "incomplete_tag",
    };
  }

  const payload = rawAssistantText.slice(payloadStart, endIndex).trim();
  if (!payload) {
    return {
      visibleText,
      update: null,
      hasStateTag: true,
      isComplete: true,
      parseStatus: "empty_payload",
    };
  }

  try {
    const parsed = stateUpdateSchema.safeParse(JSON.parse(payload) as unknown);
    return {
      visibleText,
      update: parsed.success ? parsed.data : null,
      hasStateTag: true,
      isComplete: true,
      parseStatus: parsed.success ? "valid" : "invalid_payload",
    };
  } catch {
    return {
      visibleText,
      update: null,
      hasStateTag: true,
      isComplete: true,
      parseStatus: "invalid_payload",
    };
  }
};

export const applyParsedStateUpdate = (params: {
  durableSummary: string;
  pendingDigest: string;
  update: CyreneStateUpdate | null;
}) => {
  const normalizedSummary = params.durableSummary.trim()
    ? renderSectionMap(parseStructuredStateText(params.durableSummary), {
        preserveEmpty: true,
      })
    : "";

  if (!params.update) {
    return {
      summary: normalizedSummary,
      pendingDigest: params.pendingDigest.trim(),
      updated: false,
    };
  }

  const nextPendingDigest = renderSectionMap(
    normalizeSectionMapInput(params.update.nextPendingDigest, true),
    { pending: true }
  );

  if (params.update.mode === "digest_only") {
    return {
      summary: normalizedSummary,
      pendingDigest: nextPendingDigest,
      updated: true,
    };
  }

  const baseSections =
    params.update.mode === "full_rebuild_and_digest"
      ? createEmptySectionMap()
      : parseStructuredStateText(normalizedSummary);

  for (const section of WORKING_STATE_SECTION_ORDER) {
    const patch = params.update.summaryPatch?.[section];
    if (!patch || patch.op === "keep") {
      continue;
    }

    if (patch.op === "replace") {
      baseSections[section] = normalizeUniqueLines(
        patch.set,
        SECTION_ITEM_LIMITS[section]
      );
      continue;
    }

    const removes = normalizeForComparison(patch.remove ?? []);
    const merged = [
      ...baseSections[section].filter(
        line => !removes.has(normalizeLooseLine(line))
      ),
      ...normalizeUniqueLines(patch.add, SECTION_ITEM_LIMITS[section]),
    ];
    baseSections[section] = normalizeUniqueLines(
      merged,
      SECTION_ITEM_LIMITS[section]
    );
  }

  const completedSet = normalizeForComparison(baseSections.COMPLETED);
  if (completedSet.size > 0) {
    baseSections.REMAINING = baseSections.REMAINING.filter(
      line => !completedSet.has(normalizeLooseLine(line))
    );
    baseSections["NEXT BEST ACTIONS"] = baseSections["NEXT BEST ACTIONS"].filter(
      line => !completedSet.has(normalizeLooseLine(line))
    );
  }

  const summary = renderSectionMap(baseSections, { preserveEmpty: true });
  return {
    summary,
    pendingDigest: nextPendingDigest,
    updated: true,
  };
};
