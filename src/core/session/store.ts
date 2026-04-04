import type {
  SessionInFlightTurn,
  SessionListItem,
  SessionMessage,
  SessionRecord,
  SessionStateUpdateDiagnostic,
} from "./types";
import type {
  SessionMemoryIndex,
  SessionMemoryInput,
  SessionPromptContext,
} from "./memoryIndex";

export type SessionSearchOptions = {
  tag?: string;
  limit?: number;
};

export type SessionStore = {
  createSession: (title?: string) => Promise<SessionRecord>;
  listSessions: () => Promise<SessionListItem[]>;
  searchSessions: (query: string, options?: SessionSearchOptions) => Promise<SessionListItem[]>;
  loadSession: (id: string) => Promise<SessionRecord | null>;
  appendMessage: (id: string, message: SessionMessage) => Promise<SessionRecord>;
  updateSummary: (id: string, summary: string) => Promise<SessionRecord>;
  updateWorkingState: (
    id: string,
    state: {
      summary?: string;
      pendingDigest?: string;
      lastStateUpdate?: SessionStateUpdateDiagnostic | null;
    }
  ) => Promise<SessionRecord>;
  updateInFlightTurn: (
    id: string,
    inFlightTurn: SessionInFlightTurn | null
  ) => Promise<SessionRecord>;
  addFocus: (id: string, note: string) => Promise<SessionRecord>;
  removeFocus: (id: string, index: number) => Promise<SessionRecord>;
  addTag: (id: string, tag: string) => Promise<SessionRecord>;
  removeTag: (id: string, tag: string) => Promise<SessionRecord>;
  getMemoryIndex: (id: string) => Promise<SessionMemoryIndex>;
  recordMemory: (id: string, entry: SessionMemoryInput) => Promise<SessionRecord>;
  recordMemories: (id: string, entries: SessionMemoryInput[]) => Promise<SessionRecord>;
  rebuildMemoryIndex: (id: string) => Promise<SessionRecord>;
  getPromptContext: (id: string, query: string) => Promise<SessionPromptContext>;
};
