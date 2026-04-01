export type ChatRole = "user" | "assistant" | "system";

export type ChatItem = {
  role: ChatRole;
  text: string;
};

export type ChatStatus = "idle" | "streaming" | "error";
