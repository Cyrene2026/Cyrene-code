import type {
  ConfirmedFileMutation,
  FileReadLedgerEntry,
  SearchMemory,
} from "./ExecutionSnapshot";
import type {
  RunQuerySessionResumeInput,
  RunQuerySessionToolResult,
} from "./ExecutionTypes";
import {
  getToolAction,
  getToolPath,
  HIGH_VALUE_EVIDENCE_ACTIONS,
  isLspConfigUnavailableMessage,
  isTypeScriptLikePath,
  normalizeComparedPath,
  pickFiniteNumber,
  toRecord,
  extractPathsFromText,
  BROAD_DISCOVERY_ACTIONS,
  PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS,
} from "./ExecutionSupport";

const MUTATING_FILE_ACTIONS = new Set([
  "create_dir",
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "copy_path",
  "move_path",
]);

const CONTENT_MUTATING_FILE_ACTIONS = new Set([
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
]);

const MUTATION_RESULT_MARKERS = [
  "Created file:",
  "Created directory:",
  "Wrote file:",
  "Edited file:",
  "Patched file:",
  "Deleted file:",
  "Copied path:",
  "Moved path:",
];

const SEARCH_MEMORY_SCOPE_LIMIT = 6;
const SEARCH_MEMORY_PATH_LIMIT = 6;
const FILE_READ_LEDGER_LIMIT = 8;
const formatPathList = (paths: string[], maxItems = 5) => {
  if (paths.length === 0) {
    return "(none)";
  }
  const visible = paths.slice(0, maxItems).join(", ");
  const hidden = paths.length - Math.min(paths.length, maxItems);
  return hidden > 0 ? `${visible} (+${hidden} more)` : visible;
};

const isMutatingFileAction = (toolName: string, input: unknown) =>
  MUTATING_FILE_ACTIONS.has(getToolAction(toolName, input));

const isContentMutatingFileAction = (toolName: string, input: unknown) =>
  CONTENT_MUTATING_FILE_ACTIONS.has(getToolAction(toolName, input));

const isScopeBudgetedBroadDiscoveryAction = (toolName: string, input: unknown) =>
  BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input)) ||
  PROJECT_ANALYSIS_BROAD_DISCOVERY_ACTIONS.has(getToolAction(toolName, input));

const getBroadDiscoveryScope = (toolName: string, input: unknown) => {
  if (!isScopeBudgetedBroadDiscoveryAction(toolName, input)) {
    return null;
  }
  return normalizeComparedPath(getToolPath(input) ?? ".") || ".";
};

const getReadLedgerPath = (input: unknown) => {
  const path = getToolPath(input);
  if (!path) {
    return null;
  }
  const normalized = normalizeComparedPath(path);
  return normalized || null;
};

const getStructuredFileResultMetadata = (metadata: unknown) => {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  if (record.kind !== "file") {
    return null;
  }
  return record;
};

const getStructuredFileReadMetadata = (metadata: unknown) => {
  const fileMetadata = getStructuredFileResultMetadata(metadata);
  if (!fileMetadata) {
    return null;
  }
  const read = fileMetadata.read;
  if (!read || typeof read !== "object") {
    return null;
  }
  return {
    fileMetadata,
    read: read as Record<string, unknown>,
  };
};

const didApplyStructuredFileMutation = (metadata: unknown) => {
  const fileMetadata = getStructuredFileResultMetadata(metadata);
  if (!fileMetadata) {
    return false;
  }
  const mutation = fileMetadata.mutation;
  return (
    !!mutation &&
    typeof mutation === "object" &&
    "applied" in mutation &&
    (mutation as Record<string, unknown>).applied === true
  );
};

const mergeReadRanges = (ranges: Array<{ startLine: number; endLine: number }>) => {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((left, right) =>
    left.startLine === right.startLine
      ? left.endLine - right.endLine
      : left.startLine - right.startLine
  );
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (!previous || current.startLine > previous.endLine + 1) {
      merged.push({ ...current });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, current.endLine);
  }
  return merged;
};

