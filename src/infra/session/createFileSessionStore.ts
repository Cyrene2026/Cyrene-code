import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compressContext } from "../../core/session/contextCompression";
import { getCyreneConfigDir, resolveAmbientAppRoot } from "../config/appRoot";
import {
  createEmptyMemoryIndex,
  createMessageMemoryInputs,
  deriveFocusFromMemoryIndex,
  getPromptContextFromMemoryIndex,
  rebuildMemoryLookup,
  removePinMemoryEntry,
  upsertMemoryEntries,
  type SessionMemoryEntry,
  type SessionMemoryIndex,
  type SessionMemoryInput,
} from "../../core/session/memoryIndex";
import {
  deriveReducerMode,
  sanitizeStoredWorkingState,
} from "../../core/session/stateReducer";
import type { SessionStore } from "../../core/session/store";
import type {
  SessionInFlightTurn,
  SessionListItem,
  SessionMessage,
  SessionRecord,
  SessionStateUpdateDiagnostic,
} from "../../core/session/types";

type SessionStoreContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  createdAt: z.string(),
});

const inFlightTurnSchema: z.ZodType<SessionInFlightTurn> = z.object({
  userText: z.string(),
  assistantText: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
});

const stateUpdateDiagnosticSchema: z.ZodType<SessionStateUpdateDiagnostic> = z.object({
  code: z.enum([
    "disabled",
    "missing_tag",
    "incomplete_tag",
    "empty_payload",
    "invalid_payload",
    "applied",
    "applied_empty_state",
  ]),
  message: z.string(),
  updatedAt: z.string(),
  reducerMode: z
    .enum(["digest_only", "merge_and_digest", "full_rebuild_and_digest"])
    .optional(),
  summaryLength: z.number(),
  pendingDigestLength: z.number(),
});

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  summary: z.string().optional(),
  pendingDigest: z.string().optional(),
  lastStateUpdate: stateUpdateDiagnosticSchema.nullable().optional(),
  inFlightTurn: inFlightTurnSchema.nullable().optional(),
  focus: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  messages: z.array(messageSchema),
});

const memoryEntrySchema: z.ZodType<SessionMemoryEntry> = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(["pin", "task", "tool_result", "approval", "error", "fact"]),
  text: z.string(),
  priority: z.number(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  sourceMessageRange: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
  tags: z.array(z.string()),
  entities: z.object({
    path: z.array(z.string()).optional(),
    toolName: z.array(z.string()).optional(),
    action: z.array(z.string()).optional(),
    topic: z.array(z.string()).optional(),
    status: z.array(z.string()).optional(),
    queryTerms: z.array(z.string()).optional(),
  }),
  dedupeKey: z.string().optional(),
  hitCount: z.number().optional(),
});

const memoryIndexSchema: z.ZodType<SessionMemoryIndex> = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  updatedAt: z.string(),
  entries: z.array(memoryEntrySchema),
  byKind: z.record(z.array(z.string())),
  byPath: z.record(z.array(z.string())),
  byTool: z.record(z.array(z.string())),
  byAction: z.record(z.array(z.string())),
  byPriority: z.array(z.string()),
});

const sanitizeTitle = (title: string) => {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "New session";
  }
  if (normalized.length <= 60) {
    return normalized;
  }
  return `${normalized.slice(0, 60)}...`;
};

const normalizeTag = (tag: string) =>
  tag
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

const normalizeTagSet = (tags: string[]) =>
  Array.from(
    new Set(
      tags
        .map(normalizeTag)
        .filter(Boolean)
    )
  );

const fileNameFor = (id: string) => `${id}.json`;
const indexFileNameFor = (id: string) => `${id}.index.json`;

const isSessionDataFile = (fileName: string) =>
  fileName.endsWith(".json") && !fileName.endsWith(".index.json");

const deriveWorkingStateAllowedPaths = (index: SessionMemoryIndex) => {
  const allowed = new Set<string>();

  for (const entry of index.entries) {
    if (entry.kind === "fact") {
      continue;
    }
    for (const path of entry.entities.path ?? []) {
      allowed.add(path);
    }
  }

  return allowed;
};

