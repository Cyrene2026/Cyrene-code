import type { ChatRole } from "../../shared/types/chat";

export type SessionMessage = {
  role: ChatRole;
  text: string;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  focus: string[];
  messages: SessionMessage[];
};

export type SessionListItem = {
  id: string;
  title: string;
  updatedAt: string;
};