export const didApplyFileMutation = (
  toolName: string,
  input: unknown,
  message: string,
  metadata?: unknown
) =>
  isMutatingFileAction(toolName, input) &&
  (MUTATION_RESULT_MARKERS.some(marker => message.includes(marker)) ||
    didApplyStructuredFileMutation(metadata));

export const getConfirmedFileMutation = (
  toolName: string,
  input: unknown,
  message: string,
  metadata?: unknown
): ConfirmedFileMutation | null => {
  if (
    !didApplyFileMutation(toolName, input, message, metadata) ||
    !isContentMutatingFileAction(toolName, input)
  ) {
    return null;
  }

  const path = getToolPath(input);
  const action = getToolAction(toolName, input);
  if (!path || !CONTENT_MUTATING_FILE_ACTIONS.has(action)) {
    return null;
  }

  return {
    action: action as ConfirmedFileMutation["action"],
    path,
  };
};

export const pushRecentConfirmedFileMutation = (
  recentMutations: ConfirmedFileMutation[],
  mutation: ConfirmedFileMutation
) => {
  const normalizedPath = normalizeComparedPath(mutation.path);
  const filtered = recentMutations.filter(
    entry => normalizeComparedPath(entry.path) !== normalizedPath
  );
  return [...filtered, mutation].slice(-4);
};

export const createSearchMemory = (): SearchMemory => ({
  scopedBroadDiscoveryBudget: new Map(),
  searchedScopes: new Set(),
  discoveredPaths: new Set(),
  evidenceSignatures: new Set(),
  semanticRoutingByPath: new Map(),
});

export const countReadLedgerCoverageUnits = (
  ledger: Map<string, FileReadLedgerEntry>,
  filesystemMutationRevision: number
) =>
  Array.from(ledger.values())
    .filter(entry => entry.revision === filesystemMutationRevision)
    .reduce((total, entry) => {
      if (entry.fullyRead) {
        return total + Math.max(entry.lastReadEndLine ?? 1, 1);
      }
      const coveredLines = entry.ranges.reduce(
        (sum, range) => sum + Math.max(0, range.endLine - range.startLine + 1),
        0
      );
      return total + coveredLines;
    }, 0);

export const getReadLedgerEntry = (
  ledger: Map<string, FileReadLedgerEntry>,
  input: unknown
) => {
  const path = getReadLedgerPath(input);
  return path ? ledger.get(path) ?? null : null;
};

export const normalizeResumeToolResult = (
  toolResult: RunQuerySessionResumeInput
): RunQuerySessionToolResult =>
  typeof toolResult === "string" ? { message: toolResult } : toolResult;

