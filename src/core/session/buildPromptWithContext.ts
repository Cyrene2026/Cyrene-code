import type { SessionPromptContext } from "./memoryIndex";

export const buildPromptWithContext = (
  query: string,
  systemPrompt: string,
  projectPrompt: string,
  promptContext: SessionPromptContext
) => {
  const recentLines = promptContext.recent
    .filter(message => message.role !== "system")
    .map(message => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n");

  const relevantLines = promptContext.relevantMemories
    .map(item => `- ${item}`)
    .join("\n");

  const pinLines = promptContext.pins
    .map(item => `- ${item}`)
    .join("\n");

  const sections = [
    "SYSTEM PROMPT (highest priority):",
    systemPrompt || "(none)",
    ".CYRENE.MD POLICY (second priority):",
    projectPrompt || "(none)",
    "CONVERSATION CONTEXT:",
    pinLines ? `Pinned memory (third priority):\n${pinLines}` : "Pinned memory:\n(none)",
    relevantLines
      ? `Relevant indexed memory:\n${relevantLines}`
      : promptContext.summaryFallback
        ? `Fallback summary:\n${promptContext.summaryFallback}`
        : "Relevant indexed memory:\n(none)",
    recentLines ? `Recent messages:\n${recentLines}` : "Recent messages:\n(none)",
    `Current user query:\n${query}`,
  ];

  return sections.join("\n\n");
};
