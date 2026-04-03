import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compressContext } from "../../core/session/contextCompression";
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
import type { SessionStore } from "../../core/session/store";
import type {
  SessionListItem,
  SessionMessage,
  SessionRecord,
} from "../../core/session/types";

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  createdAt: z.string(),
});

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  summary: z.string().optional(),
  focus: z.array(z.string()).optional(),
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

const fileNameFor = (id: string) => `${id}.json`;
const indexFileNameFor = (id: string) => `${id}.index.json`;

const isSessionDataFile = (fileName: string) =>
  fileName.endsWith(".json") && !fileName.endsWith(".index.json");

export const createFileSessionStore = (
  sessionDir = join(process.cwd(), ".cyrene", "session")
): SessionStore => {
  const ensureDir = async () => {
    await mkdir(sessionDir, { recursive: true });
  };

  const getSessionPath = (id: string) => join(sessionDir, fileNameFor(id));
  const getIndexPath = (id: string) => join(sessionDir, indexFileNameFor(id));

  const readSession = async (id: string): Promise<SessionRecord | null> => {
    await ensureDir();
    try {
      const content = await readFile(getSessionPath(id), "utf8");
      const parsed = JSON.parse(content) as unknown;
      const normalized = sessionSchema.parse(parsed);
      return {
        ...normalized,
        summary: normalized.summary ?? "",
        focus: normalized.focus ?? [],
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
    return {
      ...session,
      summary: session.summary.trim(),
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
      const nextSession = syncSessionCaches(session, index);
      if (
        nextSession.summary !== session.summary ||
        JSON.stringify(nextSession.focus) !== JSON.stringify(session.focus)
      ) {
        await writeSession(nextSession);
      }
      return {
        session: nextSession,
        index,
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
        focus: [],
        messages: [],
      };
      const index = createEmptyMemoryIndex(id, now);
      await writeSession(session);
      await writeMemoryIndex(index);
      return session;
    },
    listSessions: async () => {
      await ensureDir();
      const files = await readdir(sessionDir, { withFileTypes: true });
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
        });
      }

      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
        summary:
          validated.role === "system"
            ? loaded.session.summary
            : "",
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
      return getPromptContextFromMemoryIndex(
        loaded.index,
        query,
        compressed.recent,
        loaded.session.summary.trim() || compressed.summary
      );
    },
  };
};
