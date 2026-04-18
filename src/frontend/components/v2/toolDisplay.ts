import type { McpToolDescriptor } from "../../../core/mcp";

const TOOL_RESULT_PREFIXES = [
  "[tool result]",
  "[tool error]",
  "Tool result:",
  "Tool error:",
] as const;

const toToolNameLookupKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export const canonicalizeToolNameForDisplay = (
  toolName: string,
  tools: Pick<McpToolDescriptor, "id" | "name" | "label">[]
) => {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return trimmed;
  }

  const exactMatch = tools.find(
    tool => tool.name.trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (exactMatch) {
    return exactMatch.name;
  }

  const lookupKey = toToolNameLookupKey(trimmed);
  if (!lookupKey) {
    return trimmed;
  }

  const fuzzyMatch = tools.find(tool => {
    const candidates = [tool.name, tool.label, tool.id];
    return candidates.some(candidate => toToolNameLookupKey(candidate) === lookupKey);
  });

  return fuzzyMatch?.name ?? trimmed;
};

export const normalizeToolDisplayText = (
  raw: string,
  tools: Pick<McpToolDescriptor, "id" | "name" | "label">[]
) => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  if (trimmed.startsWith("Running ") && trimmed.endsWith("...")) {
    const inner = trimmed.slice("Running ".length, -3);
    const [toolName, ...rest] = inner.split(" | ");
    const nextToolName = canonicalizeToolNameForDisplay(toolName ?? "", tools);
    const nextInner = [nextToolName, ...rest].filter(Boolean).join(" | ");
    return `Running ${nextInner}...`;
  }

  const lines = raw.split("\n");
  const firstLine = lines[0] ?? "";
  for (const prefix of TOOL_RESULT_PREFIXES) {
    if (!firstLine.startsWith(prefix)) {
      continue;
    }
    const detail = firstLine.slice(prefix.length).trim();
    const [toolName, ...rest] = detail.split(/\s+/);
    const nextToolName = canonicalizeToolNameForDisplay(toolName ?? "", tools);
    const nextDetail = [nextToolName, ...rest].filter(Boolean).join(" ");
    lines[0] = `${prefix} ${nextDetail}`.trimEnd();
    return lines.join("\n");
  }

  return raw;
};
