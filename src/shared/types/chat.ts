export type ChatRole = "user" | "assistant" | "system";

export type ChatItem = {
  role: ChatRole;
  text: string;
  color?: "red" | "green" | "yellow" | "cyan";
};

export type ChatStatus = "idle" | "streaming" | "error";
