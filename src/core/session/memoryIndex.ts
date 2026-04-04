import type { SessionMessage } from "./types";
import {
  WORKING_STATE_SECTION_ORDER,
  parseWorkingStateSummary,
  type WorkingStateSectionMap,
  type WorkingStateSectionName,
} from "./workingState";

export type MemoryKind =
  | "pin"
  | "task"
  | "tool_result"
  | "approval"
  | "error"
  | "fact";

export type SessionMemoryEntities = {
  path?: string[];
  toolName?: string[];
  action?: string[];
  topic?: string[];
  status?: string[];
  queryTerms?: string[];
};

export type SessionMemoryEntry = {
  id: string;
  sessionId: string;
  kind: MemoryKind;
  text: string;
  priority: number;
  createdAt: string;
  updatedAt?: string;
  sourceMessageRange?: {
    start: number;
    end: number;
  };
  tags: string[];
  entities: SessionMemoryEntities;
  dedupeKey?: string;
  hitCount?: number;
};

export type SessionMemoryIndex = {
  version: 1;
  sessionId: string;
  updatedAt: string;
  entries: SessionMemoryEntry[];
  byKind: Partial<Record<MemoryKind, string[]>>;
  byPath: Record<string, string[]>;
  byTool: Record<string, string[]>;
  byAction: Record<string, string[]>;
  byPriority: string[];
};

export type SessionMemoryInput = {
  kind: MemoryKind;
  text: string;
  priority: number;
  createdAt?: string;
  sourceMessageRange?: {
    start: number;
    end: number;
  };
  tags?: string[];
  entities?: SessionMemoryEntities;
  dedupeKey?: string;
};

export type SessionPromptContext = {
  pins: string[];
  relevantMemories: string[];
  archiveSections?: WorkingStateSectionMap;
  recent: SessionMessage[];
  summaryFallback: string;
};

const QUERY_TOKEN_LIMIT = 12;
const MEMORY_TEXT_LIMIT = 420;
const SUMMARY_LINE_LIMIT = 5;
const MEMORY_COMPACTION_HARD_LIMIT = 140;
const MEMORY_COMPACTION_TARGET_SIZE = 140;
const MEMORY_COMPACTION_RECENT_KEEP = 36;
const DEFAULT_ARCHIVE_SECTION_LIMIT = 2;
const KNOWN_PATH_ARCHIVE_LIMIT = 4;
const CONSTRAINT_SIGNAL =
  /\b(must|should|cannot|can't|do not|don't|avoid|blocked|pending|requires|limit|constraint)\b|必须|不能|不要|避免|受限|限制|阻塞|待审批|需要/iu;
const COMPLETED_SIGNAL =
  /\b(done|completed|finished|wrote|created|updated|implemented|fixed|approved|resolved)\b|完成|已写|已创建|已更新|已实现|已修复|已批准|已解决/iu;
const FAILURE_SIGNAL =
  /\b(fail|failed|error|denied|timeout|timed out|rejected|blocked)\b|失败|错误|拒绝|超时|阻塞/iu;

const clipText = (text: string, max = MEMORY_TEXT_LIMIT) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
};

const tokenizeText = (text: string, max = QUERY_TOKEN_LIMIT) => {
  const tokens =
    text
      .toLowerCase()
      .match(/[a-z0-9_./-]+|[\u4e00-\u9fff]{2,}/g)
      ?.map(token => token.trim())
      .filter(Boolean) ?? [];

  return Array.from(new Set(tokens)).slice(0, max);
};

const tokenMatchScore = (
  searchable: Set<string>,
  lowerText: string,
  tokens: string[],
  exactBoost: number,
  containsBoost: number
) => {
  let score = 0;
  for (const token of tokens) {
    if (searchable.has(token)) {
      score += exactBoost;
    } else if (lowerText.includes(token)) {
      score += containsBoost;
    }
  }
  return score;
};

const overlapScore = (
  values: string[] | undefined,
  signals: string[],
  boost: number
) => {
  if (!values || values.length === 0 || signals.length === 0) {
    return 0;
  }
  const signalSet = new Set(signals);
  return values.reduce(
    (score, value) => score + (signalSet.has(value) ? boost : 0),
    0
  );
};

