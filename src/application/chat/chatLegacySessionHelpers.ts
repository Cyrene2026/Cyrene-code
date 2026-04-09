import type { SessionRecord } from "../../core/session/types";

export const isLikelyLegacyCompressedMarkdown = (text: string) => {
  if (text.includes("\n")) {
    return false;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  const signalCount = [
    /(^|\s)#{1,6}\s+\S/.test(normalized),
    /```/.test(normalized),
    /\*\*[^*]+\*\*/.test(normalized),
    /(?:^|\s)(?:-|\*|\d+\.)\s+\S/.test(normalized),
    /(?:---|\*\*\*|___)/.test(normalized),
    /\s\.\.\.\s/.test(normalized),
  ].filter(Boolean).length;

  return signalCount >= 2;
};

export const hasLegacyCompressedMarkdown = (session: SessionRecord) =>
  session.messages.some(
    message =>
      message.role === "assistant" &&
      isLikelyLegacyCompressedMarkdown(message.text)
  );
