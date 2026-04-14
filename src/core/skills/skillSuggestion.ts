import {
  normalizeWorkingStateSummary,
  parseWorkingStateSummary,
  type WorkingStateSectionMap,
} from "../session/workingState";

export type SkillPatternSuggestion = {
  fingerprint: string;
  phrase: string;
  sampleLines: string[];
};

const SUMMARY_SECTIONS_FOR_TASK = [
  "OBJECTIVE",
  "CONFIRMED FACTS",
  "REMAINING",
  "NEXT BEST ACTIONS",
] as const;

const SUMMARY_SECTIONS_FOR_PATTERN = [
  "OBJECTIVE",
  "COMPLETED",
  "REMAINING",
  "NEXT BEST ACTIONS",
  "CONFIRMED FACTS",
] as const;

const ENGLISH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "onto",
  "then",
  "than",
  "will",
  "would",
  "should",
  "could",
  "need",
  "needs",
  "next",
  "todo",
  "done",
  "still",
  "have",
  "has",
  "had",
  "been",
  "being",
  "after",
  "before",
  "your",
  "their",
  "there",
  "here",
  "about",
  "across",
  "under",
  "over",
  "only",
  "more",
  "less",
  "must",
  "cannot",
  "cant",
  "dont",
  "avoid",
  "keep",
  "make",
  "made",
  "using",
  "used",
  "user",
  "assistant",
  "session",
  "summary",
  "current",
  "recent",
  "confirm",
  "confirmed",
  "verify",
  "verified",
  "continue",
  "continuing",
  "update",
  "updated",
  "work",
  "working",
  "task",
  "goal",
  "objective",
]);

const CJK_STOPWORDS = new Set([
  "当前",
  "继续",
  "需要",
  "已经",
  "相关",
  "处理",
  "工作",
  "任务",
  "目标",
  "问题",
  "这个",
  "那个",
  "一些",
  "继续处理",
  "下一步",
  "确认",
  "更新",
  "完成",
]);

const SKILL_RELATED_SIGNAL =
  /\bskill\b|skills\.ya?ml|cyrene_skill|\/skills?\s+create|生成.?skill|创建.?skill|技能/iu;

const stripBullet = (line: string) =>
  line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();

const hasMeaningfulSummary = (summary: string) =>
  summary.trim().length >= 24 && summary.trim() !== "(none)";

const collectSectionLines = (
  parsed: WorkingStateSectionMap,
  sections: readonly (keyof WorkingStateSectionMap)[]
) =>
  sections.flatMap(section =>
    (parsed[section] ?? []).map(stripBullet).filter(Boolean)
  );

const tokenizeLine = (line: string) =>
  Array.from(
    new Set(
      (line.toLowerCase().match(/[a-z0-9._/-]{3,}|[\u4e00-\u9fff]{2,}/gu) ?? []).filter(
        token => {
          if (/^[a-z]/.test(token)) {
            return !ENGLISH_STOPWORDS.has(token);
          }
          return !CJK_STOPWORDS.has(token);
        }
      )
    )
  );

const phraseScore = (phrase: string, lineCount: number) =>
  lineCount * 10 + Math.min(phrase.length, 24);

const rankRecurringPhrases = (lines: string[]) => {
  const phraseLines = new Map<string, Set<number>>();

  lines.forEach((line, index) => {
    const tokens = tokenizeLine(line);
    for (const token of tokens) {
      if (!phraseLines.has(token)) {
        phraseLines.set(token, new Set());
      }
      phraseLines.get(token)?.add(index);
    }
    for (let tokenIndex = 0; tokenIndex < tokens.length - 1; tokenIndex += 1) {
      const phrase = `${tokens[tokenIndex]} ${tokens[tokenIndex + 1]}`;
      if (!phraseLines.has(phrase)) {
        phraseLines.set(phrase, new Set());
      }
      phraseLines.get(phrase)?.add(index);
    }
  });

  return [...phraseLines.entries()]
    .map(([phrase, indexes]) => ({
      phrase,
      lineCount: indexes.size,
      indexes: [...indexes.values()].sort((left, right) => left - right),
    }))
    .filter(item => item.lineCount >= (item.phrase.includes(" ") ? 2 : 3))
    .sort((left, right) => {
      const scoreDelta =
        phraseScore(right.phrase, right.lineCount) -
        phraseScore(left.phrase, left.lineCount);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.phrase.localeCompare(right.phrase);
    });
};

export const buildSkillCreationTaskFromSummary = (summary: string) => {
  if (!hasMeaningfulSummary(summary)) {
    return "";
  }

  const normalized = normalizeWorkingStateSummary(summary);
  const parsed = parseWorkingStateSummary(summary);
  if (Object.keys(parsed).length === 0) {
    return normalized;
  }

  const focusedSections = SUMMARY_SECTIONS_FOR_TASK.flatMap(section => {
    const lines = (parsed[section] ?? []).map(stripBullet).filter(Boolean);
    if (lines.length === 0) {
      return [];
    }
    return [`${section}:`, ...lines.map(line => `- ${line}`)];
  });

  return focusedSections.length > 0
    ? focusedSections.join("\n")
    : normalized;
};

export const chooseSkillCreationTask = (summary: string, latestUserTask: string) => {
  const fromSummary = buildSkillCreationTaskFromSummary(summary);
  return fromSummary || latestUserTask.trim();
};

export const detectStableSkillPattern = (
  summary: string
): SkillPatternSuggestion | null => {
  if (!hasMeaningfulSummary(summary) || SKILL_RELATED_SIGNAL.test(summary)) {
    return null;
  }

  const parsed = parseWorkingStateSummary(summary);
  const lines =
    Object.keys(parsed).length > 0
      ? collectSectionLines(parsed, SUMMARY_SECTIONS_FOR_PATTERN).slice(0, 10)
      : summary
          .split(/\r?\n/)
          .map(stripBullet)
          .filter(Boolean)
          .slice(0, 10);

  if (lines.length < 3) {
    return null;
  }

  const ranked = rankRecurringPhrases(lines);
  const top = ranked[0];
  if (!top) {
    return null;
  }

  const sampleLines = top.indexes
    .map(index => lines[index] ?? "")
    .filter(Boolean)
    .slice(0, 3);

  if (sampleLines.length < 2) {
    return null;
  }

  return {
    fingerprint: `${top.phrase}:${sampleLines.join("|")}`.toLowerCase(),
    phrase: top.phrase,
    sampleLines,
  };
};