export const createFileSessionStore = (
  sessionDir?: string,
  context?: SessionStoreContext
): SessionStore => {
  const resolvedSessionDir =
    sessionDir ??
    join(getCyreneConfigDir(resolveAmbientAppRoot(context)), "session");

  const ensureDir = async () => {
    await mkdir(resolvedSessionDir, { recursive: true });
  };

  const getSessionPath = (id: string) => join(resolvedSessionDir, fileNameFor(id));
  const getIndexPath = (id: string) => join(resolvedSessionDir, indexFileNameFor(id));

  const readSession = async (id: string): Promise<SessionRecord | null> => {
    await ensureDir();
    try {
      const content = await readFile(getSessionPath(id), "utf8");
      const parsed = JSON.parse(content) as unknown;
      const normalized = sessionSchema.parse(parsed);
      return {
        ...normalized,
        summary: normalized.summary ?? "",
        pendingDigest: normalized.pendingDigest ?? "",
        lastStateUpdate: normalized.lastStateUpdate ?? null,
        inFlightTurn: normalized.inFlightTurn ?? null,
        focus: normalized.focus ?? [],
        tags: normalizeTagSet(normalized.tags ?? []),
      };
    } catch {
      return null;
    }
  };

  const writeSession = async (session: SessionRecord) => {
    await ensureDir();
    await writeFile(getSessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
  };

  const readMemoryIndex = async (id: string): Promise<SessionMemoryIndex | null> => {
    await ensureDir();
    try {
      const content = await readFile(getIndexPath(id), "utf8");
      const parsed = JSON.parse(content) as unknown;
      return memoryIndexSchema.parse(parsed);
    } catch {
      return null;
    }
  };

  const writeMemoryIndex = async (index: SessionMemoryIndex) => {
    await ensureDir();
    await writeFile(getIndexPath(index.sessionId), JSON.stringify(index, null, 2), "utf8");
  };

  const syncSessionCaches = (session: SessionRecord, index: SessionMemoryIndex): SessionRecord => {
    const normalizedWorkingState = sanitizeStoredWorkingState({
      summary: session.summary,
      pendingDigest: session.pendingDigest,
      allowedPaths: deriveWorkingStateAllowedPaths(index),
    });

    return {
      ...session,
      summary: normalizedWorkingState.summary,
      pendingDigest: normalizedWorkingState.pendingDigest,
      lastStateUpdate: session.lastStateUpdate ?? null,
      focus: deriveFocusFromMemoryIndex(index),
    };
  };

  const rebuildForSession = async (session: SessionRecord) => {
    const rebuiltIndex = upsertMemoryEntries(
      createEmptyMemoryIndex(session.id),
      createMessageMemoryInputs(session.id, session.messages, session.focus)
    );
    const nextSession = syncSessionCaches(session, rebuiltIndex);
    await writeMemoryIndex(rebuiltIndex);
    await writeSession(nextSession);
    return {
      session: nextSession,
      index: rebuiltIndex,
    };
  };

  const ensureSessionWithIndex = async (id: string) => {
    const session = await readSession(id);
    if (!session) {
      return null;
    }

    const index = await readMemoryIndex(id);
    if (index) {
      const sanitizedIndex = rebuildMemoryLookup(
        index.sessionId,
        index.entries,
        index.updatedAt
      );
      const indexChanged =
        JSON.stringify(sanitizedIndex) !== JSON.stringify(index);
      const nextSession = syncSessionCaches(session, sanitizedIndex);
      if (
        indexChanged ||
        nextSession.summary !== session.summary ||
        JSON.stringify(nextSession.focus) !== JSON.stringify(session.focus)
      ) {
        if (indexChanged) {
          await writeMemoryIndex(sanitizedIndex);
        }
        await writeSession(nextSession);
      }
      return {
        session: nextSession,
        index: sanitizedIndex,
      };
    }

    return rebuildForSession(session);
  };

  const persistWithIndex = async (session: SessionRecord, index: SessionMemoryIndex) => {
    const nextSession = syncSessionCaches(session, index);
    await writeMemoryIndex(index);
    await writeSession(nextSession);
    return nextSession;
  };

  const scoreSessionQuery = (session: SessionRecord, normalizedQuery: string) => {
    if (!normalizedQuery) {
      return 1;
    }
    const query = normalizedQuery.toLowerCase();
    let score = 0;
    if (session.id.toLowerCase().includes(query)) {
      score += 6;
    }
    if (session.title.toLowerCase().includes(query)) {
      score += 10;
    }
    if (session.summary.toLowerCase().includes(query)) {
      score += 5;
    }
    if (session.pendingDigest.toLowerCase().includes(query)) {
      score += 4;
    }
    if (session.tags.some(tag => tag.toLowerCase().includes(query))) {
      score += 8;
    }
    if (session.focus.some(note => note.toLowerCase().includes(query))) {
      score += 4;
    }
    if (session.messages.some(message => message.text.toLowerCase().includes(query))) {
      score += 2;
    }
    return score;
  };

  const recordMemoriesInternal = async (id: string, entries: SessionMemoryInput[]) => {
    const loaded = await ensureSessionWithIndex(id);
    if (!loaded) {
      throw new Error(`Session not found: ${id}`);
    }
    if (entries.length === 0) {
      return loaded.session;
    }
    const nextIndex = upsertMemoryEntries(loaded.index, entries);
    return persistWithIndex(
      {
        ...loaded.session,
        updatedAt: new Date().toISOString(),
      },
      nextIndex
    );
  };

  return {
    createSession: async title => {
      const now = new Date().toISOString();
      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const session: SessionRecord = {
        id,
        title: sanitizeTitle(title ?? "New session"),
        createdAt: now,
        updatedAt: now,
        summary: "",
        pendingDigest: "",
        lastStateUpdate: null,
        inFlightTurn: null,
        focus: [],
        tags: [],
        messages: [],
      };
      const index = createEmptyMemoryIndex(id, now);
      await writeSession(session);
      await writeMemoryIndex(index);
      return session;
    },
    listSessions: async () => {
      await ensureDir();
      const files = await readdir(resolvedSessionDir, { withFileTypes: true });
      const items: SessionListItem[] = [];

      for (const file of files) {
        if (!file.isFile() || !isSessionDataFile(file.name)) {
          continue;
        }
        const id = file.name.replace(/\.json$/, "");
        const loaded = await ensureSessionWithIndex(id);
        if (!loaded) {
          continue;
        }
        items.push({
          id: loaded.session.id,
          title: loaded.session.title,
          updatedAt: loaded.session.updatedAt,
          tags: [...loaded.session.tags],
        });
      }

      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    searchSessions: async (query, options) => {
      await ensureDir();
      const files = await readdir(resolvedSessionDir, { withFileTypes: true });
      const normalizedQuery = query.trim().toLowerCase();
      const normalizedTag = options?.tag ? normalizeTag(options.tag) : "";
      const scored: Array<{ item: SessionListItem; score: number }> = [];

      for (const file of files) {
        if (!file.isFile() || !isSessionDataFile(file.name)) {
          continue;
        }
        const id = file.name.replace(/\.json$/, "");
        const loaded = await ensureSessionWithIndex(id);
        if (!loaded) {
          continue;
        }
        const session = loaded.session;
        if (normalizedTag && !session.tags.includes(normalizedTag)) {
          continue;
        }
        const score = scoreSessionQuery(session, normalizedQuery);
        if (score <= 0) {
          continue;
        }
        scored.push({
          item: {
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            tags: [...session.tags],
          },
          score,
        });
      }

      const sorted = scored
        .sort((left, right) => {
          if (left.score !== right.score) {
            return right.score - left.score;
          }
          return right.item.updatedAt.localeCompare(left.item.updatedAt);
        })
        .map(entry => entry.item);

      const limit = options?.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
      return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
    },
    loadSession: async id => {
      const loaded = await ensureSessionWithIndex(id);
      return loaded?.session ?? null;
    },
    appendMessage: async (id, message) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }

      const validated = messageSchema.parse(message) as SessionMessage;
      const nextMessages = [...loaded.session.messages, validated];
      const nextSession: SessionRecord = {
        ...loaded.session,
        messages: nextMessages,
        updatedAt: new Date().toISOString(),
        summary: loaded.session.summary,
        title:
          loaded.session.messages.length === 0 && validated.role === "user"
            ? sanitizeTitle(validated.text)
            : loaded.session.title,
      };

      const memoryInputs =
        validated.role === "system"
          ? []
          : createMessageMemoryInputs(id, [validated]).map(input => ({
              ...input,
              sourceMessageRange: {
                start: nextMessages.length - 1,
                end: nextMessages.length - 1,
              },
            }));

      const nextIndex =
        memoryInputs.length > 0
          ? upsertMemoryEntries(loaded.index, memoryInputs)
          : rebuildMemoryLookup(loaded.index.sessionId, loaded.index.entries);

      return persistWithIndex(nextSession, nextIndex);
    },
    updateSummary: async (id, summary) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const next: SessionRecord = {
        ...loaded.session,
        summary: summary.trim(),
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
    updateWorkingState: async (id, state) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const next = syncSessionCaches(
        {
          ...loaded.session,
          summary:
            typeof state.summary === "string"
              ? state.summary.trim()
              : loaded.session.summary,
          pendingDigest:
            typeof state.pendingDigest === "string"
              ? state.pendingDigest.trim()
              : loaded.session.pendingDigest,
          lastStateUpdate:
            state.lastStateUpdate === undefined
              ? loaded.session.lastStateUpdate
              : state.lastStateUpdate,
          updatedAt: new Date().toISOString(),
        },
        loaded.index
      );
      await writeSession(next);
      return next;
    },
    updateInFlightTurn: async (id, inFlightTurn) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const next: SessionRecord = {
        ...loaded.session,
        inFlightTurn,
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
    addFocus: async (id, note) => {
      const normalized = note.replace(/\s+/g, " ").trim();
      if (!normalized) {
        const loaded = await ensureSessionWithIndex(id);
        if (!loaded) {
          throw new Error(`Session not found: ${id}`);
        }
        return loaded.session;
      }
      return recordMemoriesInternal(id, [
        {
          kind: "pin",
          text: normalized,
          priority: 100,
          tags: ["pin"],
          entities: {
            topic: normalized.split(/\s+/).slice(0, 4),
            queryTerms: normalized.split(/\s+/).slice(0, 8),
          },
          dedupeKey: `pin:${normalized.toLowerCase()}`,
        },
      ]);
    },
    removeFocus: async (id, index) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const currentFocus = deriveFocusFromMemoryIndex(loaded.index);
      if (index < 0 || index >= currentFocus.length) {
        return loaded.session;
      }
      const target = currentFocus[index];
      if (!target) {
        return loaded.session;
      }
      const nextIndex = removePinMemoryEntry(loaded.index, target);
      return persistWithIndex(
        {
          ...loaded.session,
          updatedAt: new Date().toISOString(),
        },
        nextIndex
      );
    },
    addTag: async (id, tag) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const normalized = normalizeTag(tag);
      if (!normalized) {
        return loaded.session;
      }
      if (loaded.session.tags.includes(normalized)) {
        return loaded.session;
      }
      const next: SessionRecord = {
        ...loaded.session,
        tags: [...loaded.session.tags, normalized],
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
    removeTag: async (id, tag) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const normalized = normalizeTag(tag);
      if (!normalized || !loaded.session.tags.includes(normalized)) {
        return loaded.session;
      }
      const next: SessionRecord = {
        ...loaded.session,
        tags: loaded.session.tags.filter(item => item !== normalized),
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
    getMemoryIndex: async id => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      return loaded.index;
    },
    recordMemory: async (id, entry) => recordMemoriesInternal(id, [entry]),
    recordMemories: async (id, entries) => recordMemoriesInternal(id, entries),
    rebuildMemoryIndex: async id => {
      const session = await readSession(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }
      return (await rebuildForSession(session)).session;
    },
    getPromptContext: async (id, query) => {
      const loaded = await ensureSessionWithIndex(id);
      if (!loaded) {
        throw new Error(`Session not found: ${id}`);
      }
      const compressed = compressContext(loaded.session.messages);
      const durableSummary = loaded.session.summary.trim();
      const pendingDigest = loaded.session.pendingDigest.trim();
      const summaryFallback = durableSummary || compressed.summary;
      const priorMessages = loaded.session.messages.filter(
        message => message.role !== "system"
      );
      const priorAssistantMessages = priorMessages.filter(
        message => message.role === "assistant"
      );
      return getPromptContextFromMemoryIndex(
        loaded.index,
        query,
        compressed.recent,
        {
          durableSummary,
          summaryFallback,
          pendingDigest,
          reducerMode: deriveReducerMode({
            enabled: true,
            durableSummary,
            pendingDigest,
            priorMessageCount: priorMessages.length,
            priorAssistantMessageCount: priorAssistantMessages.length,
          }),
          summaryRecoveryNeeded:
            !durableSummary &&
            !pendingDigest &&
            priorAssistantMessages.length > 0,
          interruptedTurn: loaded.session.inFlightTurn,
        }
      );
    },
  };
};
