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

const SECTION_PRIORITY: Record<WorkingStateSectionName, number> = {
  OBJECTIVE: 0,
  "NEXT BEST ACTIONS": 1,
  REMAINING: 2,
  "CONFIRMED FACTS": 3,
  "KNOWN PATHS": 4,
  COMPLETED: 5,
  CONSTRAINTS: 6,
  "RECENT FAILURES": 7,
};

type NormalizedCandidate = {
  section: WorkingStateSectionName;
  line: string;
};

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
  "我就能",
  "先让我",
  "先看一下",
  "再看一下",
  "继续看",
  "再往下看",
  "继续抓",
  "继续顺着",
  "顺着",
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
  "先",
  "再",
] as const;

const EXECUTABLE_TASK_SIGNAL =
  /\b(?:analyze|check|debug|diagnose|fix|optimize|implement|build|create|write|edit|update|inspect|read|review|summarize|explain|verify|run|test|resume|continue|finish|refactor|split|trace|investigate|clarify|confirm|locate|trace|add|patch|wire|connect|integrate)\b|(?:看一下|看下|看看|查看|读取|阅读|读一下|分析|检查|排查|修复|优化|实现|构建|创建|写入?|编辑|更新|审查|总结|解释|验证|运行|测试|恢复|继续|完成|重构|拆分|追踪|调查|澄清|确认|定位|走查|梳理|补齐|补上|补充|补一个|接上|接通|联调)/iu;

const STABLE_FACT_SIGNAL =
  /\b(?:is|are|was|were|has|have|uses?|supports?|contains?|includes?|returns?|exposes?|depends?|configured|stored|persisted|confirmed|verified|located|path|endpoint|route|version|setting|config|file|directory|workspace|session|state)\b|(?:是|位于|包含|使用|支持|返回|暴露|依赖|配置|已配置|已确认|已验证|路径|接口|路由|版本|文件|目录|工作区|会话|状态)/iu;

