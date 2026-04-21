import type { McpToolDescriptor } from "../../../core/mcp";

const TOOL_RESULT_PREFIXES = [
  "[tool result]",
  "[tool error]",
  "Tool result:",
  "Tool error:",
] as const;

const BUILTIN_CANONICAL_TOOL_NAMES = [
  "list_dir",
  "create_dir",
  "stat_path",
  "stat_paths",
  "find_files",
  "copy_path",
  "move_path",
  "read_file",
  "read_files",
  "read_range",
  "read_json",
  "read_yaml",
  "outline_file",
  "find_symbol",
  "find_references",
  "search_text",
  "search_text_context",
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
  "ts_hover",
  "ts_definition",
  "ts_references",
  "ts_diagnostics",
  "ts_prepare_rename",
  "lsp_hover",
  "lsp_definition",
  "lsp_implementation",
  "lsp_type_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_diagnostics",
  "lsp_prepare_rename",
  "lsp_rename",
  "lsp_code_actions",
  "lsp_format_document",
  "run_command",
  "run_shell",
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
] as const;

const toToolNameLookupKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const BUILTIN_CANONICAL_LOOKUP = new Map(
  BUILTIN_CANONICAL_TOOL_NAMES.map(name => [toToolNameLookupKey(name), name])
);

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

  if (fuzzyMatch?.name) {
    return fuzzyMatch.name;
  }

  return BUILTIN_CANONICAL_LOOKUP.get(lookupKey) ?? trimmed;
};

const normalizeInlineToolStatusDetail = (
  detail: string,
  tools: Pick<McpToolDescriptor, "id" | "name" | "label">[]
) => {
  let suffix = "";
  let normalizedDetail = detail.trim();
  if (normalizedDetail.endsWith("...")) {
    suffix = "...";
    normalizedDetail = normalizedDetail.slice(0, -3).trimEnd();
  }
  const [header, ...restSections] = normalizedDetail.split(" | ");
  const [toolName, ...restWords] = (header ?? "").trim().split(/\s+/);
  const nextToolName = canonicalizeToolNameForDisplay(toolName ?? "", tools);
  const nextHeader = [nextToolName, ...restWords].filter(Boolean).join(" ");
  return [nextHeader, ...restSections].filter(Boolean).join(" | ") + suffix;
};

const normalizeLooseToolStatusLine = (
  line: string,
  tools: Pick<McpToolDescriptor, "id" | "name" | "label">[]
) => {
  for (const prefix of ["Tool error:", "Tool result:", "Tool:", "Running"] as const) {
    const index = findLooseToolPrefixIndex(line, prefix);
    if (index < 0) {
      continue;
    }
    const detailStart = index + prefix.length;
    if (
      prefix === "Running" &&
      detailStart < line.length &&
      !/\s|\|/.test(line[detailStart] ?? "")
    ) {
      continue;
    }
    const renderedPrefix = prefix.endsWith(":")
      ? `${prefix.slice(0, -1)}: `
      : `${prefix} `;
    return `${line.slice(0, index)}${renderedPrefix}${normalizeInlineToolStatusDetail(
      line.slice(detailStart).trim(),
      tools
    )}`;
  }
  return line;
};

const findLooseToolPrefixIndex = (line: string, prefix: string) => {
  let searchStart = 0;
  while (searchStart < line.length) {
    const index = line.indexOf(prefix, searchStart);
    if (index < 0) {
      return -1;
    }
    if (index === 0 || isLooseToolPrefixBoundary(line.slice(0, index))) {
      return index;
    }
    searchStart = index + prefix.length;
  }
  return -1;
};

const isLooseToolPrefixBoundary = (before: string) => {
  const trimmed = before.trim();
  if (!trimmed) {
    return true;
  }
  return /^[❯›>•|\-│\s]+$/.test(trimmed);
};

export const normalizeToolDisplayText = (
  raw: string,
  tools: Pick<McpToolDescriptor, "id" | "name" | "label">[]
) => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  const normalizedLooseLines = raw
    .split("\n")
    .map(line => normalizeLooseToolStatusLine(line, tools))
    .join("\n");
  if (normalizedLooseLines !== raw) {
    return normalizedLooseLines;
  }

  if (trimmed.startsWith("Running ") && trimmed.endsWith("...")) {
    const inner = trimmed.slice("Running ".length, -3);
    const [toolName, ...rest] = inner.split(" | ");
    const nextToolName = canonicalizeToolNameForDisplay(toolName ?? "", tools);
    const nextInner = [nextToolName, ...rest].filter(Boolean).join(" | ");
    return `Running ${nextInner}...`;
  }

  for (const prefix of ["Tool: ", "Tool error: ", "Tool result: "] as const) {
    if (!trimmed.startsWith(prefix)) {
      continue;
    }
    const detail = trimmed.slice(prefix.length).trim();
    return `${prefix}${normalizeInlineToolStatusDetail(detail, tools)}`;
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
