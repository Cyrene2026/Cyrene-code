import type { SessionMessage } from "./types";

export const buildPromptWithContext = (
  query: string,
  systemPrompt: string,
  projectPrompt: string,
  summary: string,
  focus: string[],
  recent: SessionMessage[]
) => {
  const recentLines = recent
    .filter(message => message.role !== "system")
    .map(message => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n");

  const sections = [
    "SYSTEM PROMPT (highest priority):",
    systemPrompt || "(none)",
    ".CYRENE.MD POLICY (second priority):",
    projectPrompt || "(none)",
    "CONVERSATION CONTEXT:",
    focus.length > 0
      ? `Pinned focus (third priority):\n${focus
          .map(item => `- ${item}`)
          .join("\n")}`
      : "Human-selected focus:\n(none)",
    summary ? `Summary:\n${summary}` : "Summary:\n(none)",
    recentLines ? `Recent messages:\n${recentLines}` : "Recent messages:\n(none)",
    `Current user query:\n${query}`,
  ];

  return sections.join("\n\n");
};
