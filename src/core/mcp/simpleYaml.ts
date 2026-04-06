type YamlLine = {
  indent: number;
  content: string;
  lineNo: number;
};

type ParseResult = {
  value: unknown;
  nextIndex: number;
};

const countIndent = (line: string) => {
  let count = 0;
  while (count < line.length && line[count] === " ") {
    count += 1;
  }
  return count;
};

const stripYamlComment = (line: string) => {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    const previous = index > 0 ? line[index - 1] ?? "" : "";

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"' && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "#" && (index === 0 || /\s/.test(previous))) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line.trimEnd();
};

const normalizeYamlLines = (input: string) =>
  input
    .replace(/\t/g, "  ")
    .split(/\r?\n/)
    .map((raw, index) => {
      const withoutComment = stripYamlComment(raw);
      if (!withoutComment.trim()) {
        return null;
      }
      const indent = countIndent(withoutComment);
      return {
        indent,
        content: withoutComment.slice(indent),
        lineNo: index + 1,
      } satisfies YamlLine;
    })
    .filter((line): line is YamlLine => Boolean(line));

const splitTopLevel = (input: string, delimiter: string) => {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const previous = index > 0 ? input[index - 1] ?? "" : "";

    if (quote === "'") {
      current += char;
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      current += char;
      if (char === '"' && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }

    if (char === delimiter && bracketDepth === 0 && braceDepth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim() || input.endsWith(delimiter)) {
    parts.push(current.trim());
  }

  return parts.filter(Boolean);
};

const splitYamlKeyValue = (input: string, allowTightValue = false) => {
  let quote: "'" | '"' | null = null;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const previous = index > 0 ? input[index - 1] ?? "" : "";
    const next = input[index + 1] ?? "";

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"' && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char !== ":" || bracketDepth > 0 || braceDepth > 0) {
      continue;
    }

    if (!allowTightValue && next && !/\s/.test(next)) {
      continue;
    }

    const key = input.slice(0, index).trim();
    if (!key) {
      return null;
    }

    return {
      key,
      rawValue: input.slice(index + 1).trim(),
    };
  }

  return null;
};

