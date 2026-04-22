const trimWhitespaceOnlyEdges = (value: string) => {
  const lines = value.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] !== undefined && lines[start]!.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1] !== undefined && lines[end - 1]!.trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end).join("\n");
};

const summarizeNamedItems = (
  items: string[],
  singularLabel: string,
  pluralLabel: string,
  maxItems = 3
) => {
  if (items.length === 0) {
    return `(no ${pluralLabel})`;
  }
  const visible = items.slice(0, maxItems).join(", ");
  const more = items.length - Math.min(items.length, maxItems);
  const label = items.length === 1 ? singularLabel : pluralLabel;
  return `${visible} (${items.length} ${label}${more > 0 ? `, +${more} more` : ""})`;
};

const summarizeTaggedBody = (
  body: string,
  tag: string,
  singularLabel: string,
  pluralLabel: string,
  aliases: string[] = []
) => {
  const tags = [tag, ...aliases];
  const items = body
    .split("\n")
    .map(line => line.trim())
    .filter(line => tags.some(current => line.startsWith(`[${current}] `)))
    .map(line => line.replace(/^\[[^\]]+\]\s+/, ""));
  return summarizeNamedItems(items, singularLabel, pluralLabel);
};

const summarizeReadFilesBody = (body: string) => {
  const files = body
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("[file] "))
    .map(line => line.replace(/^\[file\]\s+/, ""));
  return summarizeNamedItems(files, "file", "files");
};

export const formatReadToolResultDisplay = (detail: string, body: string) => {
  const trimmed = trimWhitespaceOnlyEdges(body);
  if (detail.startsWith("read_files ")) {
    return summarizeReadFilesBody(trimmed);
  }
  if (detail.startsWith("find_files ")) {
    return summarizeTaggedBody(trimmed, "file", "file hit", "file hits");
  }
  if (detail.startsWith("search_text ")) {
    return summarizeTaggedBody(trimmed, "text", "text hit", "text hits");
  }
  if (detail.startsWith("search_text_context ")) {
    return summarizeTaggedBody(
      trimmed,
      "text",
      "text hit with context",
      "text hits with context",
      ["match"]
    );
  }
  if (detail.startsWith("find_symbol ")) {
    return summarizeTaggedBody(trimmed, "definition", "definition hit", "definition hits");
  }
  if (detail.startsWith("find_references ")) {
    return summarizeTaggedBody(trimmed, "reference", "reference hit", "reference hits");
  }
  if (!trimmed) {
    return "(empty)";
  }
  if (trimmed === "(empty file)") {
    return "(empty file)";
  }
  if (detail.startsWith("read_file ")) {
    return "content hidden";
  }
  if (detail.startsWith("read_range ")) {
    return "range content hidden";
  }
  if (detail.startsWith("read_json ")) {
    return "JSON content hidden";
  }
  if (detail.startsWith("read_yaml ")) {
    return "YAML content hidden";
  }
  return "content hidden";
};