const collectPathCandidates = (text: string) =>
  Array.from(
    new Set(
      (text.match(/[a-z0-9_.\\/:-]+\.[a-z0-9]+/gi) ?? []).map(candidate =>
        candidate.replace(/\\/g, "/")
      )
    )
  ).slice(0, 6);

const collectToolNames = (text: string) =>
  Array.from(
    new Set(
      (
        text.match(
          /\b(read_file|read_files|read_range|read_json|read_yaml|list_dir|create_dir|create_file|write_file|edit_file|apply_patch|delete_file|stat_path|stat_paths|outline_file|find_files|find_symbol|find_references|search_text|search_text_context|copy_path|move_path|git_status|git_diff|git_log|git_show|git_blame|run_command|run_shell)\b/gi
        ) ?? []
      ).map(token => token.toLowerCase())
    )
  ).slice(0, 6);

const inferStatuses = (kind: MemoryKind, text: string) => {
  const lowered = text.toLowerCase();
  if (kind === "approval") {
    if (lowered.includes("rejected")) {
      return ["rejected"];
    }
    if (lowered.includes("approved")) {
      return ["approved"];
    }
  }
  if (kind === "error") {
    return ["error"];
  }
  if (kind === "tool_result") {
    return ["ok"];
  }
  return [];
};

const buildEntities = (
  kind: MemoryKind,
  text: string,
  entities?: SessionMemoryEntities
): SessionMemoryEntities => {
  const queryTerms = Array.from(
    new Set([...(entities?.queryTerms ?? []), ...tokenizeText(text)])
  ).slice(0, QUERY_TOKEN_LIMIT);

  const paths = Array.from(
    new Set([...(entities?.path ?? []), ...collectPathCandidates(text)])
  ).slice(0, 6);
  const toolNames = Array.from(
    new Set([...(entities?.toolName ?? []), ...collectToolNames(text)])
  ).slice(0, 6);
  const actions = Array.from(
    new Set([...(entities?.action ?? []), ...(entities?.toolName ?? []), ...toolNames])
  ).slice(0, 6);
  const topics = Array.from(
    new Set([...(entities?.topic ?? []), ...queryTerms.slice(0, 4)])
  ).slice(0, 6);
  const statuses = Array.from(
    new Set([...(entities?.status ?? []), ...inferStatuses(kind, text)])
  ).slice(0, 4);

  return {
    path: paths.length > 0 ? paths : undefined,
    toolName: toolNames.length > 0 ? toolNames : undefined,
    action: actions.length > 0 ? actions : undefined,
    topic: topics.length > 0 ? topics : undefined,
    status: statuses.length > 0 ? statuses : undefined,
    queryTerms: queryTerms.length > 0 ? queryTerms : undefined,
  };
};

const buildTags = (
  text: string,
  entities: SessionMemoryEntities,
  tags?: string[]
) =>
  Array.from(
    new Set([
      ...(tags ?? []),
      ...(entities.path ?? []),
      ...(entities.toolName ?? []),
      ...(entities.action ?? []),
      ...(entities.status ?? []),
      ...tokenizeText(text, 8),
    ])
  ).slice(0, 12);

const createDedupeKey = (
  kind: MemoryKind,
  text: string,
  entities: SessionMemoryEntities,
  supplied?: string
) => {
  if (supplied?.trim()) {
    return supplied.trim();
  }

  const path = entities.path?.[0];
  const action = entities.action?.[0];
  const status = entities.status?.[0];

  if (kind === "pin") {
    return `pin:${clipText(text, 160).toLowerCase()}`;
  }

  if ((kind === "tool_result" || kind === "approval") && (path || action || status)) {
    return [kind, action ?? "none", path ?? "none", status ?? "none"].join(":");
  }

  if (kind === "error") {
    return [
      "error",
      action ?? "none",
      path ?? "none",
      clipText(text, 160).toLowerCase(),
    ].join(":");
  }

  return [kind, clipText(text, 160).toLowerCase()].join(":");
};

