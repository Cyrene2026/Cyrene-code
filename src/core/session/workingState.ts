export const WORKING_STATE_SECTION_ORDER = [
  "OBJECTIVE",
  "CONFIRMED FACTS",
  "ASSUMPTIONS",
  "CONSTRAINTS",
  "DECISIONS",
  "ENTITY STATE",
  "COMPLETED",
  "REMAINING",
  "KNOWN PATHS",
  "RECENT FAILURES",
  "STALE OR CONFLICTING",
  "NEXT BEST ACTIONS",
] as const;

export type WorkingStateSectionName =
  (typeof WORKING_STATE_SECTION_ORDER)[number];

export type WorkingStateSectionMap = Partial<
  Record<WorkingStateSectionName, string[]>
>;

export type WorkingStateSourceRefKind =
  | "tool_result"
  | "error"
  | "approval"
  | "message"
  | "memory"
  | "plan"
  | "note";

export type WorkingStateSourceRef = {
  kind: WorkingStateSourceRefKind;
  label?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
};

export type WorkingStateEntry = {
  text: string;
  sourceRefs: WorkingStateSourceRef[];
};

const WORKING_STATE_REFS_PREFIX = "refs:";

const asWorkingStateHeading = (
  line: string
): WorkingStateSectionName | null => {
  const normalized = line.trim().replace(/：$/, ":").toUpperCase();
  for (const section of WORKING_STATE_SECTION_ORDER) {
    if (normalized === `${section}:`) {
      return section;
    }
  }
  return null;
};

const isWorkingStateHeadingLine = (line: string) =>
  asWorkingStateHeading(line) !== null;

const hasAnyWorkingStateHeadings = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (isWorkingStateHeadingLine(line)) {
      return true;
    }
  }
  return false;
};

const hasLeadingWorkingStateContent = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  for (const line of trimmed.split(/\r?\n/)) {
    if (isWorkingStateHeadingLine(line)) {
      return false;
    }
    if (line.trim()) {
      return true;
    }
  }

  return false;
};

const trimBlankEdges = (lines: string[]) => {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
};

const normalizeRefPath = (value: string) => value.trim().replace(/\\/g, "/");

const isValidSourceRef = (value: unknown): value is WorkingStateSourceRef => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || !candidate.kind.trim()) {
    return false;
  }
  if (candidate.label !== undefined && typeof candidate.label !== "string") {
    return false;
  }
  if (candidate.path !== undefined && typeof candidate.path !== "string") {
    return false;
  }
  if (
    candidate.startLine !== undefined &&
    (typeof candidate.startLine !== "number" || !Number.isFinite(candidate.startLine))
  ) {
    return false;
  }
  if (
    candidate.endLine !== undefined &&
    (typeof candidate.endLine !== "number" || !Number.isFinite(candidate.endLine))
  ) {
    return false;
  }
  return true;
};

const normalizeSourceRefs = (refs: WorkingStateSourceRef[]) => {
  const deduped = new Map<string, WorkingStateSourceRef>();
  for (const ref of refs) {
    const normalized: WorkingStateSourceRef = {
      kind: ref.kind,
      label: ref.label?.trim() ?? "",
      path: ref.path ? normalizeRefPath(ref.path) : undefined,
      startLine:
        typeof ref.startLine === "number" && Number.isFinite(ref.startLine)
          ? Math.max(1, Math.trunc(ref.startLine))
          : undefined,
      endLine:
        typeof ref.endLine === "number" && Number.isFinite(ref.endLine)
          ? Math.max(1, Math.trunc(ref.endLine))
          : undefined,
    };
    if (!normalized.kind.trim()) {
      continue;
    }
    const key = JSON.stringify(normalized);
    deduped.set(key, normalized);
  }
  return [...deduped.values()];
};

const parseSourceRefs = (raw: string): WorkingStateSourceRef[] => {
  const payload = raw.trim();
  if (!payload) {
    return [];
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeSourceRefs(parsed.filter(isValidSourceRef));
  } catch {
    return [];
  }
};

const formatSourceRefs = (refs: WorkingStateSourceRef[]) =>
  JSON.stringify(normalizeSourceRefs(refs));

export const parseWorkingStateEntry = (raw: string): WorkingStateEntry => {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      text: "",
      sourceRefs: [],
    };
  }

  const [head = "", ...rest] = lines;
  const text = head
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  const refs = rest.flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(WORKING_STATE_REFS_PREFIX)) {
      return [];
    }
    return parseSourceRefs(trimmed.slice(WORKING_STATE_REFS_PREFIX.length));
  });
  return {
    text,
    sourceRefs: normalizeSourceRefs(refs),
  };
};

