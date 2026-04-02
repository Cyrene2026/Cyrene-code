export type ChatRole = "user" | "assistant" | "system";

export type ChatItemKind =
  | "transcript"
  | "tool_status"
  | "review_status"
  | "system_hint"
  | "error";

export type ChatTone = "neutral" | "success" | "warning" | "danger" | "info";

export type ChatItem = {
  role: ChatRole;
  text: string;
  kind?: ChatItemKind;
  tone?: ChatTone;
  color?:
    | "red"
    | "green"
    | "yellow"
    | "cyan"
    | "white"
    | "gray"
    | "blue"
    | "magenta";
};

export type ChatStatus = "idle" | "streaming" | "error";
