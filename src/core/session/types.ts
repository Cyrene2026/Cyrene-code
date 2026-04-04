import type { ChatRole } from "../../shared/types/chat";
import type { ReducerMode } from "./stateReducer";

export type SessionMessage = {
  role: ChatRole;
  text: string;
  createdAt: string;
};

export type SessionInFlightTurn = {
  userText: string;
  assistantText: string;
  startedAt: string;
  updatedAt: string;
};

export type SessionStateUpdateDiagnosticCode =
  | "disabled"
  | "missing_tag"
  | "incomplete_tag"
  | "empty_payload"
  | "invalid_payload"
  | "applied"
  | "applied_empty_state";

export type SessionStateUpdateDiagnostic = {
  code: SessionStateUpdateDiagnosticCode;
  message: string;
  updatedAt: string;
  reducerMode?: Exclude<ReducerMode, "disabled">;
  summaryLength: number;
  pendingDigestLength: number;
};

export type SessionRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  pendingDigest: string;
  lastStateUpdate: SessionStateUpdateDiagnostic | null;
  inFlightTurn: SessionInFlightTurn | null;
  focus: string[];
  tags: string[];
  messages: SessionMessage[];
};

export type SessionListItem = {
  id: string;
  title: string;
  updatedAt: string;
  tags: string[];
};