export const renderWorkingStateEntry = (entry: WorkingStateEntry) => {
  const text = entry.text.trim();
  if (!text) {
    return "";
  }
  const refs = normalizeSourceRefs(entry.sourceRefs);
  if (refs.length === 0) {
    return text;
  }
  return [text, `  ${WORKING_STATE_REFS_PREFIX} ${formatSourceRefs(refs)}`].join("\n");
};

export const getWorkingStateEntryText = (raw: string) => parseWorkingStateEntry(raw).text;

export const getWorkingStateEntrySourceRefs = (raw: string) =>
  parseWorkingStateEntry(raw).sourceRefs;

export const attachWorkingStateSourceRefs = (
  raw: string,
  refs: WorkingStateSourceRef[]
) => {
  const parsed = parseWorkingStateEntry(raw);
  return renderWorkingStateEntry({
    text: parsed.text,
    sourceRefs: [...parsed.sourceRefs, ...refs],
  });
};

export const formatWorkingStateEntryForPrompt = (raw: string) => {
  const parsed = parseWorkingStateEntry(raw);
  if (!parsed.text) {
    return "";
  }
  if (parsed.sourceRefs.length === 0) {
    return parsed.text;
  }
  const refs = parsed.sourceRefs
    .map(ref => {
      const path =
        ref.path && typeof ref.startLine === "number"
          ? `${ref.path}#L${ref.startLine}${typeof ref.endLine === "number" ? `-L${ref.endLine}` : ""}`
          : ref.path ?? "";
      return [ref.kind, ref.label || "", path].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("; ");
  return refs ? `${parsed.text} [refs: ${refs}]` : parsed.text;
};

const renderSectionBody = (lines: string[]) => {
  const trimmed = trimBlankEdges(lines)
    .map(line => line.trimEnd())
    .join("\n")
    .trim();

  return trimmed || "(none)";
};

const REPAIRED_WORKING_STATE_SECTION_LIMITS: Record<WorkingStateSectionName, number> = {
  OBJECTIVE: 1,
  "CONFIRMED FACTS": 8,
  ASSUMPTIONS: 6,
  CONSTRAINTS: 6,
  DECISIONS: 6,
  "ENTITY STATE": 10,
  COMPLETED: 8,
  REMAINING: 6,
  "KNOWN PATHS": 8,
  "RECENT FAILURES": 6,
  "STALE OR CONFLICTING": 6,
  "NEXT BEST ACTIONS": 4,
};

const formatLegacyWorkingState = (text: string) => {
  const bullets = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      if (/^[-*]\s+/.test(line)) {
        return line.replace(/^\*\s+/, "- ");
      }
      return `- ${line}`;
    });

  return [
    "LEGACY SUMMARY (older format; treat this as partial state and refine completed/remaining items from newer evidence when needed):",
    bullets.join("\n") || "(none)",
  ].join("\n");
};

const clipSectionLine = (text: string, max = 320) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
};

const createWorkingStateSectionBuckets = () =>
  Object.fromEntries(
    WORKING_STATE_SECTION_ORDER.map(section => [section, [] as string[]])
  ) as Record<WorkingStateSectionName, string[]>;

const hasAnyWorkingStateSectionContent = (sections: WorkingStateSectionMap) =>
  WORKING_STATE_SECTION_ORDER.some(section => (sections[section]?.length ?? 0) > 0);

const renderBulletWorkingState = (sections: WorkingStateSectionMap) =>
  WORKING_STATE_SECTION_ORDER.map(section => {
    const lines = sections[section] ?? [];
    if (lines.length === 0) {
      return `${section}:\n- (none)`;
    }
    return `${section}:\n${lines
      .map(line => {
        const rendered = renderWorkingStateEntry(parseWorkingStateEntry(line));
        return rendered
          ? rendered
              .split("\n")
              .map((entryLine, index) => (index === 0 ? `- ${entryLine}` : entryLine))
              .join("\n")
          : "";
      })
      .filter(Boolean)
      .join("\n")}`;
  }).join("\n\n");

const normalizeLooseBullet = (line: string) =>
  getWorkingStateEntryText(line) ||
  line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();

const collectPathCandidates = (text: string) =>
  Array.from(
    new Set(
      (text.match(/[a-z0-9_.\\/:-]+\.[a-z0-9]+/gi) ?? []).map(candidate =>
        candidate.replace(/\\/g, "/")
      )
    )
  ).slice(0, 8);

const COMPLETED_SIGNAL =
  /\b(done|completed|finished|wrote|created|updated|implemented|fixed|approved|resolved)\b|完成|已写|已创建|已更新|已实现|已修复|已批准|已解决/iu;
const FAILURE_SIGNAL =
  /\b(fail|failed|error|denied|timeout|timed out|rejected|blocked)\b|失败|错误|拒绝|超时|阻塞/iu;
