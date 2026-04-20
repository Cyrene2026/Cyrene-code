import type { ChatRole } from "../../shared/types/chat";
import type { ReducerMode } from "./stateReducer";

export type SessionMessageKind =
  | "transcript"
  | "tool_status"
  | "review_status"
  | "system_hint"
  | "error";

export type SessionMessage = {
  role: ChatRole;
  text: string;
  createdAt: string;
  kind?: SessionMessageKind;
};

export type SessionInFlightTurn = {
  userText: string;
  assistantText: string;
  committedVisibleText?: string;
  startedAt: string;
  updatedAt: string;
};

export type SessionPendingChoiceOption = {
  index: number;
  label: string;
};

export type SessionPendingChoice = {
  capturedAt: string;
  sourcePreview: string;
  options: SessionPendingChoiceOption[];
};

export type SessionExecutionPlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked";

export type SessionExecutionPlanStep = {
  id: string;
  title: string;
  details: string;
  status: SessionExecutionPlanStepStatus;
  evidence: string[];
  filePaths: string[];
  recentToolResult: string;
};

export type SessionExecutionPlan = {
  capturedAt: string;
  sourcePreview: string;
  projectRoot: string;
  summary: string;
  objective: string;
  acceptedAt: string;
  acceptedSummary: string;
  steps: SessionExecutionPlanStep[];
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
  projectRoot: string | null;
  summary: string;
  pendingDigest: string;
  pendingChoice: SessionPendingChoice | null;
  executionPlan: SessionExecutionPlan | null;
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
  projectRoot?: string | null;
  tags: string[];
};
