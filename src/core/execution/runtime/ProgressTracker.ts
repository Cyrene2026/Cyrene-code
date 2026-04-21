import type {
  ConfirmedFileMutation,
  FileReadLedgerEntry,
  MultiFileProgressLedger,
  ProgressSnapshot,
  SearchMemory,
  UncertaintyState,
} from "./ExecutionSnapshot";
import {
  extractPathsFromText,
  normalizeComparedPath,
  normalizeUniquePaths,
} from "./ExecutionSupport";
import { countReadLedgerCoverageUnits } from "./ToolObservationStore";

const ENGLISH_FILE_COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
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
};

const formatPathList = (paths: string[], maxItems = 5) => {
  if (paths.length === 0) {
    return "(none)";
  }
  const visible = paths.slice(0, maxItems).join(", ");
  const hidden = paths.length - Math.min(paths.length, maxItems);
  return hidden > 0 ? `${visible} (+${hidden} more)` : visible;
};

const parseChineseNumber = (token: string) => {
  const normalized = token.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "十") {
    return 10;
  }
  if (normalized.includes("十")) {
    const [left, right] = normalized.split("十");
    const tens = left ? (CHINESE_DIGITS[left] ?? 0) : 1;
    const ones = right ? (CHINESE_DIGITS[right] ?? 0) : 0;
    const value = tens * 10 + ones;
    return value > 0 ? value : undefined;
  }
  if (normalized.length === 1) {
    const digit = CHINESE_DIGITS[normalized];
    return typeof digit === "number" ? digit : undefined;
  }
  return undefined;
};

const parseLooseFileCount = (token: string) => {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  if (normalized in ENGLISH_FILE_COUNT_WORDS) {
    return ENGLISH_FILE_COUNT_WORDS[normalized];
  }
  return parseChineseNumber(token);
};

const extractExplicitTaskPaths = (task: string) => extractPathsFromText(task);

const extractExpectedFileCount = (task: string, explicitPaths: string[]) => {
  const patterns = [
    /(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:new\s+|additional\s+)?(?:[a-z]+\s+)?files?\b/i,
    /(\d+|[零〇一二两三四五六七八九十]+)\s*个?\s*(?:[a-z]+\s*)?(?:文件|脚本|组件|模块)/i,
  ];
  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = parseLooseFileCount(match[1]);
    if (typeof parsed === "number" && parsed > 0) {
      return Math.max(parsed, explicitPaths.length);
    }
  }
  return explicitPaths.length > 1 ? explicitPaths.length : undefined;
};

export const createInitialMultiFileProgressLedger = (
  task: string,
  splitTaskPattern: RegExp
): MultiFileProgressLedger => {
  const explicitPaths = extractExplicitTaskPaths(task);
  const targetPaths =
    explicitPaths.length === 1 && splitTaskPattern.test(task) ? [] : explicitPaths;
  return {
    expectedFileCount: extractExpectedFileCount(task, targetPaths),
    targetPaths,
    completedPaths: [],
  };
};

export const getLedgerExpectedFileCount = (ledger: MultiFileProgressLedger) =>
  Math.max(ledger.expectedFileCount ?? 0, ledger.targetPaths.length);

export const getLedgerRemainingPaths = (ledger: MultiFileProgressLedger) => {
  const completed = new Set(ledger.completedPaths.map(normalizeComparedPath));
  return ledger.targetPaths.filter(
    path => !completed.has(normalizeComparedPath(path))
  );
};

export const getLedgerRemainingCount = (ledger: MultiFileProgressLedger) => {
  const expected = getLedgerExpectedFileCount(ledger);
  if (expected > 0) {
    return Math.max(0, expected - ledger.completedPaths.length);
  }
  return getLedgerRemainingPaths(ledger).length;
};

export const isMeaningfulMultiFileLedger = (ledger: MultiFileProgressLedger) => {
  const expected = getLedgerExpectedFileCount(ledger);
  return (
    expected > 1 ||
    ledger.targetPaths.length > 1 ||
    ledger.completedPaths.length > 1
  );
};