export const updateReadLedgerFromToolResult = (
  ledger: Map<string, FileReadLedgerEntry>,
  toolName: string,
  input: unknown,
  message: string,
  metadata: unknown,
  filesystemMutationRevision: number
) => {
  if (toolName !== "file") {
    return;
  }
  const action = getToolAction(toolName, input);
  if (action !== "read_file" && action !== "read_range") {
    return;
  }
  const structured = getStructuredFileReadMetadata(metadata);
  const structuredFileMetadata = structured?.fileMetadata;
  const structuredRead = structured?.read;
  const path =
    (typeof structuredFileMetadata?.workspacePath === "string" &&
    structuredFileMetadata.workspacePath.trim()
      ? normalizeComparedPath(structuredFileMetadata.workspacePath)
      : null) ?? getReadLedgerPath(input);
  if (!path || message.startsWith("[tool error]")) {
    return;
  }

  const previous = ledger.get(path);
  const revisionKey =
    structuredFileMetadata &&
    structuredFileMetadata.fileRevision &&
    typeof structuredFileMetadata.fileRevision === "object" &&
    "revisionKey" in structuredFileMetadata.fileRevision &&
    typeof (structuredFileMetadata.fileRevision as Record<string, unknown>).revisionKey ===
      "string"
      ? String(
          (structuredFileMetadata.fileRevision as Record<string, unknown>).revisionKey
        )
      : null;
  if (action === "read_file") {
    ledger.set(path, {
      path,
      revision: filesystemMutationRevision,
      revisionKey,
      lastReadStartLine: 1,
      lastReadEndLine:
        structuredRead &&
        typeof structuredRead.endLine === "number" &&
        Number.isFinite(structuredRead.endLine)
          ? Number(structuredRead.endLine)
          : null,
      fullyRead:
        structuredRead && typeof structuredRead.fullyRead === "boolean"
          ? structuredRead.fullyRead
          : true,
      truncated: false,
      nextSuggestedStartLine: null,
      ranges: [],
    });
    return;
  }

  const record = toRecord(input);
  const startLine =
    structuredRead && typeof structuredRead.startLine === "number"
      ? Number(structuredRead.startLine)
      : record
        ? pickFiniteNumber(record, "startLine")
        : undefined;
  const endLine =
    structuredRead && typeof structuredRead.endLine === "number"
      ? Number(structuredRead.endLine)
      : record
        ? pickFiniteNumber(record, "endLine")
        : undefined;
  if (typeof startLine !== "number" || typeof endLine !== "number") {
    return;
  }
  const ranges = mergeReadRanges([
    ...(previous?.revision === filesystemMutationRevision ? previous.ranges : []),
    { startLine, endLine },
  ]);
  const leadingRange = ranges[0];
  const nextSuggestedStartLine =
    leadingRange && leadingRange.startLine === 1 ? leadingRange.endLine + 1 : null;
  ledger.set(path, {
    path,
    revision: filesystemMutationRevision,
    revisionKey,
    lastReadStartLine: startLine,
    lastReadEndLine: endLine,
    fullyRead:
      structuredRead && typeof structuredRead.fullyRead === "boolean"
        ? structuredRead.fullyRead
        : previous?.fullyRead ?? false,
    truncated:
      structuredRead && typeof structuredRead.truncated === "boolean"
        ? structuredRead.truncated
        : true,
    nextSuggestedStartLine:
      structuredRead && typeof structuredRead.nextSuggestedStartLine === "number"
        ? Number(structuredRead.nextSuggestedStartLine)
        : nextSuggestedStartLine,
    ranges,
  });
};

export const clearReadLedgerForMutation = (
  ledger: Map<string, FileReadLedgerEntry>,
  mutation: ConfirmedFileMutation | null
) => {
  if (!mutation) {
    return;
  }
  const normalized = normalizeComparedPath(mutation.path);
  if (!normalized) {
    return;
  }
  ledger.delete(normalized);
};

export const formatFileReadLedger = (
  ledger: Map<string, FileReadLedgerEntry>,
  filesystemMutationRevision: number
) => {
  const entries = Array.from(ledger.values())
    .filter(entry => entry.revision === filesystemMutationRevision)
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, FILE_READ_LEDGER_LIMIT);
  if (entries.length === 0) {
    return "";
  }

  return entries
    .map(entry => {
      if (entry.fullyRead) {
        return `${entry.path}: fully_read=true; next read only if the file changes`;
      }
      const rangePreview = entry.ranges
        .slice(0, 3)
        .map(range => `${range.startLine}-${range.endLine}`)
        .join(", ");
      const nextHint =
        typeof entry.nextSuggestedStartLine === "number"
          ? `; next_suggested_start_line=${entry.nextSuggestedStartLine}`
          : "";
      return `${entry.path}: fully_read=false; read_ranges=${rangePreview}${nextHint}`;
    })
    .join("\n");
};

export const isReadRangeCoveredByLedger = (
  entry: FileReadLedgerEntry,
  startLine: number,
  endLine: number,
  filesystemMutationRevision: number
) =>
  entry.revision === filesystemMutationRevision &&
  entry.ranges.some(
    range => range.startLine <= startLine && range.endLine >= endLine
  );

