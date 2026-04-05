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

const collectPathCandidates = (text: string) =>
  Array.from(
    new Set(
      (text.match(/[a-z0-9_.\\/:-]+\.[a-z0-9]+/gi) ?? []).map(candidate =>
        candidate.replace(/\\/g, "/")
      )
    )
  ).slice(0, 8);

const SELF_TALK_PREFIXES = [
  "我来",
  "我先",
  "让我",
  "我需要",
  "我会",
  "我将",
  "我继续",
  "我再",
  "先让我",
  "先看一下",
  "再看一下",
  "接下来我会",
  "let me",
  "i'll",
  "i will",
  "first i'll",
  "first, i'll",
  "i need to",
  "i am going to",
  "i'm going to",
  "next i'll",
  "next, i'll",
] as const;

const POLITE_REQUEST_PREFIXES = [
  "请你",
  "请帮我",
  "请",
  "帮我",
  "麻烦",
  "please ",
  "please,",
  "can you ",
  "could you ",
] as const;

const TASK_LEADIN_PREFIXES = [
  "开始",
  "继续",
  "接着",
  "然后",
  "下一步",
  "接下来",
] as const;

const EXECUTABLE_TASK_SIGNAL =
  /\b(?:analyze|check|debug|diagnose|fix|optimize|implement|build|create|write|edit|update|inspect|read|review|summarize|explain|verify|run|test|resume|continue|finish|refactor|split|trace|investigate)\b|(?:看一下|看看|查看|读取|阅读|读一下|分析|检查|排查|修复|优化|实现|构建|创建|写入?|编辑|更新|审查|总结|解释|验证|运行|测试|恢复|继续|完成|重构|拆分|追踪|调查)/iu;

const STABLE_FACT_SIGNAL =
  /\b(?:is|are|was|were|has|have|uses?|supports?|contains?|includes?|returns?|exposes?|depends?|configured|stored|persisted|confirmed|verified|located|path|endpoint|route|version|setting|config|file|directory|workspace|session|state)\b|(?:是|位于|包含|使用|支持|返回|暴露|依赖|配置|已配置|已确认|已验证|路径|接口|路由|版本|文件|目录|工作区|会话|状态)/iu;

const COMPLETED_SECTION_SIGNAL =
  /\b(?:done|completed|finished|wrote|created|updated|implemented|fixed|approved|resolved|answered|added|removed|renamed|stored|persisted|recorded|marked|recovered|handled|captured|merged|rebuilt|synced)\b|(?:完成|已写|已创建|已更新|已实现|已修复|已批准|已解决|已回答|已添加|已删除|已重命名|已存储|已记录|已标记|已恢复|已处理|已合并|已重建|已同步|标记为)/iu;

const CONSTRAINT_SECTION_SIGNAL =
  /\b(?:must|should|cannot|can't|do not|don't|avoid|pending approval|requires|limit|constraint|read-only|blocked|must not|no code changes)\b|(?:必须|不能|不要|避免|待审批|需要|限制|约束|只读|阻塞|不改|不准)/iu;

const REAL_FAILURE_SIGNAL =
  /\b(?:failed|error|errored|timeout|timed out|rejected|blocked|denied|missing|exception|crash|aborted|not found|conflict)\b|(?:失败|错误|超时|拒绝|阻塞|缺失|异常|崩溃|中止|未找到|冲突)/iu;

const META_FAILURE_SIGNAL =
  /\b(?:used to|used for|helps determine|determines whether|detects whether|checks whether|classification|type)\b|(?:用于|用来|帮助判断|判断|检测|识别|类型)/iu;

const META_FAILURE_PREFIX =
  /^(?:if|when|used to|used for|helps determine|determines whether|detects whether|checks whether|判断|检测|识别|用来|用于|如果|若|当|说明)/iu;

const QUESTION_OR_OPTION_SIGNAL =
  /[?？]|\b(?:if you want|would you like|you can ask|next i can|do you want)\b|(?:如果你愿意|你要我|下一步可以)/iu;

const trimLeadingSeparators = (value: string) =>
  value.replace(/^[\s,，:：;；.\-–—]+/u, "").trim();

const stripLeadingPhrases = (value: string, phrases: readonly string[]) => {
  let current = value.trim();

  while (current) {
    const lower = current.toLowerCase();
    const matched = phrases.find(phrase => lower.startsWith(phrase));
    if (!matched) {
      break;
    }
    current = trimLeadingSeparators(current.slice(matched.length));
  }

  return current;
};

const sanitizeCandidatePrefix = (value: string) =>
  stripLeadingPhrases(
    stripLeadingPhrases(value, SELF_TALK_PREFIXES),
    POLITE_REQUEST_PREFIXES
  );

