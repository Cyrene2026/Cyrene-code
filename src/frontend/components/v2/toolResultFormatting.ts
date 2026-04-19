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
  label: string,
  maxItems = 3
) => {
  if (items.length === 0) {
    return `(no ${label})`;
  }
  const visible = items.slice(0, maxItems).join(", ");
  const more = items.length - Math.min(items.length, maxItems);
  return `${visible} (${items.length} ${label}${more > 0 ? `, +${more} more` : ""})`;
};

const summarizeReadFilesBody = (body: string) => {
  const files = body
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("[file] "))
    .map(line => line.replace(/^\[file\]\s+/, ""));
  return summarizeNamedItems(files, "files");
};

const summarizeSearchTextContextBody = (body: string) => {
  const matches = body
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("[match] "))
    .map(line => line.replace(/^\[match\]\s+/, ""));
  return summarizeNamedItems(matches, "matches");
};

export const formatReadToolResultDisplay = (detail: string, body: string) => {
  const trimmed = trimWhitespaceOnlyEdges(body);
  if (detail.startsWith("read_files ")) {
    return summarizeReadFilesBody(trimmed);
  }
  if (detail.startsWith("search_text_context ")) {
    return summarizeSearchTextContextBody(trimmed);
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

