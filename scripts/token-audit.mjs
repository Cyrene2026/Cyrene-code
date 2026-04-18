import { readFile } from "node:fs/promises";
import { buildPromptWithContext } from "../src/core/session/buildPromptWithContext.ts";
import { buildStateReducerPrompt } from "../src/core/session/stateReducer.ts";
import { formatSelectedExtensionsPrompt } from "../src/application/chat/chatMcpSkillsFormatting.ts";
import {
  FILE_TOOL,
  TOOL_USAGE_SYSTEM_PROMPT,
} from "../src/infra/http/createHttpQueryTransport.ts";
import { loadPromptPolicy } from "../src/infra/config/loadPromptPolicy.ts";

const currentDate = new Date().toISOString();

const estimateTokens = text => Math.ceil(text.length / 4);

const formatNumber = value => value.toLocaleString("en-US");

const buildMetric = (name, text) => ({
  name,
  chars: text.length,
  approxTokens: estimateTokens(text),
  lines: text.split(/\r?\n/).length,
});

const extractNumericConstants = async (path, names) => {
  const source = await readFile(path, "utf8");
  const values = {};
  for (const name of names) {
    const match = source.match(
      new RegExp(`const\\s+${name}\\s*=\\s*(\\d+);`)
    );
    values[name] = match ? Number(match[1]) : null;
  }
  return values;
};

const divider = label => {
  console.log(`\n## ${label}`);
};

const printMetrics = metrics => {
  const sorted = [...metrics].sort((left, right) => right.chars - left.chars);
  for (const metric of sorted) {
    console.log(
      `${metric.name.padEnd(34)} chars ${String(metric.chars).padStart(6)} | est tokens ${String(metric.approxTokens).padStart(5)} | lines ${String(metric.lines).padStart(4)}`
    );
  }
};

const printConstants = constants => {
  for (const [name, value] of Object.entries(constants)) {
    const rendered = typeof value === "number" ? formatNumber(value) : "(missing)";
    const tokenEstimate =
      typeof value === "number" ? ` | est tokens ~${formatNumber(estimateTokens("x".repeat(value)))}` : "";
    console.log(`${name.padEnd(36)} ${rendered}${tokenEstimate}`);
  }
};