const isPurePathLine = (line: string) => {
  const paths = collectPathCandidates(line);
  if (paths.length !== 1) {
    return false;
  }
  const collapsed = line
    .replace(/[`\s"'()[\]{}]/g, "")
    .replace(/\\/g, "/")
    .trim();
  return collapsed === paths[0];
};

const isExecutableTaskLine = (line: string) =>
  EXECUTABLE_TASK_SIGNAL.test(stripLeadingPhrases(line, TASK_LEADIN_PREFIXES));

const isStableFactLine = (line: string) =>
  !QUESTION_OR_OPTION_SIGNAL.test(line) &&
  !isExecutableTaskLine(line) &&
  !REAL_FAILURE_SIGNAL.test(line) &&
  (STABLE_FACT_SIGNAL.test(line) ||
    collectPathCandidates(line).length > 0 ||
    /`[^`]+`/.test(line));

const isRealFailureLine = (line: string) =>
  REAL_FAILURE_SIGNAL.test(line) &&
  !META_FAILURE_PREFIX.test(line) &&
  !META_FAILURE_SIGNAL.test(line) &&
  !QUESTION_OR_OPTION_SIGNAL.test(line);

const normalizeSectionLine = (
  section: WorkingStateSectionName,
  line: string
) => {
  const rawCandidate = normalizeLooseLine(line);
  if (!rawCandidate || rawCandidate === "(none)") {
    return null;
  }

  const candidate = sanitizeCandidatePrefix(rawCandidate);
  if (!candidate || candidate === "(none)") {
    return null;
  }

  switch (section) {
    case "OBJECTIVE": {
      const objective = stripLeadingPhrases(candidate, TASK_LEADIN_PREFIXES);
      if (!objective || QUESTION_OR_OPTION_SIGNAL.test(objective)) {
        return null;
      }
      if (!isExecutableTaskLine(objective) || isStableFactLine(objective)) {
        return null;
      }
      return objective;
    }
    case "CONFIRMED FACTS":
      if (
        candidate.length < 4 ||
        isPurePathLine(candidate) ||
        !isStableFactLine(candidate)
      ) {
        return null;
      }
      return candidate;
    case "CONSTRAINTS":
      return CONSTRAINT_SECTION_SIGNAL.test(candidate) ? candidate : null;
    case "COMPLETED":
      return COMPLETED_SECTION_SIGNAL.test(candidate) ? candidate : null;
    case "REMAINING":
    case "NEXT BEST ACTIONS": {
      const action = stripLeadingPhrases(candidate, TASK_LEADIN_PREFIXES);
      if (
        !action ||
        QUESTION_OR_OPTION_SIGNAL.test(action) ||
        COMPLETED_SECTION_SIGNAL.test(action)
      ) {
        return null;
      }
      return isExecutableTaskLine(action) ? action : null;
    }
    case "KNOWN PATHS": {
      const [firstPath] = collectPathCandidates(candidate);
      return firstPath ? clipStateLine(firstPath) : null;
    }
    case "RECENT FAILURES":
      return isRealFailureLine(candidate) ? candidate : null;
  }
};

const createEmptySectionMap = (): Record<WorkingStateSectionName, string[]> =>
  Object.fromEntries(
    WORKING_STATE_SECTION_ORDER.map(section => [section, [] as string[]])
  ) as Record<WorkingStateSectionName, string[]>;

const normalizeUniqueLines = (
  section: WorkingStateSectionName,
  lines: string[] | undefined,
  limit: number
) => {
  if (!lines || lines.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of lines) {
    const candidate = normalizeSectionLine(section, line);
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

const finalizeSectionMap = (
  sections: WorkingStateSectionMap,
  pending = false
) => {
  const finalized = createEmptySectionMap();

  for (const section of WORKING_STATE_SECTION_ORDER) {
    const limit = pending
      ? PENDING_SECTION_ITEM_LIMIT
      : SECTION_ITEM_LIMITS[section];
    finalized[section] = normalizeUniqueLines(section, sections[section], limit);
  }

  const completedSet = normalizeForComparison(finalized.COMPLETED);
  if (completedSet.size > 0) {
    finalized.REMAINING = finalized.REMAINING.filter(
      line => !completedSet.has(normalizeLooseLine(line))
    );
    finalized["NEXT BEST ACTIONS"] = finalized["NEXT BEST ACTIONS"].filter(
      line => !completedSet.has(normalizeLooseLine(line))
    );
  }

  return finalized;
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
  const sectionMap = finalizeSectionMap(sections, pending);

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
  return finalizeSectionMap(parsed);
};

const normalizeSectionMapInput = (
  sectionMap: WorkingStateSectionMap | undefined,
  pending = false
) => finalizeSectionMap(sectionMap ?? createEmptySectionMap(), pending);

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

const collectFallbackDigestLines = (text: string) => {
  const lines: string[] = [];
  let inCodeFence = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    const normalized = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (
      !normalized ||
      normalized === "(none)" ||
      /^[-_=]{3,}$/.test(normalized)
    ) {
      continue;
    }

    lines.push(normalized);
    if (lines.length >= 12) {
      break;
    }
  }

  return lines;
};

export const buildFallbackPendingDigest = (params: {
  userText: string;
  assistantText: string;
}) => {
  const userText = normalizeLooseLine(params.userText);
  const assistantLines = collectFallbackDigestLines(params.assistantText);
  const sourceLines = [userText, ...assistantLines].filter(Boolean);

  if (sourceLines.length === 0) {
    return "";
  }

  const repaired = repairWorkingStateSummary(sourceLines.join("\n"), userText);
  return renderSectionMap(parseStructuredStateText(repaired), {
    pending: true,
  });
};

const buildSummaryPatchFromStructuredText = (text: string) => {
  const sectionMap = parseStructuredStateText(text);
  const patch: Partial<
    Record<WorkingStateSectionName, WorkingStatePatchOperation>
  > = {};

  for (const section of WORKING_STATE_SECTION_ORDER) {
    const lines = sectionMap[section];
    if (!lines.length) {
      continue;
    }

    patch[section] =
      section === "OBJECTIVE"
        ? {
            op: "replace",
            set: lines,
          }
        : {
            op: "merge",
            add: lines,
          };
  }

  return patch;
};

export const applyLocalFallbackStateUpdate = (params: {
  durableSummary: string;
  pendingDigest: string;
  userText: string;
  assistantText: string;
}) => {
  const normalizedSummary = params.durableSummary.trim()
    ? renderSectionMap(parseStructuredStateText(params.durableSummary), {
        preserveEmpty: true,
      })
    : "";
  const normalizedPendingDigest = params.pendingDigest.trim()
    ? renderSectionMap(parseStructuredStateText(params.pendingDigest), {
        pending: true,
      })
    : "";
  const fallbackPendingDigest = buildFallbackPendingDigest({
    userText: params.userText,
    assistantText: params.assistantText,
  });

  if (!normalizedPendingDigest) {
    return {
      summary: normalizedSummary,
      pendingDigest: fallbackPendingDigest,
      advancedSummary: false,
      capturedPendingDigest: Boolean(fallbackPendingDigest.trim()),
      updated: Boolean(fallbackPendingDigest.trim()),
    };
  }

  if (!fallbackPendingDigest.trim()) {
    return {
      summary: normalizedSummary,
      pendingDigest: normalizedPendingDigest,
      advancedSummary: false,
      capturedPendingDigest: false,
      updated: false,
    };
  }

  const applied = applyParsedStateUpdate({
    durableSummary: normalizedSummary,
    pendingDigest: "",
    update: {
      version: 1,
      mode: normalizedSummary.trim()
        ? "merge_and_digest"
        : "full_rebuild_and_digest",
      summaryPatch: buildSummaryPatchFromStructuredText(normalizedPendingDigest),
      nextPendingDigest: parseStructuredStateText(fallbackPendingDigest),
    },
  });

  return {
    summary: applied.summary,
    pendingDigest: applied.pendingDigest,
    advancedSummary: Boolean(applied.summary.trim()),
    capturedPendingDigest: Boolean(applied.pendingDigest.trim()),
    updated: applied.updated,
  };
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
    "Hard rules: never write planner chatter such as 我来 / 我先 / 让我 / 再看一下 / let me / I'll.",
    "Hard rules: never copy the user's raw request into CONFIRMED FACTS. CONFIRMED FACTS only stores stable, durable facts.",
    "Hard rules: OBJECTIVE must be one executable task sentence, not narration or a bare topic fragment.",
    "Hard rules: RECENT FAILURES only stores real failures, conflicts, or blockers. Explanations about error handling do not belong there.",
    "Hard rules: COMPLETED and REMAINING must stay mutually exclusive. Remove finished items from REMAINING and NEXT BEST ACTIONS.",
    "Hard rules: KNOWN PATHS only stores concrete repo paths.",
    "JSON shape:",
    `{"version":1,"mode":"${mode}","summaryPatch":{"OBJECTIVE":{"op":"keep|replace","set":["..."]},"CONFIRMED FACTS":{"op":"merge","add":["..."],"remove":["..."]}},"nextPendingDigest":{"OBJECTIVE":["..."]}}`,
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
        section,
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
      ...normalizeUniqueLines(section, patch.add, SECTION_ITEM_LIMITS[section]),
    ];
    baseSections[section] = normalizeUniqueLines(
      section,
      merged,
      SECTION_ITEM_LIMITS[section]
    );
  }

  const summary = renderSectionMap(baseSections, { preserveEmpty: true });
  return {
    summary,
    pendingDigest: nextPendingDigest,
    updated: true,
  };
};