const CONSTRAINT_SIGNAL =
  /\b(must|should|cannot|can't|do not|don't|avoid|blocked|pending|requires|limit|constraint)\b|必须|不能|不要|避免|受限|限制|阻塞|待审批|需要/iu;
const DECISION_SIGNAL =
  /\b(decided|decision|chose|chosen|selected|accepted|rejected|agreed|prefer|use|using)\b|决定|选择|采用|接受|拒绝|约定|倾向/iu;
const STALE_OR_CONFLICT_SIGNAL =
  /\b(stale|outdated|superseded|contradicts?|conflicts?|invalidated|no longer true|changed)\b|过期|陈旧|冲突|矛盾|不再成立|已废弃|被覆盖|不再适用/iu;
const UNCERTAIN_FACT_SIGNAL =
  /\b(?:maybe|might|possibly|probably|likely|apparently|appears?|seems?|suspect|guess|inferred?|uncertain|unclear|unverified|tentative|pending confirmation|pending verification)\b|(?:可能|也许|大概|似乎|看起来|疑似|推测|猜测|未确认|尚未确认|待确认|待验证|未定位|尚未定位|还没定位|未查明|未闭合|未对齐|未解决)/iu;
const REMAINING_SIGNAL =
  /\b(remaining|todo|to do|follow-up|continue|still need|pending|left|next)\b|剩余|待做|继续|还需|未完成|后续|下一步/iu;
const OBJECTIVE_SIGNAL =
  /\b(task|goal|objective|implement|build|create|fix|finish|continue|resume|update)\b|任务|目标|实现|创建|修复|完成|继续|恢复|更新/iu;
const ACTION_SIGNAL =
  /\b(next|then|should|need to|try|resume|verify|run|update|edit|create|write)\b|下一步|接下来|应该|需要|继续|验证|运行|更新|编辑|创建|写/iu;

export const parseWorkingStateSummary = (text: string): WorkingStateSectionMap => {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  if (hasLeadingWorkingStateContent(trimmed)) {
    return {};
  }

  const sections = new Map<WorkingStateSectionName, string[]>();
  let currentSection: WorkingStateSectionName | null = null;
  let detectedSectionCount = 0;

  let currentEntryLines: string[] = [];
  const flushCurrentEntry = () => {
    if (!currentSection || currentEntryLines.length === 0) {
      currentEntryLines = [];
      return;
    }
    const rendered = renderWorkingStateEntry(parseWorkingStateEntry(currentEntryLines.join("\n")));
    if (rendered) {
      sections.get(currentSection)?.push(rendered);
    }
    currentEntryLines = [];
  };

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const heading = asWorkingStateHeading(rawLine);
    if (heading) {
      flushCurrentEntry();
      currentSection = heading;
      detectedSectionCount += 1;
      if (!sections.has(heading)) {
        sections.set(heading, []);
      }
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const trimmedLine = rawLine.trim();
    if (!trimmedLine) {
      flushCurrentEntry();
      continue;
    }
    if (
      currentEntryLines.length > 0 &&
      trimmedLine.toLowerCase().startsWith(WORKING_STATE_REFS_PREFIX)
    ) {
      currentEntryLines.push(`  ${trimmedLine}`);
      continue;
    }

    flushCurrentEntry();
    currentEntryLines = [rawLine];
  }

  flushCurrentEntry();

  if (detectedSectionCount === 0) {
    return {};
  }

  // Preserve all detected sections (including empty ones) so callers can distinguish
  // "no sections detected" from "sections detected but all empty"
  return Object.fromEntries(
    WORKING_STATE_SECTION_ORDER.map(section => [section, sections.get(section) ?? []])
  ) as WorkingStateSectionMap;
};

export const normalizeWorkingStateSummary = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(none)";
  }

  const parsed = parseWorkingStateSummary(trimmed);
  if (Object.keys(parsed).length === 0) {
    return formatLegacyWorkingState(trimmed);
  }

  return WORKING_STATE_SECTION_ORDER.map(section => {
    const lines = parsed[section] ?? [];
    if (lines.length === 0) {
      return `${section}:\n(none)`;
    }
    return `${section}:\n${lines
      .map(line => {
        const rendered = renderWorkingStateEntry(parseWorkingStateEntry(line));
        return rendered
          .split("\n")
          .map((entryLine, index) => (index === 0 ? `- ${entryLine}` : entryLine))
          .join("\n");
      })
      .join("\n")}`;
  }).join("\n\n");
};

export const hasCompleteWorkingStateSummary = (text: string) => {
  const parsed = parseWorkingStateSummary(text);
  return WORKING_STATE_SECTION_ORDER.every(
    section => (parsed[section]?.length ?? 0) > 0
  );
};

