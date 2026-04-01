import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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
  summary: z.string(),
  focus: z.array(z.string()).optional(),
  messages: z.array(messageSchema),
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

export const createFileSessionStore = (
  sessionDir = join(process.cwd(), ".cyrene", "session")
): SessionStore => {
  const ensureDir = async () => {
    await mkdir(sessionDir, { recursive: true });
  };

  const readSession = async (id: string): Promise<SessionRecord | null> => {
    await ensureDir();
    const path = join(sessionDir, fileNameFor(id));
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const normalized = sessionSchema.parse(parsed);
      return {
        ...normalized,
        focus: normalized.focus ?? [],
      };
    } catch {
      return null;
    }
  };

  const writeSession = async (session: SessionRecord) => {
    await ensureDir();
    const path = join(sessionDir, fileNameFor(session.id));
    await writeFile(path, JSON.stringify(session, null, 2), "utf8");
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
      await writeSession(session);
      return session;
    },
    listSessions: async () => {
      await ensureDir();
      const files = await readdir(sessionDir, { withFileTypes: true });
      const items: SessionListItem[] = [];

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) {
          continue;
        }
        const id = file.name.replace(/\.json$/, "");
        const session = await readSession(id);
        if (!session) {
          continue;
        }
        items.push({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
        });
      }

      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    loadSession: async id => readSession(id),
    appendMessage: async (id, message) => {
      const session = await readSession(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }

      const validated = messageSchema.parse(message) as SessionMessage;
      const next: SessionRecord = {
        ...session,
        messages: [...session.messages, validated],
        updatedAt: new Date().toISOString(),
        title:
          session.messages.length === 0 && validated.role === "user"
            ? sanitizeTitle(validated.text)
            : session.title,
      };
      await writeSession(next);
      return next;
    },
    updateSummary: async (id, summary) => {
      const session = await readSession(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }
      const next: SessionRecord = {
        ...session,
        summary: summary.trim(),
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
    addFocus: async (id, note) => {
      const session = await readSession(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }
      const normalized = note.replace(/\s+/g, " ").trim();
      if (!normalized) {
        return session;
      }
      const deduped = Array.from(new Set([normalized, ...session.focus])).slice(
        0,
        6
      );
      const next: SessionRecord = {
        ...session,
        focus: deduped,
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
    removeFocus: async (id, index) => {
      const session = await readSession(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }
      if (index < 0 || index >= session.focus.length) {
        return session;
      }
      const nextFocus = session.focus.filter((_, i) => i !== index);
      const next: SessionRecord = {
        ...session,
        focus: nextFocus,
        updatedAt: new Date().toISOString(),
      };
      await writeSession(next);
      return next;
    },
  };
};
