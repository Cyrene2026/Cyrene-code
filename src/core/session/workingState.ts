export const WORKING_STATE_SECTION_ORDER = [
  "OBJECTIVE",
  "CONFIRMED FACTS",
  "CONSTRAINTS",
  "COMPLETED",
  "REMAINING",
  "KNOWN PATHS",
  "RECENT FAILURES",
  "NEXT BEST ACTIONS",
] as const;

export type WorkingStateSectionName =
  (typeof WORKING_STATE_SECTION_ORDER)[number];

export type WorkingStateSectionMap = Partial<
  Record<WorkingStateSectionName, string[]>
>;

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

const renderSectionBody = (lines: string[]) => {
  const trimmed = trimBlankEdges(lines)
    .map(line => line.trimEnd())
    .join("\n")
    .trim();

  return trimmed || "(none)";
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

const clipSectionLine = (text: string, max = 220) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
};

const normalizeLooseBullet = (line: string) =>
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

  const sections = new Map<WorkingStateSectionName, string[]>();
  let currentSection: WorkingStateSectionName | null = null;
  let detectedSectionCount = 0;

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const heading = asWorkingStateHeading(rawLine);
    if (heading) {
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

    sections.get(currentSection)?.push(rawLine);
  }

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
  // Only treat as LEGACY if no section headings were detected at all
  // (vs detected but all empty - which is a valid empty working state)
  if (!hasAnyWorkingStateHeadings(trimmed)) {
    return formatLegacyWorkingState(trimmed);
  }

  return WORKING_STATE_SECTION_ORDER.map(section => {
    const body = renderSectionBody(
      trimBlankEdges(parsed[section] ?? []).map(line => line.trimEnd())
    );
    return `${section}:\n${body}`;
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
  const hasAnyContent = WORKING_STATE_SECTION_ORDER.some(
    section => (parsed[section]?.length ?? 0) > 0
  );
  if (hasAnyContent) {
    return normalizeWorkingStateSummary(trimmed);
  }

  const sourceLines = [trimmed, fallbackText]
    .filter(Boolean)
    .flatMap(chunk => chunk.split(/\r?\n/))
    .filter(line => !isWorkingStateHeadingLine(line))  // Skip section headings
    .map(normalizeLooseBullet)
    .filter(line => line && line !== "(none)");

  if (sourceLines.length === 0) {
    // If trimmed had section headings but no content after filtering, return normalized empty sections
    // If trimmed was truly empty, return (none)
    if (hasAnyWorkingStateHeadings(trimmed)) {
      return WORKING_STATE_SECTION_ORDER.map(section => {
        return `${section}:\n- (none)`;
      }).join("\n\n");
    }
    return "(none)";
  }

  const sections = Object.fromEntries(
    WORKING_STATE_SECTION_ORDER.map(section => [section, [] as string[]])
  ) as Record<WorkingStateSectionName, string[]>;
  const knownPaths = new Set<string>();

  const pushUnique = (section: WorkingStateSectionName, value: string) => {
    const normalized = clipSectionLine(value);
    if (!normalized) {
      return;
    }
    const bucket = sections[section];
    if (!bucket.includes(normalized) && bucket.length < 5) {
      bucket.push(normalized);
    }
  };

  for (const line of sourceLines) {
    for (const path of collectPathCandidates(line)) {
      knownPaths.add(path);
    }

    if (FAILURE_SIGNAL.test(line)) {
      pushUnique("RECENT FAILURES", line);
      continue;
    }
    if (CONSTRAINT_SIGNAL.test(line)) {
      pushUnique("CONSTRAINTS", line);
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

  return WORKING_STATE_SECTION_ORDER.map(section => {
    const lines = sections[section];
    if (lines.length === 0) {
      return `${section}:\n- (none)`;
    }
    return `${section}:\n${lines.map(line => `- ${line}`).join("\n")}`;
  }).join("\n\n");
};