const STRICT_FACT_PREDICATE_SIGNAL =
  /\b(?:is|are|was|were|has|have|uses?|supports?|contains?|includes?|returns?|exposes?|depends?|configured|stored|persisted|confirmed|verified|located|does not exist|doesn't exist|not present|absent|missing from)\b|(?:是|位于|包含|使用|支持|返回|暴露|依赖|配置|已配置|已确认|已验证|不存在|未找到|项目中没有|仓库中没有)/iu;

const COMPLETED_SECTION_SIGNAL =
  /\b(?:done|completed|finished|wrote|created|updated|implemented|fixed|approved|resolved|answered|added|removed|renamed|stored|persisted|recorded|marked|recovered|handled|captured|merged|rebuilt|synced)\b|(?:完成|已写|已创建|已更新|已实现|已修复|已批准|已解决|已回答|已添加|已删除|已重命名|已存储|已记录|已标记|已恢复|已处理|已合并|已重建|已同步|已确认|已[^，,。；;\s]{0,6}(?:实现|完成|创建|更新|确认|修复)|(?:创建|完成|实现|配置|确认|更新|修复|回答|编写)了|标记为)/iu;

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

const META_NARRATION_PREFIX =
  /^(?:已确认结果|搜索模式|当前状态|结论|说明|也就是|所以|因此|我就能|如果你愿意|下一步可以|继续看|再往下看|继续抓|继续顺着|顺着)/iu;

const LOW_SIGNAL_TASK_LINE =
  /^(?:查看|继续|梳理|分析|检查|确认|定位|阅读|走查)(?:主线|细节|结构|逻辑|代码|内容|部分|附近|后面|前面|更多内容|关键调用点)?$|^(?:做|继续做|进行)(?:详细)?(?:分析|梳理|检查)$/u;

const ACTION_META_PREFIX =
  /^(?:这里|下面|当前|本轮|这说明|这意味着|也就是|所以|因此|已确认结果|搜索模式)/iu;

const FACT_META_PREFIX =
  /^(?:已确认结果|搜索模式|当前状态|结论|说明|真正的首入口)/iu;

const CONDITIONAL_PREFIX = /^(?:当|如果|若|when\b|if\b)/iu;
const CONDITIONAL_OUTCOME_SIGNAL =
  /\b(?:then|will|would|returns?|uses?|loads?|stores?|reads?|writes?|ensures?|maps?|injects?|falls back|points to)\b|(?:会|将|则|负责|用于|用来|读取|写入|注入|映射|加载|返回|确保|指向|生效)/iu;
const INCOMPLETE_CLAUSE_END =
  /(?:[：:，,、]|→|->|且|并且|而是|以及|and|or)$/iu;
const CONSTRAINT_MODAL_SIGNAL =
  /\b(?:must|should|cannot|can't|do not|don't|avoid|pending approval|requires|limit|constraint|read-only|blocked|must not|no code changes)\b|(?:必须|不能|不要|避免|待审批|需要|限制|约束|只读|阻塞|不改|不准)/iu;

const HARD_CONSTRAINT_SIGNAL =
  /\b(?:must|cannot|can't|do not|don't|avoid|requires?|must not|read-only|blocked|pending approval)\b|(?:必须|不能|不要|避免|待审批|只读|阻塞|不改|不准|需要先)/iu;

const FILLER_ONLY_SIGNAL =
  /^(?:写吧|好(?:了)?|好[,，]\s*继续|继续吧|继续一下|我就马上开写|我马上开写|马上开写)$/iu;

const SUGGESTION_PREFIX =
  /^(?:如果你愿意|你要我|下一步可以|可继续执行|可以继续执行|你回复一个数字|回复一个数字|我就继续写进去)/iu;

const REVIEW_REQUEST_PREFIX =
  /^(?:看下|看看|查看|检查|确认|分析|梳理|阅读|读一下|排查|走查|定位)/iu;

const IMPERATIVE_CONSTRAINT_PREFIX =
  /^(?:支持|需要先|需要|需|必须|不能|不要|避免|先激活|requires?|must|should|support)/iu;

const TOKEN_OR_SETUP_CONSTRAINT_SIGNAL =
  /(?:token\s*[:=]|需要先激活|先激活|conda|skip\s*\/\s*limit|skip\b.*limit\b|limit\b.*skip\b)/iu;

const PATH_LABEL_ONLY_SIGNAL = /^(?:路径|path)\s+/iu;

const ENDPOINT_LABEL_SIGNAL =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s：:]+)\s*[：:]\s*(.+)$/iu;

