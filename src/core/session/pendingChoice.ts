import type { SessionPendingChoice } from "./types";

const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const NUMBERED_CHOICE_LINE_PATTERN = /^\s*(\d{1,2})[.)、]\s+(.+?)\s*$/;
const CONTINUATION_LINE_PATTERN = /^\s{2,}\S/;
const MENU_CUE_PATTERN =
  /(?:回复(?:我)?(?:一个)?(?:数字|编号)|回(?:复)?(?:一个)?(?:数字|编号)|按(?:数字|编号|序号)|选(?:一个|1个|项|一个编号)|选择(?:一个|编号|序号|选项)|告诉我你要哪(?:个|一项)|reply with (?:a )?(?:number|digit)|respond with (?:a )?(?:number|digit)|choose (?:one|an option)|pick (?:one|an option)|select (?:one|an option)|which one)/iu;

const CHINESE_DIGIT_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const normalizeChoiceLabel = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/^[—–-]\s*/, "")
    .trim();

const clipPreview = (value: string, maxLength = 120) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const stripCodeBlocks = (text: string) => text.replace(FENCED_CODE_BLOCK_PATTERN, "");

const parseChineseChoiceIndex = (token: string) => {
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "十") {
    return 10;
  }
  if (normalized.length === 1) {
    return CHINESE_DIGIT_MAP[normalized] ?? null;
  }
  return null;
};

export const parsePendingChoiceReferenceIndex = (input: string): number | null => {
  const normalized = input.trim();
  if (!normalized) {
    return null;
  }
  const compact = normalized.replace(/\s+/g, "");

  const digitMatch = compact.match(/^(?:选(?:项)?|继续|上面(?:的)?|前面(?:的)?|刚才(?:的)?)?([1-9]\d?)$/u);
  if (digitMatch?.[1]) {
    return Number(digitMatch[1]);
  }

  const ordinalDigitMatch = compact.match(
    /^(?:(?:继续|选(?:项)?|上面(?:的)?|前面(?:的)?|刚才(?:的)?)?)第?([1-9]\d?)(?:个|项|条|点)?$/u
  );
  if (ordinalDigitMatch?.[1]) {
    return Number(ordinalDigitMatch[1]);
  }

  const ordinalChineseMatch = compact.match(
    /^(?:(?:继续|选(?:项)?|上面(?:的)?|前面(?:的)?|刚才(?:的)?)?)第?([一二两三四五六七八九十])(?:个|项|条|点)?$/u
  );
  if (ordinalChineseMatch?.[1]) {
    return parseChineseChoiceIndex(ordinalChineseMatch[1]);
  }

  return null;
};

export const extractPendingChoiceFromAssistantText = (
  text: string,
  capturedAt = new Date().toISOString()
): SessionPendingChoice | null => {
  const visibleText = stripCodeBlocks(text).trim();
  if (!visibleText) {
    return null;
  }
  if (!MENU_CUE_PATTERN.test(visibleText)) {
    return null;
  }

  const lines = visibleText.split(/\r?\n/);
  let bestRun: SessionPendingChoice["options"] = [];
  let currentRun: SessionPendingChoice["options"] = [];

  const commitCurrentRun = () => {
    if (currentRun.length > bestRun.length) {
      bestRun = currentRun.map(option => ({ ...option }));
    }
    currentRun = [];
  };

  for (const line of lines) {
    const match = line.match(NUMBERED_CHOICE_LINE_PATTERN);
    if (match?.[1] && match[2]) {
      const index = Number(match[1]);
      const label = normalizeChoiceLabel(match[2]);
      if (!label) {
        commitCurrentRun();
        continue;
      }
      const expectedIndex =
        currentRun.length === 0 ? 1 : currentRun[currentRun.length - 1]!.index + 1;
      if (index === expectedIndex) {
        currentRun.push({ index, label });
        continue;
      }
      commitCurrentRun();
      if (index === 1) {
        currentRun.push({ index, label });
      }
      continue;
    }

    if (
      currentRun.length > 0 &&
      line.trim() &&
      CONTINUATION_LINE_PATTERN.test(line)
    ) {
      currentRun[currentRun.length - 1]!.label = normalizeChoiceLabel(
        `${currentRun[currentRun.length - 1]!.label} ${line}`
      );
      continue;
    }

    commitCurrentRun();
  }

  commitCurrentRun();

  if (bestRun.length < 2) {
    return null;
  }

  return {
    capturedAt,
    sourcePreview: clipPreview(visibleText),
    options: bestRun,
  };
};

export type PendingChoiceResolution =
  | { kind: "not_reference" }
  | { kind: "missing_choice"; requestedIndex: number }
  | {
      kind: "unknown_choice";
      requestedIndex: number;
      availableIndexes: number[];
    }
  | {
      kind: "resolved";
      requestedIndex: number;
      option: SessionPendingChoice["options"][number];
      resolvedQuery: string;
      displayText: string;
    };

export const resolvePendingChoiceInput = (
  input: string,
  pendingChoice: SessionPendingChoice | null
): PendingChoiceResolution => {
  const requestedIndex = parsePendingChoiceReferenceIndex(input);
  if (requestedIndex === null) {
    return { kind: "not_reference" };
  }

  if (!pendingChoice) {
    return {
      kind: "missing_choice",
      requestedIndex,
    };
  }

  const option = pendingChoice.options.find(item => item.index === requestedIndex);
  if (!option) {
    return {
      kind: "unknown_choice",
      requestedIndex,
      availableIndexes: pendingChoice.options.map(item => item.index),
    };
  }

  return {
    kind: "resolved",
    requestedIndex,
    option,
    resolvedQuery: `继续上一条助手给出的编号选项 ${requestedIndex}：${option.label}`,
    displayText: `${input.trim()} → ${option.label}`,
  };
};
