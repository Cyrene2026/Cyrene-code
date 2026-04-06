import type { SkillDefinition } from "./types";

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "code-review",
    label: "Code Review",
    description: "Prioritize bugs, regressions, and missing tests.",
    prompt: [
      "When the user asks for a review, focus on concrete findings first.",
      "Order findings by severity, include file references, then mention open questions and residual test risk.",
    ].join(" "),
    triggers: ["review", "code review", "审查", "代码审查", "复查"],
    enabled: true,
    source: "built_in",
  },
  {
    id: "mcp-ops",
    label: "MCP Ops",
    description: "Prefer MCP status, safety, and config consistency checks.",
    prompt: [
      "For MCP-related requests, prioritize runtime/config consistency.",
      "Prefer explicit server/tool visibility and safe mutation workflows over implicit behavior.",
    ].join(" "),
    triggers: ["mcp", "工具", "tooling"],
    enabled: true,
    source: "built_in",
  },
];