const sortEntriesByTime = (entries: SessionMemoryEntry[]) =>
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const createdAtOrder = right.entry.createdAt.localeCompare(left.entry.createdAt);
      if (createdAtOrder !== 0) {
        return createdAtOrder;
      }

      const leftUpdatedAt = left.entry.updatedAt ?? left.entry.createdAt;
      const rightUpdatedAt = right.entry.updatedAt ?? right.entry.createdAt;
      const updatedAtOrder = rightUpdatedAt.localeCompare(leftUpdatedAt);
      if (updatedAtOrder !== 0) {
        return updatedAtOrder;
      }

      return left.index - right.index;
    })
    .map(item => item.entry);

const sortEntriesByPriorityAndTime = (entries: SessionMemoryEntry[]) =>
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      if (right.entry.priority !== left.entry.priority) {
        return right.entry.priority - left.entry.priority;
      }

      const createdAtOrder = right.entry.createdAt.localeCompare(left.entry.createdAt);
      if (createdAtOrder !== 0) {
        return createdAtOrder;
      }

      const leftUpdatedAt = left.entry.updatedAt ?? left.entry.createdAt;
      const rightUpdatedAt = right.entry.updatedAt ?? right.entry.createdAt;
      const updatedAtOrder = rightUpdatedAt.localeCompare(leftUpdatedAt);
      if (updatedAtOrder !== 0) {
        return updatedAtOrder;
      }

      return right.index - left.index;
    })
    .map(item => item.entry);

const compactMemoryEntries = (entries: SessionMemoryEntry[]) => {
  if (entries.length <= MEMORY_COMPACTION_HARD_LIMIT) {
    return entries;
  }

  const sortedByTime = sortEntriesByTime(entries);
  const protectedIds = new Set(
    sortedByTime
      .filter(entry => entry.kind === "pin")
      .map(entry => entry.id)
  );

  for (const entry of sortedByTime.slice(0, MEMORY_COMPACTION_RECENT_KEEP)) {
    protectedIds.add(entry.id);
  }

  const rankById = new Map(
    sortedByTime.map((entry, index) => [entry.id, index] as const)
  );

  const scored = sortedByTime
    .filter(entry => !protectedIds.has(entry.id))
    .map(entry => {
      const ageRank = rankById.get(entry.id) ?? sortedByTime.length;
      let score = entry.priority + Math.min(entry.hitCount ?? 1, 6) * 8;
      score += Math.max(0, 80 - ageRank * 2);

      switch (entry.kind) {
        case "error":
          score += 90;
          break;
        case "approval":
          score += 70;
          break;
        case "tool_result":
          score += 60;
          break;
        case "task":
          score += 35;
          break;
        case "fact":
          score += 15;
          break;
      }

      score += (entry.entities.path?.length ?? 0) * 18;
      score += (entry.entities.toolName?.length ?? 0) * 12;
      score += (entry.entities.action?.length ?? 0) * 8;
      score += (entry.entities.status?.length ?? 0) * 10;
      if ((entry.tags.length ?? 0) > 0) {
        score += Math.min(entry.tags.length, 6) * 2;
      }

      return { entry, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.entry.createdAt.localeCompare(left.entry.createdAt);
    });

  const keepIds = new Set(protectedIds);
  for (const { entry } of scored) {
    if (keepIds.size >= MEMORY_COMPACTION_TARGET_SIZE) {
      break;
    }
    keepIds.add(entry.id);
  }

  return entries.filter(entry => keepIds.has(entry.id));
};

export const createEmptyMemoryIndex = (
  sessionId: string,
  updatedAt = new Date().toISOString()
): SessionMemoryIndex => ({
  version: 1,
  sessionId,
  updatedAt,
  entries: [],
  byKind: {},
  byPath: {},
  byTool: {},
  byAction: {},
  byPriority: [],
});

export const materializeMemoryInput = (
  sessionId: string,
  input: SessionMemoryInput
): SessionMemoryEntry => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const text = clipText(input.text);
  const entities = buildEntities(input.kind, text, input.entities);
  return {
    id: crypto.randomUUID(),
    sessionId,
    kind: input.kind,
    text,
    priority: input.priority,
    createdAt,
    sourceMessageRange: input.sourceMessageRange,
    entities,
    tags: buildTags(text, entities, input.tags),
    dedupeKey: createDedupeKey(input.kind, text, entities, input.dedupeKey),
    hitCount: 1,
  };
};

