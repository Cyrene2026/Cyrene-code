import type { SessionMessage } from "./types";

const clip = (text: string, max = 220) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
};

export const compressContext = (
  messages: SessionMessage[],
  recentKeep = 10,
  maxBullets = 10
) => {
  const head = messages.slice(0, Math.max(0, messages.length - recentKeep));
  const recent = messages.slice(-recentKeep);

  const bullets = head
    .filter(message => message.role !== "system")
    .slice(-maxBullets)
    .map(message => {
      const prefix = message.role === "user" ? "User" : "Assistant";
      return `- ${prefix}: ${clip(message.text)}`;
    });

  return {
    summary: bullets.join("\n"),
    recent,
  };
};
