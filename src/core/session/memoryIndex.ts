import type { SessionMessage } from "./types";

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
  recent: SessionMessage[];
  summaryFallback: string;
};

const QUERY_TOKEN_LIMIT = 12;
const MEMORY_TEXT_LIMIT = 420;
const SUMMARY_LINE_LIMIT = 5;

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
          /\b(read_file|list_dir|create_dir|create_file|write_file|edit_file|delete_file|stat_path|find_files|search_text|copy_path|move_path|run_command)\b/gi
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
  [...entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

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
  const sortedEntries = sortEntriesByTime(entries);
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
    byPriority: [...sortedEntries]
      .sort((left, right) => {
        if (right.priority !== left.priority) {
          return right.priority - left.priority;
        }
        return right.createdAt.localeCompare(left.createdAt);
      })
      .map(entry => entry.id),
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
  sortEntriesByTime(index.entries)
    .filter(entry => entry.kind === "pin")
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return right.createdAt.localeCompare(left.createdAt);
    })
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

export const getPromptContextFromMemoryIndex = (
  index: SessionMemoryIndex,
  query: string,
  recent: SessionMessage[],
  summaryFallback: string,
  relevantLimit = 6
): SessionPromptContext => {
  const queryTokens = tokenizeText(query);
  const pins = sortEntriesByTime(index.entries)
    .filter(entry => entry.kind === "pin")
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return right.createdAt.localeCompare(left.createdAt);
    })
    .slice(0, 6)
    .map(entry => entry.text);

  const relevantMemories = sortEntriesByTime(index.entries)
    .filter(entry => entry.kind !== "pin")
    .map(entry => {
      let score = entry.priority;
      const searchable = new Set([
        ...entry.tags,
        ...(entry.entities.path ?? []),
        ...(entry.entities.toolName ?? []),
        ...(entry.entities.action ?? []),
        ...(entry.entities.queryTerms ?? []),
      ]);

      for (const token of queryTokens) {
        if (searchable.has(token)) {
          score += 60;
        } else if (entry.text.toLowerCase().includes(token)) {
          score += 25;
        }
      }

      score += Math.min(entry.hitCount ?? 1, 5) * 2;

      return {
        entry,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.entry.createdAt.localeCompare(left.entry.createdAt);
    })
    .slice(0, relevantLimit)
    .map(item => normalizeMemoryText(item.entry));

  return {
    pins,
    relevantMemories,
    recent,
    summaryFallback,
  };
};