export const repairWorkingStateSummary = (
  text: string,
  fallbackText = ""
) => {
  const trimmed = text.trim();
  if (hasCompleteWorkingStateSummary(trimmed)) {
    return normalizeWorkingStateSummary(trimmed);
  }

  const parsed = parseWorkingStateSummary(trimmed);
  // Check if any sections have content (after the fix, all sections exist in parsed)
  const hasAnyContent = hasAnyWorkingStateSectionContent(parsed);
  if (hasAnyContent) {
    return normalizeWorkingStateSummary(trimmed);
  }

  const fallbackTrimmed = fallbackText.trim();
  const fallbackParsed = parseWorkingStateSummary(fallbackTrimmed);
  const sections = createWorkingStateSectionBuckets();
  const knownPaths = new Set<string>();

  const pushUnique = (section: WorkingStateSectionName, value: string) => {
    const normalized = clipSectionLine(value);
    if (!normalized) {
      return;
    }
    const bucket = sections[section];
    if (
      !bucket.includes(normalized) &&
      bucket.length < REPAIRED_WORKING_STATE_SECTION_LIMITS[section]
    ) {
      bucket.push(normalized);
    }
  };

  const mergeStructuredSections = (sectionMap: WorkingStateSectionMap) => {
    for (const section of WORKING_STATE_SECTION_ORDER) {
      for (const line of trimBlankEdges(sectionMap[section] ?? [])) {
        const normalized = normalizeLooseBullet(line);
        if (!normalized || normalized === "(none)") {
          continue;
        }
        pushUnique(section, normalized);
      }
    }
  };

  mergeStructuredSections(parsed);
  mergeStructuredSections(fallbackParsed);

  const sourceLines = [
    Object.keys(parsed).length === 0 ? trimmed : "",
    Object.keys(fallbackParsed).length === 0 ? fallbackTrimmed : "",
  ]
    .filter(Boolean)
    .flatMap(chunk => chunk.split(/\r?\n/))
    .filter(line => !isWorkingStateHeadingLine(line))
    .map(normalizeLooseBullet)
    .filter(line => line && line !== "(none)");

  if (sourceLines.length === 0) {
    if (
      hasAnyWorkingStateSectionContent(sections) ||
      hasAnyWorkingStateHeadings(trimmed) ||
      hasAnyWorkingStateHeadings(fallbackTrimmed)
    ) {
      return renderBulletWorkingState(sections);
    }
    return "(none)";
  }

  for (const line of sourceLines) {
    for (const path of collectPathCandidates(line)) {
      knownPaths.add(path);
    }

    if (FAILURE_SIGNAL.test(line)) {
      pushUnique("RECENT FAILURES", line);
      continue;
    }
    if (STALE_OR_CONFLICT_SIGNAL.test(line)) {
      pushUnique("STALE OR CONFLICTING", line);
      continue;
    }
    if (CONSTRAINT_SIGNAL.test(line)) {
      pushUnique("CONSTRAINTS", line);
      continue;
    }
    if (DECISION_SIGNAL.test(line)) {
      pushUnique("DECISIONS", line);
      continue;
    }
    if (UNCERTAIN_FACT_SIGNAL.test(line)) {
      pushUnique("ASSUMPTIONS", line);
      continue;
    }
    if (COMPLETED_SIGNAL.test(line)) {
      pushUnique("COMPLETED", line);
      continue;
    }
    if (sections.OBJECTIVE.length === 0 && OBJECTIVE_SIGNAL.test(line)) {
      pushUnique("OBJECTIVE", line);
      continue;
    }
    if (REMAINING_SIGNAL.test(line)) {
      pushUnique("REMAINING", line);
      continue;
    }
    if (ACTION_SIGNAL.test(line)) {
      pushUnique("NEXT BEST ACTIONS", line);
      continue;
    }
    pushUnique("CONFIRMED FACTS", line);
  }

  if (sections.OBJECTIVE.length === 0) {
    const fallbackObjective =
      sections.REMAINING[0] ??
      sections["NEXT BEST ACTIONS"][0] ??
      sections["CONFIRMED FACTS"][0] ??
      sourceLines[0];
    if (fallbackObjective) {
      pushUnique("OBJECTIVE", fallbackObjective);
    }
  }

  if (sections["NEXT BEST ACTIONS"].length === 0 && sections.REMAINING[0]) {
    pushUnique("NEXT BEST ACTIONS", sections.REMAINING[0]);
  }

  if (sections.REMAINING.length === 0 && sections["NEXT BEST ACTIONS"][0]) {
    pushUnique("REMAINING", sections["NEXT BEST ACTIONS"][0]);
  }

  for (const path of knownPaths) {
    pushUnique("KNOWN PATHS", path);
  }

  return renderBulletWorkingState(sections);
};