export const rebuildMemoryLookup = (
  sessionId: string,
  entries: SessionMemoryEntry[],
  updatedAt = new Date().toISOString()
): SessionMemoryIndex => {
  const sortedEntries = sortEntriesByTime(compactMemoryEntries(entries));
  const byKind: SessionMemoryIndex["byKind"] = {};
  const byPath: Record<string, string[]> = {};
  const byTool: Record<string, string[]> = {};
  const byAction: Record<string, string[]> = {};

  for (const entry of sortedEntries) {
    byKind[entry.kind] = [...(byKind[entry.kind] ?? []), entry.id];

    for (const path of entry.entities.path ?? []) {
      byPath[path] = [...(byPath[path] ?? []), entry.id];
    }
    for (const toolName of entry.entities.toolName ?? []) {
      byTool[toolName] = [...(byTool[toolName] ?? []), entry.id];
    }
    for (const action of entry.entities.action ?? []) {
      byAction[action] = [...(byAction[action] ?? []), entry.id];
    }
  }

  return {
    version: 1,
    sessionId,
    updatedAt,
    entries: sortedEntries,
    byKind,
    byPath,
    byTool,
    byAction,
    byPriority: sortEntriesByPriorityAndTime(sortedEntries).map(entry => entry.id),
  };
};

export const upsertMemoryEntries = (
  index: SessionMemoryIndex,
  inputs: SessionMemoryInput[]
) => {
  let entries = [...index.entries];

  for (const input of inputs) {
    const nextEntry = materializeMemoryInput(index.sessionId, input);
    const existingIndex = entries.findIndex(
      entry => entry.dedupeKey && entry.dedupeKey === nextEntry.dedupeKey
    );

    if (existingIndex >= 0) {
      const existing = entries[existingIndex];
      if (!existing) {
        continue;
      }
      entries[existingIndex] = {
        ...existing,
        text: nextEntry.text,
        priority: Math.max(existing.priority, nextEntry.priority),
        createdAt: nextEntry.createdAt,
        updatedAt: nextEntry.createdAt,
        tags: Array.from(new Set([...existing.tags, ...nextEntry.tags])).slice(0, 12),
        entities: {
          path: Array.from(
            new Set([...(existing.entities.path ?? []), ...(nextEntry.entities.path ?? [])])
          ).slice(0, 6),
          toolName: Array.from(
            new Set([
              ...(existing.entities.toolName ?? []),
              ...(nextEntry.entities.toolName ?? []),
            ])
          ).slice(0, 6),
          action: Array.from(
            new Set([...(existing.entities.action ?? []), ...(nextEntry.entities.action ?? [])])
          ).slice(0, 6),
          topic: Array.from(
            new Set([...(existing.entities.topic ?? []), ...(nextEntry.entities.topic ?? [])])
          ).slice(0, 6),
          status: Array.from(
            new Set([...(existing.entities.status ?? []), ...(nextEntry.entities.status ?? [])])
          ).slice(0, 6),
          queryTerms: Array.from(
            new Set([
              ...(existing.entities.queryTerms ?? []),
              ...(nextEntry.entities.queryTerms ?? []),
            ])
          ).slice(0, QUERY_TOKEN_LIMIT),
        },
        hitCount: (existing.hitCount ?? 1) + 1,
      };
      continue;
    }

    entries.push(nextEntry);
  }

  return rebuildMemoryLookup(index.sessionId, entries);
};

export const deriveFocusFromMemoryIndex = (index: SessionMemoryIndex, limit = 6) =>
  sortEntriesByPriorityAndTime(index.entries)
    .filter(entry => entry.kind === "pin")
    .slice(0, limit)
    .map(entry => entry.text);

