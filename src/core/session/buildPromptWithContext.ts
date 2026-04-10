import type { SessionPromptContext } from "./memoryIndex";
import { buildStateReducerPrompt } from "./stateReducer";
import {
  normalizeWorkingStateSummary,
  WORKING_STATE_SECTION_ORDER,
} from "./workingState";

const PROMPT_RECENT_TAIL_LIMIT = 6;
const PROMPT_RECENT_TEXT_LIMIT = 240;
const LOW_SIGNAL_QUERY_MAX_LENGTH = 24;
const LOW_SIGNAL_QUERY_PATTERN =
  /^(?:ok(?:ay)?|sure|yes|yep|go|go on|continue|continue please|resume|proceed|thanks?|thank you|cool|nice|good|done|start|start now|sounds good|来吧?|继续(?:吧|一下)?|开始吧?|接着|继续搞|继续做|好(?:的)?|行|可以|收到|嗯|搞吧|上吧|来|冲)$/iu;

const isLowSignalContinuationQuery = (query: string) => {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (LOW_SIGNAL_QUERY_PATTERN.test(normalized)) {
    return true;
  }
  return normalized.length <= LOW_SIGNAL_QUERY_MAX_LENGTH && !/[\p{L}\p{N}]/u.test(normalized);
};

const clipPromptLine = (text: string, max = PROMPT_RECENT_TEXT_LIMIT) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
};

export const buildPromptWithContext = (
  query: string,
  systemPrompt: string,
  projectPrompt: string,
  promptContext: SessionPromptContext,
  activeSkillsPrompt = ""
) => {
  const lowSignalContinuation = isLowSignalContinuationQuery(query);
  const recentLines = promptContext.recent
    .filter(message => message.role !== "system")
    .slice(-PROMPT_RECENT_TAIL_LIMIT)
    .map(message => `${message.role.toUpperCase()}: ${clipPromptLine(message.text)}`)
    .join("\n");

  const relevantLines = promptContext.relevantMemories
    .map(item => `- ${item}`)
    .join("\n");

  const pinLines = promptContext.pins
    .map(item => `- ${item}`)
    .join("\n");

  const durableSummary = promptContext.durableSummary.trim()
    ? normalizeWorkingStateSummary(promptContext.durableSummary)
    : "(missing)";
  const pendingDigest = promptContext.pendingDigest.trim()
    ? normalizeWorkingStateSummary(promptContext.pendingDigest)
    : "(none)";
  const fallbackState =
    promptContext.summaryRecoveryNeeded && promptContext.summaryFallback.trim()
      ? normalizeWorkingStateSummary(promptContext.summaryFallback)
      : "";
  const archiveSectionLines = promptContext.archiveSections
    ? WORKING_STATE_SECTION_ORDER.flatMap(section => {
        const items = promptContext.archiveSections?.[section] ?? [];
        if (items.length === 0) {
          return [];
        }
        return [
          `${section}:`,
          ...items.map(item => `- ${item}`),
        ];
      }).join("\n")
    : "";

  const recencyGuardLine =
    lowSignalContinuation &&
    (recentLines || promptContext.pendingDigest.trim() || promptContext.interruptedTurn)
      ? "The current user query is low-information. Continue from the most recent unresolved context first: prioritize the interrupted-turn snapshot, recent transcript tail, and pending turn digest before falling back to the durable summary."
      : "";

  const durableSummarySection = `Working state (durable reducer):\n${durableSummary}`;
  const pendingDigestSection = `Pending turn digest (last completed turn not yet merged):\n${pendingDigest}`;
  const interruptedTurnSection = promptContext.interruptedTurn
    ? `Interrupted prior turn snapshot:\n- user: ${clipPromptLine(promptContext.interruptedTurn.userText)}${
        promptContext.interruptedTurn.assistantText.trim()
          ? `\n- partial assistant: ${clipPromptLine(promptContext.interruptedTurn.assistantText)}`
          : ""
      }\n- status: interrupted before reducer finalized`
    : "Interrupted prior turn snapshot:\n(none)";
  const latestActionableUserRequestSection = promptContext.latestActionableUserMessage.trim()
    ? `Latest actionable user request before this continuation:\n${clipPromptLine(
        promptContext.latestActionableUserMessage
      )}`
    : "Latest actionable user request before this continuation:\n(none)";
  const recentTranscriptSection = recentLines
    ? `Short transcript tail (immediate recency only):\n${recentLines}`
    : "Short transcript tail (immediate recency only):\n(none)";

  const taskStateSections = lowSignalContinuation
    ? [
        recencyGuardLine,
        pendingDigestSection,
        interruptedTurnSection,
        latestActionableUserRequestSection,
        recentTranscriptSection,
        durableSummarySection,
      ].filter(Boolean)
    : [
        durableSummarySection,
        pendingDigestSection,
        interruptedTurnSection,
        recentTranscriptSection,
      ];

  const sections = [
    "SYSTEM PROMPT (highest priority):",
    systemPrompt || "(none)",
    ".CYRENE.MD POLICY (second priority):",
    projectPrompt || "(none)",
    activeSkillsPrompt
      ? `ACTIVE SKILLS (task-scoped guidance):\n${activeSkillsPrompt}`
      : "ACTIVE SKILLS (task-scoped guidance):\n(none)",
    "TASK STATE CONTEXT:",
    "Prefer durable working state and confirmed facts over replaying long transcript history. If something is already listed under COMPLETED, treat it as done unless the current user asks to revisit it or new evidence contradicts it.",
    ...taskStateSections,
    pinLines
      ? `Pinned memory (stable user priorities):\n${pinLines}`
      : "Pinned memory (stable user priorities):\n(none)",
    archiveSectionLines
      ? `Retrieved archive memory (section-aware):\n${archiveSectionLines}`
      : relevantLines
        ? `Retrieved archive memory:\n${relevantLines}`
        : "Retrieved archive memory:\n(none)",
    `Current user query (act on this now):\n${query}`,
    buildStateReducerPrompt({
      mode: promptContext.reducerMode,
      durableSummary: promptContext.durableSummary,
      pendingDigest: promptContext.pendingDigest,
      summaryRecoveryNeeded: promptContext.summaryRecoveryNeeded,
    }),
  ];

  if (fallbackState) {
    sections.splice(
      8,
      0,
      `Local fallback state estimate (non-durable recovery aid):\n${fallbackState}`
    );
  }

  return sections.join("\n\n");
};