const ENTRYPOINT_LABEL_SIGNAL =
  /^(?:(?:启动)?入口(?:文件)?|主入口)\s*[：:]\s*([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)$/u;

const PATH_ABSENCE_FACT_SIGNAL =
  /^`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`?\s*(?:[：:]\s*)?(?:不存在|未找到|does not exist|doesn't exist|is missing|missing|not found|is not present)$/iu;

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

const trimTrailingPunctuation = (value: string) =>
  value.replace(/[\s,，;；。.!！?？]+$/u, "").trim();

const canonicalizeCandidate = (line: string) => {
  const rawCandidate = normalizeLooseLine(line);
  if (!rawCandidate || rawCandidate === "(none)") {
    return "";
  }

  return trimTrailingPunctuation(sanitizeCandidatePrefix(rawCandidate));
};

const splitIntoClauses = (value: string) =>
  value
    .split(/[，,；;。！？!?]\s*/u)
    .map(part => part.trim())
    .filter(Boolean);

const takePrimaryClause = (value: string) =>
  value
    .split(/[。！？!?；;]\s*/u)
    .map(part => part.trim())
    .find(Boolean) ?? "";

const normalizeTaskClause = (value: string) => {
  const clause = takePrimaryClause(value).replace(/[：:]+$/u, "").trim();
  if (!clause) {
    return "";
  }

  if (/^看(?:(?=\s)|(?=`)|(?=[A-Za-z0-9_\u4e00-\u9fff]))/u.test(clause)) {
    return clause.replace(/^看/u, "查看");
  }

  return clause;
};

const pickExecutableClause = (value: string) => {
  const clauses = splitIntoClauses(value);
  for (const clause of clauses) {
    const normalized = normalizeTaskClause(clause);
    if (!normalized || ACTION_META_PREFIX.test(normalized)) {
      continue;
    }
    if (isExecutableTaskLine(normalized)) {
      return normalized;
    }
  }
  return normalizeTaskClause(value);
};

const isBareSymbolLikeLine = (line: string) => {
  const withoutTicks = line.replace(/`/g, "").trim();
  if (!withoutTicks) {
    return false;
  }
  if (/\s/.test(withoutTicks)) {
    return false;
  }
  return /^[A-Za-z_$][\w$.-]*(?:\(\))?$/.test(withoutTicks);
};

const isIncompleteConditionalLine = (line: string) =>
  CONDITIONAL_PREFIX.test(line) && !CONDITIONAL_OUTCOME_SIGNAL.test(line);

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

const isAnchoredTaskLine = (line: string) =>
  collectPathCandidates(line).length > 0 || /`[^`]+`/.test(line) || line.length >= 6;

const isDiscardableChatter = (line: string) =>
  !line ||
  line === "(none)" ||
  FILLER_ONLY_SIGNAL.test(line) ||
  SUGGESTION_PREFIX.test(line) ||
  META_NARRATION_PREFIX.test(line);

const isCompletedCandidate = (line: string) =>
  COMPLETED_SECTION_SIGNAL.test(line) &&
  !REVIEW_REQUEST_PREFIX.test(line) &&
  !QUESTION_OR_OPTION_SIGNAL.test(line) &&
  !/^(?:已完成(?:的部分)?|完成情况|已完成事项?)$/iu.test(line) &&
  !SUGGESTION_PREFIX.test(line);

const isConstraintCandidate = (line: string) =>
  !QUESTION_OR_OPTION_SIGNAL.test(line) &&
  !SUGGESTION_PREFIX.test(line) &&
  !isCompletedCandidate(line) &&
  !REVIEW_REQUEST_PREFIX.test(line) &&
  (HARD_CONSTRAINT_SIGNAL.test(line) ||
    IMPERATIVE_CONSTRAINT_PREFIX.test(line) ||
    TOKEN_OR_SETUP_CONSTRAINT_SIGNAL.test(line) ||
    (CONSTRAINT_MODAL_SIGNAL.test(line) && !isExecutableTaskLine(line)));

const isSafeFactFragment = (line: string) => {
  const pathAbsenceMatch = line.match(PATH_ABSENCE_FACT_SIGNAL);
  if (pathAbsenceMatch?.[1]) {
    return `项目中不存在 \`${pathAbsenceMatch[1]}\``;
  }

  const endpointMatch = line.match(ENDPOINT_LABEL_SIGNAL);
  if (endpointMatch) {
    const [, method, route, description] = endpointMatch;
    const detail = trimTrailingPunctuation(description ?? "");
    if (
      method &&
      route &&
      detail &&
      !QUESTION_OR_OPTION_SIGNAL.test(detail) &&
      !isCompletedCandidate(detail) &&
      !isConstraintCandidate(detail) &&
      !isExecutableTaskLine(detail)
    ) {
      return `\`${method.toUpperCase()} ${route}\` 是${detail}`;
    }
  }

  const entrypointMatch = line.match(ENTRYPOINT_LABEL_SIGNAL);
  if (entrypointMatch) {
    const [, path] = entrypointMatch;
    if (path?.trim()) {
      return `入口文件是 \`${path.trim()}\``;
    }
  }

  return "";
};

const normalizeConstraintClause = (line: string) => {
  const clause =
    splitIntoClauses(line).find(part => {
      const trimmed = part.trim();
      return (
        !REVIEW_REQUEST_PREFIX.test(trimmed) &&
        (CONSTRAINT_MODAL_SIGNAL.test(trimmed) ||
          IMPERATIVE_CONSTRAINT_PREFIX.test(trimmed) ||
          TOKEN_OR_SETUP_CONSTRAINT_SIGNAL.test(trimmed))
      );
    }) ?? line;

  return trimTrailingPunctuation(clause);
};

const normalizeCompletedClause = (line: string) =>
  trimTrailingPunctuation(takePrimaryClause(line))
    .replace(/^创建了/u, "已创建")
    .replace(/^完成了/u, "已完成")
    .replace(/^实现了/u, "已实现")
    .replace(/^配置了/u, "已配置")
    .replace(/^确认了/u, "已确认")
    .replace(/^更新了/u, "已更新")
    .replace(/^修复了/u, "已修复")
    .replace(/^回答了/u, "已回答")
    .replace(/^编写了/u, "已编写");

const normalizeCandidateForSection = (
  targetSection: WorkingStateSectionName,
  line: string
): NormalizedCandidate | null => {
  const candidate = canonicalizeCandidate(line);
  if (
    isDiscardableChatter(candidate) ||
    /[：:]$/.test(candidate) ||
    isIncompleteConditionalLine(candidate) ||
    INCOMPLETE_CLAUSE_END.test(candidate)
  ) {
    return null;
  }

  if (isPurePathLine(candidate)) {
    const [firstPath] = collectPathCandidates(candidate);
    return firstPath ? { section: "KNOWN PATHS", line: clipStateLine(firstPath) } : null;
  }

  if (isRealFailureLine(candidate)) {
    return { section: "RECENT FAILURES", line: candidate };
  }

  if (isConstraintCandidate(candidate)) {
    const normalized = normalizeConstraintClause(candidate);
    return normalized
      ? { section: "CONSTRAINTS", line: normalized }
      : null;
  }

  if (isCompletedCandidate(candidate)) {
    const normalized = normalizeCompletedClause(candidate);
    return normalized
      ? { section: "COMPLETED", line: normalized }
      : null;
  }

  if (targetSection === "KNOWN PATHS") {
    const [firstPath] = collectPathCandidates(candidate);
    return firstPath ? { section: "KNOWN PATHS", line: clipStateLine(firstPath) } : null;
  }

  if (targetSection === "OBJECTIVE") {
    const objective = pickExecutableClause(
      stripLeadingPhrases(candidate, TASK_LEADIN_PREFIXES)
    );
    if (
      !objective ||
      QUESTION_OR_OPTION_SIGNAL.test(objective) ||
      /(?:如下|如下所示|如下内容)$/u.test(objective) ||
      ACTION_META_PREFIX.test(objective) ||
      isExecutableTaskLine(objective) === false ||
      isStableFactLine(objective) ||
      LOW_SIGNAL_TASK_LINE.test(objective) ||
      !isAnchoredTaskLine(objective)
    ) {
      return null;
    }
    return { section: "OBJECTIVE", line: objective };
  }

  if (targetSection === "CONFIRMED FACTS") {
    const salvagedFact = isSafeFactFragment(candidate);
    if (salvagedFact) {
      return { section: "CONFIRMED FACTS", line: salvagedFact };
    }
    if (
      candidate.length < 4 ||
      FACT_META_PREFIX.test(candidate) ||
      PATH_LABEL_ONLY_SIGNAL.test(candidate) ||
      isBareSymbolLikeLine(candidate) ||
      isPurePathLine(candidate) ||
      !isStableFactLine(candidate) ||
      !STRICT_FACT_PREDICATE_SIGNAL.test(candidate)
    ) {
      return null;
    }
    return { section: "CONFIRMED FACTS", line: candidate };
  }

  if (targetSection === "CONSTRAINTS") {
    return null;
  }

  if (targetSection === "COMPLETED") {
    return null;
  }

  if (targetSection === "RECENT FAILURES") {
    return null;
  }

  const action = pickExecutableClause(
    stripLeadingPhrases(candidate, TASK_LEADIN_PREFIXES)
  );
  if (
    !action ||
    QUESTION_OR_OPTION_SIGNAL.test(action) ||
    ACTION_META_PREFIX.test(action) ||
    !isExecutableTaskLine(action) ||
    LOW_SIGNAL_TASK_LINE.test(action) ||
    !isAnchoredTaskLine(action)
  ) {
    return null;
  }

  return { section: targetSection, line: action };
};

const normalizeSectionLine = (
  section: WorkingStateSectionName,
  line: string
) => {
  const normalized = normalizeCandidateForSection(section, line);
  return normalized?.section === section ? normalized.line : null;
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
    const candidate = normalizeCandidateForSection(section, line);
    if (!candidate || candidate.section !== section || seen.has(candidate.line)) {
      continue;
    }
    seen.add(candidate.line);
    normalized.push(candidate.line);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
};

const finalizeSectionMap = (
  sections: WorkingStateSectionMap,
  pending = false,
  allowedPaths?: ReadonlySet<string>
) => {
  const finalized = createEmptySectionMap();
  const chosenByKey = new Map<
    string,
    NormalizedCandidate & {
      order: number;
    }
  >();
  let nextOrder = 0;

  for (const section of WORKING_STATE_SECTION_ORDER) {
    for (const rawLine of sections[section] ?? []) {
      const normalized = normalizeCandidateForSection(section, rawLine);
      if (!normalized) {
        continue;
      }
      const key = normalizeLooseLine(normalized.line);
      if (!key) {
        continue;
      }
      const previous = chosenByKey.get(key);
      if (!previous) {
        chosenByKey.set(key, {
          ...normalized,
          order: nextOrder,
        });
        nextOrder += 1;
        continue;
      }
      if (SECTION_PRIORITY[normalized.section] > SECTION_PRIORITY[previous.section]) {
        chosenByKey.set(key, {
          ...normalized,
          order: previous.order,
        });
      }
    }
  }

  for (const candidate of [...chosenByKey.values()].sort((a, b) => a.order - b.order)) {
    const limit = pending
      ? PENDING_SECTION_ITEM_LIMIT
      : SECTION_ITEM_LIMITS[candidate.section];
    if (finalized[candidate.section].length >= limit) {
      continue;
    }
    finalized[candidate.section].push(candidate.line);
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

  if (allowedPaths && allowedPaths.size > 0) {
    finalized["KNOWN PATHS"] = finalized["KNOWN PATHS"].filter(path =>
      allowedPaths.has(path)
    );
  }

  if (finalized.OBJECTIVE.length > 1) {
    finalized.OBJECTIVE = finalized.OBJECTIVE.slice(0, 1);
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
  const directlyParsed = parseWorkingStateSummary(trimmed);
  if (Object.keys(directlyParsed).length > 0) {
    return finalizeSectionMap(directlyParsed);
  }
  const repaired = repairWorkingStateSummary(trimmed);
  const parsed = parseWorkingStateSummary(repaired);
  return finalizeSectionMap(parsed);
};

const normalizeSectionMapInput = (
  sectionMap: WorkingStateSectionMap | undefined,
  pending = false
) => finalizeSectionMap(sectionMap ?? createEmptySectionMap(), pending);

const normalizeAllowedPaths = (paths?: Iterable<string>) => {
  const normalized = new Set<string>();
  if (!paths) {
    return normalized;
  }

  for (const path of paths) {
    const candidate = path.replace(/\\/g, "/").trim();
    if (candidate) {
      normalized.add(candidate);
    }
  }

  return normalized;
};

export const sanitizeStoredWorkingState = (params: {
  summary: string;
  pendingDigest: string;
  allowedPaths?: Iterable<string>;
}) => {
  const allowedPaths = normalizeAllowedPaths(params.allowedPaths);
  const summarySections = params.summary.trim()
    ? finalizeSectionMap(parseStructuredStateText(params.summary), false, allowedPaths)
    : createEmptySectionMap();
  const pendingSections = params.pendingDigest.trim()
    ? finalizeSectionMap(parseStructuredStateText(params.pendingDigest), true, allowedPaths)
    : createEmptySectionMap();

  return {
    summary: hasMeaningfulSectionContent(summarySections)
      ? renderSectionMap(summarySections, { preserveEmpty: true })
      : "",
    pendingDigest: hasMeaningfulSectionContent(pendingSections)
      ? renderSectionMap(pendingSections, { pending: true })
      : "",
  };
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

const findLastProtocolStateTagIndex = (text: string) => {
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const candidate = text.lastIndexOf(CYRENE_STATE_UPDATE_START_TAG, searchFrom - 1);
    if (candidate < 0) {
      return -1;
    }
    if (!isInsideMarkdownCodeContext(text, candidate)) {
      return candidate;
    }
    searchFrom = candidate;
  }
  return -1;
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

const buildFallbackSectionMap = (params: {
  userText: string;
  assistantLines: string[];
}) => {
  const sections = createEmptySectionMap();
  const objective = normalizeCandidateForSection("OBJECTIVE", params.userText);
  if (objective?.section === "OBJECTIVE") {
    sections.OBJECTIVE.push(objective.line);
  }

  for (const rawLine of params.assistantLines) {
    const candidate = canonicalizeCandidate(rawLine);
    if (!candidate || isDiscardableChatter(candidate)) {
      continue;
    }

    for (const path of collectPathCandidates(candidate)) {
      sections["KNOWN PATHS"].push(path);
    }

    const failure = normalizeCandidateForSection("RECENT FAILURES", candidate);
    if (failure?.section === "RECENT FAILURES") {
      sections["RECENT FAILURES"].push(failure.line);
      continue;
    }

    const constraint = normalizeCandidateForSection("CONSTRAINTS", candidate);
    if (constraint?.section === "CONSTRAINTS") {
      sections.CONSTRAINTS.push(constraint.line);
      continue;
    }

    const completed = normalizeCandidateForSection("COMPLETED", candidate);
    if (completed?.section === "COMPLETED") {
      sections.COMPLETED.push(completed.line);
      continue;
    }

    const fact = normalizeCandidateForSection("CONFIRMED FACTS", candidate);
    if (fact?.section === "CONFIRMED FACTS") {
      sections["CONFIRMED FACTS"].push(fact.line);
      continue;
    }

    const nextAction = normalizeCandidateForSection("NEXT BEST ACTIONS", candidate);
    if (nextAction?.section === "NEXT BEST ACTIONS") {
      sections["NEXT BEST ACTIONS"].push(nextAction.line);
    }
  }

  return sections;
};

export const buildFallbackPendingDigest = (params: {
  userText: string;
  assistantText: string;
}) => {
  const userText = normalizeLooseLine(params.userText);
  const assistantLines = collectFallbackDigestLines(params.assistantText);
  if (!userText && assistantLines.length === 0) {
    return "";
  }

  const fallbackSections = buildFallbackSectionMap({
    userText,
    assistantLines,
  });
  return renderSectionMap(fallbackSections, {
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
    "Hard rules: CONFIRMED FACTS must be complete factual statements. Do not emit bare identifiers, headings, search metadata, or incomplete conditional fragments.",
    "Hard rules: CONFIRMED FACTS may include confirmed negative facts such as missing files, absent entrypoints, or disproven default project structure guesses when they reduce future hallucinated paths.",
    "Hard rules: OBJECTIVE must be one executable task sentence, not narration or a bare topic fragment.",
    "Hard rules: CONSTRAINTS stores only actual requirements/prohibitions. Drop explanatory preambles and keep the concrete rule clause.",
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
  const startIndex = findLastProtocolStateTagIndex(rawAssistantText);
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
