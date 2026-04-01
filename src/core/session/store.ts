import type {
  SessionListItem,
  SessionMessage,
  SessionRecord,
} from "./types";

export type SessionStore = {
  createSession: (title?: string) => Promise<SessionRecord>;
  listSessions: () => Promise<SessionListItem[]>;
  loadSession: (id: string) => Promise<SessionRecord | null>;
  appendMessage: (id: string, message: SessionMessage) => Promise<SessionRecord>;
  updateSummary: (id: string, summary: string) => Promise<SessionRecord>;
  addFocus: (id: string, note: string) => Promise<SessionRecord>;
  removeFocus: (id: string, index: number) => Promise<SessionRecord>;
};