const repeatSentence = (prefix, count) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}.`).join(" ");

const buildWorkingState = () =>
  [
    "OBJECTIVE:",
    "- Land explicit token auditing and identify the heaviest prompt payloads.",
    "- Keep the audit reproducible from a local script.",
    "",
    "CONFIRMED FACTS:",
    ...Array.from({ length: 10 }, (_, index) =>
      `- Confirmed fact ${index + 1}: ${repeatSentence(
        "The runtime currently carries durable state, tool schema payload, and loop prompts.",
        2
      )}`
    ),
    "",
    "CONSTRAINTS:",
    ...Array.from({ length: 8 }, (_, index) =>
      `- Constraint ${index + 1}: stay inside the existing architecture and avoid changing provider behavior during the audit.`
    ),
    "",
    "COMPLETED:",
    ...Array.from({ length: 10 }, (_, index) =>
      `- Completed item ${index + 1}: inspected prompt assembly and transport payload composition.`
    ),
    "",
    "REMAINING:",
    ...Array.from({ length: 8 }, (_, index) =>
      `- Remaining item ${index + 1}: trim prompt budget and shrink tool schema overhead.`
    ),
    "",
    "KNOWN PATHS:",
    ...Array.from({ length: 10 }, (_, index) =>
      `- src/path-${index + 1}/feature-${index + 1}.ts`
    ),
    "",
    "RECENT FAILURES:",
    ...Array.from({ length: 8 }, (_, index) =>
      `- Failure ${index + 1}: prior attempts relied on intuition instead of measuring serialized payload size.`
    ),
    "",
    "NEXT BEST ACTIONS:",
    ...Array.from({ length: 6 }, (_, index) =>
      `- Action ${index + 1}: reduce static prompt text before tuning model/provider combinations.`
    ),
  ].join("\n");

const buildPendingDigest = () =>
  [
    "OBJECTIVE:",
    "- Continue the token audit from the latest confirmed measurements.",
    "",
    "CONFIRMED FACTS:",
    ...Array.from({ length: 6 }, (_, index) =>
      `- Pending fact ${index + 1}: round prompts can carry tool results and recent mutations at the same time.`
    ),
    "",
    "CONSTRAINTS:",
    ...Array.from({ length: 5 }, (_, index) =>
      `- Pending constraint ${index + 1}: preserve autonomous tool execution while reducing static overhead.`
    ),
    "",
    "COMPLETED:",
    ...Array.from({ length: 5 }, (_, index) =>
      `- Pending completed ${index + 1}: measured the static transport tool prompt and file schema sizes.`
    ),
    "",
    "REMAINING:",
    ...Array.from({ length: 5 }, (_, index) =>
      `- Pending remaining ${index + 1}: decide which instruction blocks can move to local policy instead of model prompt.`
    ),
    "",
    "KNOWN PATHS:",
    ...Array.from({ length: 5 }, (_, index) =>
      `- src/module-${index + 1}/index.ts`
    ),
    "",
    "RECENT FAILURES:",
    ...Array.from({ length: 5 }, (_, index) =>
      `- Pending failure ${index + 1}: large prompt fragments were not isolated by source, making regressions hard to spot.`
    ),
    "",
    "NEXT BEST ACTIONS:",
    ...Array.from({ length: 4 }, (_, index) =>
      `- Pending action ${index + 1}: rank the largest serialized prompt sections by estimated token cost.`
    ),
  ].join("\n");

const buildExecutionPlan = () => ({
  capturedAt: currentDate,
  sourcePreview: "Token audit workstream",
  projectRoot: process.cwd(),
  summary: "Measure prompt and tool payload overhead",
  objective: "Audit prompt/token hotspots and rank the biggest payload sources",
  acceptedAt: "",
  acceptedSummary: "",
  steps: [
    {
      id: "step-1",
      title: "Measure static prompt payload",
      details: "Quantify default system prompt, reducer protocol, and transport tool prompt.",
      status: "completed",
      evidence: [
        "Measured serialized prompt sections.",
        "Measured tool schema payload.",
      ],
      filePaths: [
        "src/core/session/buildPromptWithContext.ts",
        "src/infra/http/createHttpQueryTransport.ts",
      ],
      recentToolResult: "Collected prompt and tool schema character counts.",
    },
    {
      id: "step-2",
      title: "Measure busy-session prompt payload",
      details: "Generate a representative heavy context and compare section sizes.",
      status: "in_progress",
      evidence: [
        "Built synthetic durable summary and pending digest.",
      ],
      filePaths: [
        "src/core/session/memoryIndex.ts",
        "src/core/query/runQuerySession.ts",
      ],
      recentToolResult: "Busy-session sample prompt assembled for comparison.",
    },
    {
      id: "step-3",
      title: "Prioritize reductions",
      details: "Identify the cheapest cuts with the largest token savings.",
      status: "pending",
      evidence: [],
      filePaths: [],
      recentToolResult: "",
    },
  ],
});

const buildRecentMessages = () =>
  Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: repeatSentence(
      index % 2 === 0
        ? "User requested another focused change without wanting repeated exploration."
        : "Assistant reported concrete implementation progress and referenced confirmed files.",
      5
    ),
    createdAt: currentDate,
  }));

const buildBusyPromptContext = () => ({
  pins: Array.from({ length: 6 }, (_, index) =>
    `Pinned priority ${index + 1}: keep token cost visible and prefer local logic over extra prompt text.`
  ),
  relevantMemories: [],
  archiveSections: {
    OBJECTIVE: [
      "Audit prompt and tool payload overhead with reproducible local measurements.",
    ],
    "CONFIRMED FACTS": [
      "The business prompt includes execution plan, durable state, pending digest, recent transcript, and reducer protocol.",
      "The transport request always includes a large file tool schema and a long tool-usage system prompt.",
    ],
    CONSTRAINTS: [
      "Do not remove necessary tool-safety behavior while auditing token overhead.",
    ],
    COMPLETED: [
      "Measured baseline prompt sections and tool schema size.",
    ],
    REMAINING: [
      "Reduce the largest static payloads first.",
    ],
    "KNOWN PATHS": [
      "src/core/session/buildPromptWithContext.ts",
      "src/core/query/runQuerySession.ts",
      "src/infra/http/createHttpQueryTransport.ts",
    ],
    "RECENT FAILURES": [
      "Previous comparisons focused on provider totals without isolating request-body contributors.",
    ],
    "NEXT BEST ACTIONS": [
      "Rank static prompt text and tool schema payload by serialized size.",
    ],
  },
  recent: buildRecentMessages(),
  latestActionableUserMessage:
    "Run a full token audit, isolate the heaviest prompt sections, and keep the result reproducible.",
  durableSummary: buildWorkingState(),
  pendingDigest: buildPendingDigest(),
  executionPlan: buildExecutionPlan(),
  summaryFallback: buildWorkingState(),
  reducerMode: "merge_and_digest",
  summaryRecoveryNeeded: true,
  interruptedTurn: {
    userText:
      "Compare the token cost against another coding agent and explain the gap.",
    assistantText:
      "I have already located the main prompt builders and need to measure each serialized section next.",
    startedAt: currentDate,
    updatedAt: currentDate,
  },
});

const buildMinimalPromptContext = () => ({
  pins: [],
  relevantMemories: [],
  archiveSections: undefined,
  recent: [],
  latestActionableUserMessage: "",
  durableSummary: "",
  pendingDigest: "",
  executionPlan: null,
  summaryFallback: "",
  reducerMode: "merge_and_digest",
  summaryRecoveryNeeded: false,
  interruptedTurn: null,
});

const splitPromptSections = prompt => {
  const markers = [
    "SYSTEM PROMPT (highest priority):",
    ".CYRENE.MD POLICY (second priority):",
    "SELECTED EXTENSIONS (request-scoped summary):",
    "EXECUTION PLAN PROTOCOL:",
    "TASK STATE CONTEXT:",
    "Active execution plan:",
    "Working state (durable reducer):",
    "Pending turn digest (last completed turn not yet merged):",
    "Interrupted prior turn snapshot:",
    "Latest actionable user request before this continuation:",
    "Short transcript tail (immediate recency only):",
    "Pinned memory (stable user priorities):",
    "Retrieved archive memory (section-aware):",
    "Retrieved archive memory:",
    "Current user query (act on this now):",
    "STATE REDUCER PROTOCOL:",
  ];

  const found = markers
    .map(marker => ({
      marker,
      index: prompt.indexOf(marker),
    }))
    .filter(entry => entry.index >= 0)
    .sort((left, right) => left.index - right.index);

  return found.map((entry, index) => {
    const nextIndex =
      found[index + 1]?.index ?? prompt.length;
    return prompt.slice(entry.index, nextIndex).trim();
  });
};

const buildApproxOpenAIRequest = userPrompt =>
  JSON.stringify({
    model: "gpt-5.4",
    temperature: 0.2,
    stream: true,
    stream_options: {
      include_usage: true,
    },
    tool_choice: "auto",
    tools: [FILE_TOOL],
    messages: [
      { role: "system", content: TOOL_USAGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

const promptPolicy = await loadPromptPolicy(undefined, process.cwd(), {
  env: {},
});

const minimalPrompt = buildPromptWithContext(
  "hello",
  promptPolicy.systemPrompt,
  promptPolicy.projectPrompt,
  buildMinimalPromptContext(),
  ""
);

const busyExtensionsPrompt = formatSelectedExtensionsPrompt({
  skills: Array.from({ length: 3 }, (_, index) => ({
    item: {
      id: `skill-${index + 1}`,
      description:
        "Focused project skill with specific guidance for this request and local workflow hints.",
      source: index === 0 ? "project" : "global",
      exposure: index === 2 ? "scoped" : "full",
      tags: ["prompt", "audit", `tag-${index + 1}`],
      matchTokens: [],
    },
    reason: index === 0 ? "manual" : "semantic",
    score: 0.8 - index * 0.1,
  })),
  mcpServers: Array.from({ length: 3 }, (_, index) => ({
    item: {
      id: `mcp-${index + 1}`,
      hint: "Useful for filesystem and project inspection during token audits.",
      transport: index === 0 ? "filesystem" : "stdio",
      scope: index === 0 ? "project" : "global",
      trusted: index !== 2,
      exposure: index === 1 ? "scoped" : "full",
      tags: ["audit", `server-${index + 1}`],
    },
    reason: index === 0 ? "manual" : "semantic",
    score: 0.7 - index * 0.1,
  })),
});

const busyPrompt = buildPromptWithContext(
  repeatSentence(
    "Audit the prompt budget, identify the heaviest serialized sections, and propose cuts that preserve behavior.",
    20
  ),
  promptPolicy.systemPrompt,
  promptPolicy.projectPrompt,
  buildBusyPromptContext(),
  busyExtensionsPrompt
);

const reducerPrompt = buildStateReducerPrompt({
  mode: "merge_and_digest",
  durableSummary: buildWorkingState(),
  pendingDigest: buildPendingDigest(),
  summaryRecoveryNeeded: true,
});

const buildPromptConstants = await extractNumericConstants(
  new URL("../src/core/session/buildPromptWithContext.ts", import.meta.url),
  [
    "PROMPT_QUERY_CHAR_LIMIT",
    "PROMPT_EXTENSION_CHAR_LIMIT",
    "PROMPT_WORKING_STATE_CHAR_LIMIT",
    "PROMPT_PENDING_DIGEST_CHAR_LIMIT",
    "PROMPT_FALLBACK_CHAR_LIMIT",
    "PROMPT_RECENT_TAIL_LIMIT",
    "PROMPT_RECENT_TEXT_LIMIT",
  ]
);

const roundPromptConstants = await extractNumericConstants(
  new URL("../src/core/query/runQuerySession.ts", import.meta.url),
  [
    "ROUND_PROMPT_TASK_CHAR_LIMIT",
    "ROUND_PROMPT_TOOL_RESULT_CHAR_LIMIT",
    "ROUND_PROMPT_TOOL_RESULT_ITEM_CHAR_LIMIT",
    "ROUND_PROMPT_TOOL_RESULT_KEEP_LIMIT",
    "MAX_NON_PROGRESS_CHATTER_CHARS",
  ]
);

console.log("# Cyrene Token Audit");
console.log(`Generated at ${currentDate}`);
console.log(
  "Token counts below are rough estimates using chars/4. Use them for ranking prompt hotspots, not billing accuracy."
);

divider("Static Payload");
printMetrics([
  buildMetric("default system prompt", promptPolicy.systemPrompt),
  buildMetric("project prompt (.cyrene.md)", promptPolicy.projectPrompt),
  buildMetric("tool usage system prompt", TOOL_USAGE_SYSTEM_PROMPT),
  buildMetric("file tool schema JSON", JSON.stringify(FILE_TOOL)),
  buildMetric("state reducer prompt", reducerPrompt),
  buildMetric("selected extensions prompt", busyExtensionsPrompt),
]);

divider("Prompt Budgets From Code");
printConstants(buildPromptConstants);

divider("Round Prompt Budgets From Code");
printConstants(roundPromptConstants);

divider("Minimal Prompt Scenario");
printMetrics([
  buildMetric("minimal business prompt", minimalPrompt),
  buildMetric("minimal OpenAI-style request JSON", buildApproxOpenAIRequest(minimalPrompt)),
]);

divider("Busy Prompt Scenario");
const busySections = splitPromptSections(busyPrompt).map((section, index) => {
  const firstLine = section.split(/\r?\n/, 1)[0] ?? `section-${index + 1}`;
  return buildMetric(firstLine, section);
});
printMetrics([
  buildMetric("busy business prompt total", busyPrompt),
  buildMetric("busy OpenAI-style request JSON", buildApproxOpenAIRequest(busyPrompt)),
  ...busySections,
]);

divider("Observations");
const staticPromptChars =
  TOOL_USAGE_SYSTEM_PROMPT.length +
  JSON.stringify(FILE_TOOL).length +
  promptPolicy.systemPrompt.length;
const busyRequestChars = buildApproxOpenAIRequest(busyPrompt).length;
const staticShare = ((staticPromptChars / busyRequestChars) * 100).toFixed(1);
console.log(
  `Static transport overhead (tool system prompt + file schema + default system prompt) is about ${formatNumber(staticPromptChars)} chars, roughly ${staticShare}% of the busy OpenAI-style request body.`
);
console.log(
  `The file tool schema alone is about ${formatNumber(
    JSON.stringify(FILE_TOOL).length
  )} chars, making it the largest single always-on payload in the transport layer.`
);
console.log(
  `The busy business prompt reaches about ${formatNumber(
    busyPrompt.length
  )} chars before transport wrapping, with durable state, pending digest, execution plan, and reducer protocol as the main non-tool contributors.`
);