export const buildSummaryCacheFromMemoryIndex = (index: SessionMemoryIndex) =>
  sortEntriesByTime(index.entries)
    .filter(entry => entry.kind !== "pin")
    .slice(0, SUMMARY_LINE_LIMIT)
    .map(entry => `- ${entry.kind}: ${clipText(entry.text, 120)}`)
    .join("\n");

export const removePinMemoryEntry = (
  index: SessionMemoryIndex,
  pinText: string
) =>
  rebuildMemoryLookup(
    index.sessionId,
    index.entries.filter(
      entry => !(entry.kind === "pin" && entry.text.trim() === pinText.trim())
    )
  );

export const createMessageMemoryInputs = (
  sessionId: string,
  messages: SessionMessage[],
  focus: string[] = []
): SessionMemoryInput[] => {
  const entries: SessionMemoryInput[] = focus
    .filter(note => note.trim().length > 0)
    .map(note => ({
      kind: "pin",
      text: note,
      priority: 100,
      tags: ["pin"],
      entities: {
        topic: tokenizeText(note),
        queryTerms: tokenizeText(note),
      },
      dedupeKey: `pin:${note.trim().toLowerCase()}`,
    }));

  messages.forEach((message, index) => {
    if (message.role === "system") {
      return;
    }

    const kind = message.role === "user" ? "task" : "fact";
    const priority = message.role === "user" ? 80 : 40;
    entries.push({
      kind,
      text: message.text,
      priority,
      createdAt: message.createdAt,
      sourceMessageRange: { start: index, end: index },
      entities: {
        queryTerms: tokenizeText(message.text),
        path: collectPathCandidates(message.text),
        toolName: collectToolNames(message.text),
      },
    });
  });

  void sessionId;
  return entries;
};

const normalizeMemoryText = (entry: SessionMemoryEntry) => {
  if (entry.kind === "pin") {
    return entry.text;
  }
  return `[${entry.kind}] ${entry.text}`;
};

const createEmptyWorkingStateSectionMap = (): Record<
  WorkingStateSectionName,
  string[]
> =>
  Object.fromEntries(
    WORKING_STATE_SECTION_ORDER.map(section => [section, [] as string[]])
  ) as Record<WorkingStateSectionName, string[]>;

const buildSearchableSet = (entry: SessionMemoryEntry) =>
  new Set([
    ...entry.tags,
    ...(entry.entities.path ?? []),
    ...(entry.entities.toolName ?? []),
    ...(entry.entities.action ?? []),
    ...(entry.entities.queryTerms ?? []),
  ]);

const buildWorkingStateSignalTokens = (summaryFallback: string) => {
  const parsed = parseWorkingStateSummary(summaryFallback);
  const tokensBySection = createEmptyWorkingStateSectionMap();
  const pathsBySection = createEmptyWorkingStateSectionMap();

  for (const section of WORKING_STATE_SECTION_ORDER) {
    const lines = parsed[section] ?? [];
    const joined = lines.join(" ");
    tokensBySection[section] = tokenizeText(joined, 18);
    pathsBySection[section] = collectPathCandidates(joined);
  }

  return {
    parsed,
    tokensBySection,
    pathsBySection,
    allTokens: Array.from(
      new Set(
        WORKING_STATE_SECTION_ORDER.flatMap(section => tokensBySection[section])
      )
    ).slice(0, 24),
    allPaths: Array.from(
      new Set(
        WORKING_STATE_SECTION_ORDER.flatMap(section => pathsBySection[section])
      )
    ).slice(0, 12),
  };
};

const isConstraintLikeEntry = (entry: SessionMemoryEntry) =>
  entry.kind === "error" || CONSTRAINT_SIGNAL.test(entry.text);

const isFailureLikeEntry = (entry: SessionMemoryEntry) =>
  entry.kind === "error" ||
  entry.entities.status?.includes("error") === true ||
  entry.entities.status?.includes("rejected") === true ||
  FAILURE_SIGNAL.test(entry.text);