const unquoteYamlString = (input: string) => {
  if (input.startsWith('"') && input.endsWith('"')) {
    return input
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (input.startsWith("'") && input.endsWith("'")) {
    return input.slice(1, -1).replace(/''/g, "'");
  }

  return input;
};

const parseYamlScalar = (input: string): unknown => {
  const trimmed = input.trim();

  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unquoteYamlString(trimmed);
  }

  if (trimmed === "null" || trimmed === "~") {
    return null;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (/^[+-]?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (/^[+-]?(?:\d+\.\d+|\d+\.\d*|\.\d+)$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return trimmed;
};

const parseInlineYamlValue = (input: string): unknown => {
  const trimmed = input.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return splitTopLevel(inner, ",").map(part => parseInlineYamlValue(part));
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return {};
    }
    const record: Record<string, unknown> = {};
    for (const part of splitTopLevel(inner, ",")) {
      const pair = splitYamlKeyValue(part, true);
      if (!pair) {
        throw new Error(`Invalid inline YAML mapping entry: ${part}`);
      }
      record[pair.key] = parseInlineYamlValue(pair.rawValue);
    }
    return record;
  }

  return parseYamlScalar(trimmed);
};

const parseBlockScalar = (
  lines: YamlLine[],
  index: number,
  parentIndent: number,
  mode: "|" | ">"
): ParseResult => {
  if (index >= lines.length || lines[index]!.indent <= parentIndent) {
    return {
      value: "",
      nextIndex: index,
    };
  }

  const baseIndent = lines[index]!.indent;
  const values: string[] = [];
  let nextIndex = index;

  while (nextIndex < lines.length && lines[nextIndex]!.indent > parentIndent) {
    const line = lines[nextIndex]!;
    const content =
      line.indent >= baseIndent
        ? line.content
        : line.content.trimStart();
    values.push(content);
    nextIndex += 1;
  }

  return {
    value: mode === ">" ? values.join(" ") : values.join("\n"),
    nextIndex,
  };
};

const parseBlock = (lines: YamlLine[], index: number, indent: number): ParseResult => {
  const line = lines[index];
  if (!line) {
    throw new Error("Unexpected end of YAML document.");
  }
  if (line.indent !== indent) {
    throw new Error(`Unexpected indentation on line ${line.lineNo}.`);
  }

  if (line.content.startsWith("-")) {
    return parseSequence(lines, index, indent);
  }

  if (splitYamlKeyValue(line.content)) {
    return parseMapping(lines, index, indent);
  }

  return {
    value: parseInlineYamlValue(line.content),
    nextIndex: index + 1,
  };
};

const parseMappingEntry = (
  lines: YamlLine[],
  content: string,
  nextIndex: number,
  indent: number,
  lineNo: number
) => {
  const pair = splitYamlKeyValue(content);
  if (!pair) {
    throw new Error(`Invalid YAML mapping entry on line ${lineNo}.`);
  }

  if (pair.rawValue === "|" || pair.rawValue === ">") {
    const block = parseBlockScalar(lines, nextIndex, indent, pair.rawValue);
    return {
      key: pair.key,
      value: block.value,
      nextIndex: block.nextIndex,
    };
  }

  if (pair.rawValue) {
    return {
      key: pair.key,
      value: parseInlineYamlValue(pair.rawValue),
      nextIndex,
    };
  }

  if (nextIndex < lines.length && lines[nextIndex]!.indent > indent) {
    const nested = parseBlock(lines, nextIndex, lines[nextIndex]!.indent);
    return {
      key: pair.key,
      value: nested.value,
      nextIndex: nested.nextIndex,
    };
  }

  return {
    key: pair.key,
    value: null,
    nextIndex,
  };
};

const parseMapping = (
  lines: YamlLine[],
  index: number,
  indent: number,
  seed: Record<string, unknown> = {}
): ParseResult => {
  const record: Record<string, unknown> = { ...seed };
  let nextIndex = index;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex]!;
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected indentation on line ${line.lineNo}.`);
    }
    if (line.content.startsWith("-")) {
      break;
    }

    const entry = parseMappingEntry(lines, line.content, nextIndex + 1, indent, line.lineNo);
    record[entry.key] = entry.value;
    nextIndex = entry.nextIndex;
  }

  return {
    value: record,
    nextIndex,
  };
};

const parseSequence = (lines: YamlLine[], index: number, indent: number): ParseResult => {
  const values: unknown[] = [];
  let nextIndex = index;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex]!;
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected indentation on line ${line.lineNo}.`);
    }
    if (!line.content.startsWith("-")) {
      break;
    }

    const rawItem = line.content === "-" ? "" : line.content.slice(1).trimStart();
    nextIndex += 1;

    if (rawItem === "|" || rawItem === ">") {
      const block = parseBlockScalar(lines, nextIndex, indent, rawItem);
      values.push(block.value);
      nextIndex = block.nextIndex;
      continue;
    }

    if (!rawItem) {
      if (nextIndex < lines.length && lines[nextIndex]!.indent > indent) {
        const nested = parseBlock(lines, nextIndex, lines[nextIndex]!.indent);
        values.push(nested.value);
        nextIndex = nested.nextIndex;
      } else {
        values.push(null);
      }
      continue;
    }

    if (splitYamlKeyValue(rawItem)) {
      const virtualIndent = indent + 2;
      const entry = parseMappingEntry(lines, rawItem, nextIndex, virtualIndent, line.lineNo);
      const seeded = parseMapping(lines, entry.nextIndex, virtualIndent, {
        [entry.key]: entry.value,
      });
      values.push(seeded.value);
      nextIndex = seeded.nextIndex;
      continue;
    }

    values.push(parseInlineYamlValue(rawItem));
  }

  return {
    value: values,
    nextIndex,
  };
};

export const parseYamlDocument = (input: string): unknown => {
  const lines = normalizeYamlLines(input);
  if (lines.length === 0) {
    return null;
  }

  const parsed = parseBlock(lines, 0, lines[0]!.indent);
  if (parsed.nextIndex < lines.length) {
    const line = lines[parsed.nextIndex]!;
    throw new Error(`Unexpected trailing YAML content on line ${line.lineNo}.`);
  }

  return parsed.value;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isScalar = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const shouldQuoteYamlString = (value: string) => {
  if (!value) {
    return true;
  }

  if (
    value === "null" ||
    value === "~" ||
    value === "true" ||
    value === "false"
  ) {
    return true;
  }

  return !/^[A-Za-z0-9_./:@+-]+$/.test(value);
};

const stringifyYamlScalar = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return JSON.stringify(value);
  }
  if (!shouldQuoteYamlString(value)) {
    return value;
  }

  return JSON.stringify(value);
};

const stringifyYamlValue = (value: unknown, indent: number): string => {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${pad}[]`;
    }

    return value
      .map(item => {
        if (isScalar(item)) {
          return `${pad}- ${stringifyYamlScalar(item)}`;
        }

        const nested = stringifyYamlValue(item, indent + 2);
        return `${pad}-\n${nested}`;
      })
      .join("\n");
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) {
      return `${pad}{}`;
    }

    return entries
      .map(([key, item]) => {
        if (isScalar(item)) {
          return `${pad}${key}: ${stringifyYamlScalar(item)}`;
        }

        return `${pad}${key}:\n${stringifyYamlValue(item, indent + 2)}`;
      })
      .join("\n");
  }

  return `${pad}${stringifyYamlScalar(value)}`;
};

export const stringifyYamlDocument = (value: unknown) =>
  `${stringifyYamlValue(value, 0)}\n`;