const extractEvidencePaths = (
  toolName: string,
  input: unknown,
  message: string
) => {
  const normalized = new Set<string>();
  const action = getToolAction(toolName, input);
  const inputPath = getToolPath(input);
  if (inputPath && HIGH_VALUE_EVIDENCE_ACTIONS.has(action)) {
    normalized.add(normalizeComparedPath(inputPath));
  }
  for (const path of extractPathsFromText(message)) {
    normalized.add(path);
  }
  return Array.from(normalized).filter(Boolean);
};

export const recordSearchObservation = (
  searchMemory: SearchMemory,
  toolName: string,
  input: unknown,
  message: string
) => {
  const action = getToolAction(toolName, input);
  const scope = getBroadDiscoveryScope(toolName, input);
  if (scope) {
    searchMemory.searchedScopes.add(scope);
  }

  const evidencePaths = extractEvidencePaths(toolName, input, message);
  for (const path of evidencePaths) {
    searchMemory.discoveredPaths.add(path);
    searchMemory.evidenceSignatures.add(`${action}:${path}`);
    if (isScopeBudgetedBroadDiscoveryAction(toolName, input)) {
      searchMemory.evidenceSignatures.add(`hit:${path}`);
    }
  }

  const directPath = getToolPath(input);
  if (!directPath) {
    return;
  }
  const normalizedPath = normalizeComparedPath(directPath);
  if (!normalizedPath) {
    return;
  }

  if (action.startsWith("lsp_")) {
    if (message.startsWith("[tool error]") && isLspConfigUnavailableMessage(message)) {
      searchMemory.semanticRoutingByPath.set(normalizedPath, {
        provider: isTypeScriptLikePath(normalizedPath) ? "ts" : "text",
        reason: "lsp_unavailable",
      });
      return;
    }
    if (!message.startsWith("[tool error]")) {
      searchMemory.semanticRoutingByPath.set(normalizedPath, {
        provider: "lsp",
        reason: "lsp_available",
      });
      return;
    }
  }

  if (action.startsWith("ts_") && !message.startsWith("[tool error]")) {
    searchMemory.semanticRoutingByPath.set(normalizedPath, {
      provider: "ts",
      reason: "ts_available",
    });
  }
};

export const formatSearchMemory = (searchMemory: SearchMemory) => {
  const searchedScopes = Array.from(searchMemory.searchedScopes).sort();
  const discoveredPaths = Array.from(searchMemory.discoveredPaths).sort();
  const semanticRouting = Array.from(searchMemory.semanticRoutingByPath.entries())
    .map(([path, hint]) => ({ path, hint }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const budgetUsage = Array.from(searchMemory.scopedBroadDiscoveryBudget.entries())
    .map(([key, count]) => {
      const separator = key.indexOf(":");
      return {
        scope: separator >= 0 ? key.slice(separator + 1) : key,
        count,
      };
    })
    .sort((left, right) => left.scope.localeCompare(right.scope));

  if (
    searchedScopes.length === 0 &&
    discoveredPaths.length === 0 &&
    semanticRouting.length === 0 &&
    budgetUsage.length === 0
  ) {
    return "";
  }

  const lines: string[] = [];
  if (searchedScopes.length > 0) {
    lines.push(
      `searched scopes: ${formatPathList(searchedScopes, SEARCH_MEMORY_SCOPE_LIMIT)}`
    );
  }
  if (discoveredPaths.length > 0) {
    lines.push(
      `known hit paths: ${formatPathList(discoveredPaths, SEARCH_MEMORY_PATH_LIMIT)}`
    );
  }
  if (budgetUsage.length > 0) {
    lines.push(
      `broad search budgets: ${budgetUsage
        .slice(0, SEARCH_MEMORY_SCOPE_LIMIT)
        .map(entry => `${entry.scope} ${entry.count}/3`)
        .join(", ")}`
    );
  }
  if (semanticRouting.length > 0) {
    lines.push(
      `semantic routing: ${semanticRouting
        .slice(0, SEARCH_MEMORY_PATH_LIMIT)
        .map(({ path, hint }) => `${path} -> ${hint.provider}`)
        .join(", ")}`
    );
  }

  return lines.join("\n");
};