const isCompletedLikeEntry = (entry: SessionMemoryEntry) =>
  entry.kind === "tool_result" ||
  entry.entities.status?.includes("ok") === true ||
  entry.entities.status?.includes("approved") === true ||
  COMPLETED_SIGNAL.test(entry.text);

const formatArchiveSectionItem = (
  section: WorkingStateSectionName,
  entry: SessionMemoryEntry
) => {
  if (
    section === "OBJECTIVE" ||
    section === "REMAINING" ||
    section === "NEXT BEST ACTIONS"
  ) {
    if (entry.kind === "task") {
      return clipText(entry.text, 180);
    }
  }
  return normalizeMemoryText(entry);
};

const flattenArchiveSections = (sections: WorkingStateSectionMap) =>
  WORKING_STATE_SECTION_ORDER.flatMap(section =>
    (sections[section] ?? []).map(item => `[${section}] ${item}`)
  );

const buildAgeRankById = (entries: SessionMemoryEntry[]) =>
  new Map(entries.map((entry, index) => [entry.id, index] as const));

const scoreEntryForArchiveSection = (
  entry: SessionMemoryEntry,
  section: WorkingStateSectionName,
  queryTokens: string[],
  queryPaths: string[],
  workingStateSignals: ReturnType<typeof buildWorkingStateSignalTokens>,
  ageRankById: Map<string, number>
) => {
  const searchable = buildSearchableSet(entry);
  const lowerText = entry.text.toLowerCase();
  let score = entry.priority + Math.min(entry.hitCount ?? 1, 5) * 2;
  const ageRank = ageRankById.get(entry.id) ?? 0;

  score += tokenMatchScore(searchable, lowerText, queryTokens, 60, 25);
  score += tokenMatchScore(
    searchable,
    lowerText,
    workingStateSignals.allTokens,
    12,
    6
  );
  score += tokenMatchScore(
    searchable,
    lowerText,
    workingStateSignals.tokensBySection[section],
    24,
    10
  );

  score += overlapScore(entry.entities.path, queryPaths, 80);
  score += overlapScore(entry.entities.path, workingStateSignals.allPaths, 18);
  score += overlapScore(
    entry.entities.path,
    workingStateSignals.pathsBySection[section],
    40
  );
  score -= Math.floor(ageRank / 18) * 6;
  if (ageRank > 72) {
    score -= 10;
  }
  if ((entry.entities.path?.length ?? 0) > 0 || (entry.hitCount ?? 1) >= 3) {
    score += 8;
  }

  switch (section) {
    case "OBJECTIVE":
      if (entry.kind === "task") {
        score += 90;
      }
      if (entry.kind === "fact") {
        score += 20;
      }
      break;
    case "CONFIRMED FACTS":
      if (entry.kind === "fact") {
        score += 80;
      }
      if (entry.kind === "tool_result" || entry.kind === "approval") {
        score += 70;
      }
      if (isFailureLikeEntry(entry)) {
        score -= 25;
      }
      break;
    case "CONSTRAINTS":
      if (isConstraintLikeEntry(entry)) {
        score += 100;
      } else {
        score -= 25;
      }
      break;
    case "COMPLETED":
      if (isCompletedLikeEntry(entry)) {
        score += 110;
      } else {
        score -= 25;
      }
      break;
    case "REMAINING":
      if (entry.kind === "task") {
        score += 95;
      }
      if (isFailureLikeEntry(entry)) {
        score += 20;
      }
      if (isCompletedLikeEntry(entry)) {
        score -= 20;
      }
      break;
    case "KNOWN PATHS":
      if ((entry.entities.path?.length ?? 0) > 0) {
        score += 120;
      } else {
        score -= 60;
      }
      break;
    case "RECENT FAILURES":
      if (isFailureLikeEntry(entry)) {
        score += 120;
      } else {
        score -= 30;
      }
      break;
    case "NEXT BEST ACTIONS":
      if (entry.kind === "task") {
        score += 85;
      }
      if (isConstraintLikeEntry(entry) || isFailureLikeEntry(entry)) {
        score += 15;
      }
      if (isCompletedLikeEntry(entry)) {
        score -= 15;
      }
      break;
  }

  return score;
};