export const pushCompletedPathToLedger = (
  ledger: MultiFileProgressLedger,
  path: string
): MultiFileProgressLedger => {
  const normalizedPath = normalizeComparedPath(path);
  if (!normalizedPath) {
    return ledger;
  }
  const completedPaths = normalizeUniquePaths([
    ...ledger.completedPaths,
    normalizedPath,
  ]);
  const expected = getLedgerExpectedFileCount(ledger);
  return {
    ...ledger,
    expectedFileCount:
      expected > 0 ? Math.max(expected, completedPaths.length) : undefined,
    completedPaths,
    lastCompletedPath: normalizedPath,
  };
};

export const formatMultiFileProgressLedger = (
  ledger: MultiFileProgressLedger
) => {
  if (!isMeaningfulMultiFileLedger(ledger)) {
    return "";
  }

  const expected = getLedgerExpectedFileCount(ledger);
  const completedCount = ledger.completedPaths.length;
  const remainingPaths = getLedgerRemainingPaths(ledger);
  const remainingCount = getLedgerRemainingCount(ledger);
  const extraUnnamedRemaining = Math.max(0, remainingCount - remainingPaths.length);
  const lines: string[] = [];

  if (expected > 0) {
    lines.push(`expected files: ${expected}`);
  }

  if (completedCount > 0) {
    lines.push(
      expected > 0
        ? `completed (${completedCount}/${expected}): ${formatPathList(
            ledger.completedPaths
          )}`
        : `completed (${completedCount}): ${formatPathList(ledger.completedPaths)}`
    );
  } else if (expected > 0) {
    lines.push(`completed (0/${expected}): (none yet)`);
  }

  if (remainingPaths.length > 0) {
    lines.push(
      `remaining known paths (${remainingPaths.length}): ${formatPathList(
        remainingPaths
      )}`
    );
  }

  if (remainingCount > 0 && remainingPaths.length === 0) {
    lines.push(`remaining count: ${remainingCount}`);
  } else if (extraUnnamedRemaining > 0) {
    lines.push(`remaining additional file count: ${extraUnnamedRemaining}`);
  }

  if (ledger.lastCompletedPath) {
    lines.push(`last completed file: ${ledger.lastCompletedPath}`);
  }

  return lines.join("\n");
};

export const captureProgressSnapshot = (
  uncertainty: UncertaintyState,
  ledger: MultiFileProgressLedger,
  searchMemory: SearchMemory,
  readLedger: Map<string, FileReadLedgerEntry>,
  filesystemMutationRevision: number
): ProgressSnapshot => ({
  mutationRevision: filesystemMutationRevision,
  phase: uncertainty.phase,
  analysisSignalCount: uncertainty.analysisSignalCount,
  semanticNavigationCount: uncertainty.semanticNavigationCount,
  completedPathCount: ledger.completedPaths.length,
  discoveredPathCount: searchMemory.discoveredPaths.size,
  evidenceCount: searchMemory.evidenceSignatures.size,
  semanticRoutingCount: searchMemory.semanticRoutingByPath.size,
  readCoverageUnits: countReadLedgerCoverageUnits(
    readLedger,
    filesystemMutationRevision
  ),
});

export const didMakeExecutionProgress = (
  before: ProgressSnapshot,
  after: ProgressSnapshot
) =>
  after.mutationRevision > before.mutationRevision ||
  after.phase !== before.phase ||
  after.analysisSignalCount > before.analysisSignalCount ||
  after.semanticNavigationCount > before.semanticNavigationCount ||
  after.completedPathCount > before.completedPathCount ||
  after.discoveredPathCount > before.discoveredPathCount ||
  after.evidenceCount > before.evidenceCount ||
  after.semanticRoutingCount > before.semanticRoutingCount ||
  after.readCoverageUnits > before.readCoverageUnits;

export const formatRecentConfirmedFileMutations = (
  recentMutations: ConfirmedFileMutation[]
) => {
  if (recentMutations.length === 0) {
    return "";
  }

  return recentMutations
    .map(
      (mutation, index) =>
        `${index + 1}. ${mutation.action} ${mutation.path} (confirmed written or updated; continue instead of rereading just to check)`
    )
    .join("\n");
};
