import { clampCursorOffset } from "./multilineInput";

export type FileMentionSuggestion = {
  path: string;
  description: string;
};

export type ActiveFileMention = {
  start: number;
  end: number;
  query: string;
};

const FILE_MENTION_REGEX = /(^|\s)@([^\s@]*)/g;

const CODE_LIKE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

export const getActiveFileMention = (
  rawInput: string,
  cursorOffset: number
): ActiveFileMention | null => {
  const clampedOffset = clampCursorOffset(rawInput, cursorOffset);
  const beforeCursor = rawInput.slice(0, clampedOffset);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const start = beforeCursor.length - query.length - 1;
  return {
    start,
    end: clampedOffset,
    query,
  };
};

export const getFileMentionReferences = (rawInput: string) => {
  const references: string[] = [];
  let match: RegExpExecArray | null = null;
  const pattern = new RegExp(FILE_MENTION_REGEX);
  while ((match = pattern.exec(rawInput)) !== null) {
    const reference = (match[2] ?? "").trim();
    if (!reference) {
      continue;
    }
    if (!references.includes(reference)) {
      references.push(reference);
    }
  }
  return references;
};

export const buildFileSearchPattern = (query: string) =>
  `*${query.replace(/\s+/g, "*")}*`;

const buildFileSuggestionDescription = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) {
    return "workspace root";
  }
  return normalized.slice(0, slashIndex);
};

export const parseFindFilesSuggestions = (
  raw: string
): FileMentionSuggestion[] => {
  const body = raw.split("\n").slice(1);
  const paths = body
    .map(line => line.trim())
    .filter(
      line =>
        Boolean(line) &&
        !line.startsWith("Found ") &&
        !line.startsWith("note:") &&
        !line.startsWith("(no matches")
    );

  return paths.slice(0, 6).map(path => ({
    path,
    description: buildFileSuggestionDescription(path),
  }));
};

export const getFilePreviewCacheKey = (path: string, query: string) =>
  `${path.toLowerCase()}::${query.trim().toLowerCase()}`;

export const isCodeLikePath = (path: string) => {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const fileName = normalized.split("/").pop() ?? normalized;
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex < 0) {
    return false;
  }
  return CODE_LIKE_EXTENSIONS.has(fileName.slice(extensionIndex));
};