const selectArchiveEntriesForSection = (
  entries: SessionMemoryEntry[],
  section: WorkingStateSectionName,
  queryTokens: string[],
  queryPaths: string[],
  workingStateSignals: ReturnType<typeof buildWorkingStateSignalTokens>,
  ageRankById: Map<string, number>,
  limit = DEFAULT_ARCHIVE_SECTION_LIMIT
) =>
  entries
    .map(entry => ({
      entry,
      score: scoreEntryForArchiveSection(
        entry,
        section,
        queryTokens,
        queryPaths,
        workingStateSignals,
        ageRankById
      ),
    }))
    .filter(item => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.entry.createdAt.localeCompare(left.entry.createdAt);
    })
    .slice(0, limit)
    .map(item => formatArchiveSectionItem(section, item.entry));

const selectKnownPathsForArchive = (
  entries: SessionMemoryEntry[],
  queryTokens: string[],
  queryPaths: string[],
  workingStateSignals: ReturnType<typeof buildWorkingStateSignalTokens>,
  ageRankById: Map<string, number>,
  limit = KNOWN_PATH_ARCHIVE_LIMIT
) => {
  const scoredPaths = new Map<string, number>();

  for (const entry of entries) {
    const paths = entry.entities.path ?? [];
    if (paths.length === 0) {
      continue;
    }

    const entryScore = scoreEntryForArchiveSection(
      entry,
      "KNOWN PATHS",
      queryTokens,
      queryPaths,
      workingStateSignals,
      ageRankById
    );

    for (const path of paths) {
      const nextScore =
        entryScore +
        (queryPaths.includes(path) ? 80 : 0) +
        (workingStateSignals.allPaths.includes(path) ? 30 : 0) +
        (workingStateSignals.pathsBySection["KNOWN PATHS"].includes(path) ? 40 : 0);
      const previous = scoredPaths.get(path) ?? Number.NEGATIVE_INFINITY;
      if (nextScore > previous) {
        scoredPaths.set(path, nextScore);
      }
    }
  }

  return [...scoredPaths.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([path]) => path);
};

export const getPromptContextFromMemoryIndex = (
  index: SessionMemoryIndex,
  query: string,
  recent: SessionMessage[],
  summaryFallback: string,
  relevantLimit = 6
): SessionPromptContext => {
  const queryTokens = tokenizeText(query);
  const queryPaths = collectPathCandidates(query);
  const workingStateSignals = buildWorkingStateSignalTokens(summaryFallback);
  const pins = sortEntriesByPriorityAndTime(index.entries)
    .filter(entry => entry.kind === "pin")
    .slice(0, 6)
    .map(entry => entry.text);

  const nonPinEntries = sortEntriesByTime(index.entries).filter(
    entry => entry.kind !== "pin"
  );
  const ageRankById = buildAgeRankById(nonPinEntries);

  const archiveSections = WORKING_STATE_SECTION_ORDER.reduce<WorkingStateSectionMap>(
    (sections, section) => {
      if (section === "KNOWN PATHS") {
        const paths = selectKnownPathsForArchive(
          nonPinEntries,
          queryTokens,
          queryPaths,
          workingStateSignals,
          ageRankById
        );
        if (paths.length > 0) {
          sections[section] = paths;
        }
        return sections;
      }

      const limit =
        section === "OBJECTIVE" ? 1 : DEFAULT_ARCHIVE_SECTION_LIMIT;
      const items = selectArchiveEntriesForSection(
        nonPinEntries,
        section,
        queryTokens,
        queryPaths,
        workingStateSignals,
        ageRankById,
        limit
      );

      if (items.length > 0) {
        sections[section] = items;
      }

      return sections;
    },
    {}
  );

  const relevantMemories = flattenArchiveSections(archiveSections).slice(
    0,
    relevantLimit * 2
  );

  return {
    pins,
    relevantMemories,
    archiveSections,
    recent,
    summaryFallback,
  };
};
