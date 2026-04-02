import type {
  SessionListItem,
  SessionMessage,
  SessionRecord,
} from "./types";
import type {
  SessionMemoryIndex,
  SessionMemoryInput,
  SessionPromptContext,
} from "./memoryIndex";

export type SessionStore = {
  createSession: (title?: string) => Promise<SessionRecord>;
  listSessions: () => Promise<SessionListItem[]>;
  loadSession: (id: string) => Promise<SessionRecord | null>;
  appendMessage: (id: string, message: SessionMessage) => Promise<SessionRecord>;
  updateSummary: (id: string, summary: string) => Promise<SessionRecord>;
  addFocus: (id: string, note: string) => Promise<SessionRecord>;
  removeFocus: (id: string, index: number) => Promise<SessionRecord>;
  getMemoryIndex: (id: string) => Promise<SessionMemoryIndex>;
  recordMemory: (id: string, entry: SessionMemoryInput) => Promise<SessionRecord>;
  recordMemories: (id: string, entries: SessionMemoryInput[]) => Promise<SessionRecord>;
  rebuildMemoryIndex: (id: string) => Promise<SessionRecord>;
  getPromptContext: (id: string, query: string) => Promise<SessionPromptContext>;
};
