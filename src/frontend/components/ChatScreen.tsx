import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { TokenUsage } from "../../core/query/tokenUsage";
import type { SessionListItem } from "../../core/session/types";
import type { PendingReviewItem } from "../../core/tools/mcp/types";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";

type ChatScreenProps = {
  items: ChatItem[];
  liveAssistantText: string;
  status: ChatStatus;
  input: string;
  inputCommandState: {
    active: boolean;
    currentCommand: string | null;
    suggestions: Array<{
      command: string;
      description: string;
    }>;
    historyPosition: number | null;
    historySize: number;
  };
  resumePicker: {
    active: boolean;
    sessions: SessionListItem[];
    selectedIndex: number;
    pageSize: number;
  };
  sessionsPanel: {
    active: boolean;
    sessions: SessionListItem[];
    selectedIndex: number;
    pageSize: number;
  };
  modelPicker: {
    active: boolean;
    models: string[];
    selectedIndex: number;
    pageSize: number;
  };
  pendingReviews: PendingReviewItem[];
  approvalPanel: {
    active: boolean;
    selectedIndex: number;
    previewMode: "summary" | "full";
    previewOffset: number;
    lastOpenedAt: string | null;
    blockedItemId: string | null;
    blockedReason: string | null;
    blockedAt: number | null;
    lastAction: "approve" | "reject" | null;
    inFlightId?: string | null;
    actionState?: "approve" | "reject" | null;
    resumePending?: boolean;
  };
  activeSessionId: string | null;
  currentModel: string;
  usage: TokenUsage | null;
  onInputChange: (next: string) => void;
  onSubmit: () => void;
};

type PagedResult<T> = {
  pageItems: T[];
  pageStart: number;
  currentPage: number;
  totalPages: number;
  total: number;
};

type CodeSegment = {
  text: string;
  color?: ChatItem["color"];
  backgroundColor?: ChatItem["color"];
};

type ApprovalPreviewLine = {
  kind: "section" | "hunk" | "add" | "remove" | "kv" | "context" | "blank";
  raw: string;
  label?: string;
  key?: string;
  value?: string;
  lineNumber?: string;
  content?: string;
};

type MarkdownInlineSegment = {
  text: string;
  kind: "text" | "code" | "strong";
};

type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; language?: string; content: string }
  | { kind: "diff"; lines: string[] }
  | { kind: "rule" };

const BRAND_NAME = "CYRENE";
const SECTION_GAP = 1;
const SPINNER_FRAMES = ["·", "•", "●", "•"];
const STREAMING_IDLE_GLYPH = "●";
const ENABLE_STREAMING_ANIMATION =
  process.env.CYRENE_ANIMATE_STREAMING === "1" ||
  (process.env.CYRENE_ANIMATE_STREAMING !== "0" && process.platform !== "win32");
const CODE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "switch",
  "case",
  "break",
  "for",
  "while",
  "class",
  "extends",
  "import",
  "from",
  "export",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "type",
  "interface",
  "new",
  "true",
  "false",
  "null",
  "undefined",
]);

const resolveItemColor = (item: ChatItem) => {
  if (item.kind === "error" || item.tone === "danger") return "red";
  if (item.kind === "tool_status" || item.tone === "info") return "cyan";
  if (item.kind === "review_status" && item.tone === "warning") return "yellow";
  if (item.kind === "review_status") return "green";
  if (item.kind === "system_hint") return "gray";
  if (item.tone === "success") return "green";
  return item.color ?? "white";
};

const getMessageLabel = (
  item: ChatItem
): { label: string; color: ChatItem["color"] } => {
  if (item.role === "user") {
    return { label: "you", color: "green" };
  }
  if (item.kind === "tool_status") {
    return { label: "tool", color: "cyan" };
  }
  if (item.kind === "review_status") {
    return {
      label: "review",
      color: item.tone === "warning" ? "yellow" : "green",
    };
  }
  if (item.kind === "error" || item.tone === "danger") {
    return { label: "error", color: "red" };
  }
  if (item.role === "assistant") {
    return { label: "cyrene", color: "cyan" };
  }
  return { label: "system", color: "gray" };
};

const shortenValue = (value: string, max = 20) =>
  value.length <= max ? value : `${value.slice(0, Math.max(1, max - 3))}...`;

const getStatusBadge = (status: ChatStatus, spinner: string) => {
  if (status === "streaming") {
    return {
      textColor: "black" as const,
      backgroundColor: "yellow" as const,
      headerLabel: `${spinner} WORKING`,
      inputLabel: `${spinner} Thinking`,
      inputColor: "yellow" as const,
    };
  }

  if (status === "awaiting_review") {
    return {
      textColor: "black" as const,
      backgroundColor: "magenta" as const,
      headerLabel: "REVIEW",
      inputLabel: "Awaiting review",
      inputColor: "magenta" as const,
    };
  }

  if (status === "error") {
    return {
      textColor: "black" as const,
      backgroundColor: "red" as const,
      headerLabel: "ERROR",
      inputLabel: "Error",
      inputColor: "red" as const,
    };
  }

  return {
    textColor: "black" as const,
    backgroundColor: "green" as const,
    headerLabel: "READY",
    inputLabel: "Ready",
    inputColor: "green" as const,
  };
};

const formatPaged = <T,>(items: T[], selectedIndex: number, pageSize: number): PagedResult<T> => {
  const total = items.length;
  if (total === 0) {
    return {
      pageItems: [],
      pageStart: 0,
      currentPage: 1,
      totalPages: 1,
      total: 0,
    };
  }
  const safeSize = Math.max(1, pageSize);
  const pageStart = Math.floor(selectedIndex / safeSize) * safeSize;
  return {
    pageItems: items.slice(pageStart, pageStart + safeSize),
    pageStart,
    currentPage: Math.floor(selectedIndex / safeSize) + 1,
    totalPages: Math.max(1, Math.ceil(total / safeSize)),
    total,
  };
};

const getPreviewWindow = (text: string, offset: number, pageSize = 20) => {
  const lines = text.split("\n");
  const maxOffset = Math.max(0, lines.length - pageSize);
  const safeOffset = Math.max(0, Math.min(offset, maxOffset));
  return {
    pageLines: lines.slice(safeOffset, safeOffset + pageSize),
    safeOffset,
    totalLines: lines.length,
  };
};

const inferCodeLanguage = (text: string) => {
  const lower = text.toLowerCase();
  if (lower.includes("import ") || lower.includes("const ") || lower.includes("=>")) {
    return "ts";
  }
  if (lower.includes("def ") || lower.includes("print(") || lower.includes("import ")) {
    return "py";
  }
  if (lower.includes("function ") || lower.includes("console.log")) {
    return "js";
  }
  return "plain";
};

const tokenizeCodeLine = (line: string): CodeSegment[] => {
  if (!line) {
    return [{ text: " " }];
  }

  if (line.startsWith("+")) {
    return [{ text: line, color: "green" }];
  }
  if (line.startsWith("-")) {
    return [{ text: line, color: "red" }];
  }
  if (line.startsWith("@@")) {
    return [{ text: line, color: "cyan" }];
  }
  if (/^\s*\/\//.test(line) || /^\s*#/.test(line)) {
    return [{ text: line, color: "gray" }];
  }

  const tokens = line.split(/(\s+|[()[\]{}.,:;=<>+\-*/"'`])/).filter(Boolean);
  return tokens.map(token => {
    if (/^\s+$/.test(token)) {
      return { text: token };
    }
    if (/^["'`].*["'`]$/.test(token)) {
      return { text: token, color: "yellow" };
    }
    if (/^\d+([._]\d+)?$/.test(token)) {
      return { text: token, color: "magenta" };
    }
    if (CODE_KEYWORDS.has(token)) {
      return { text: token, color: "cyan" };
    }
    return { text: token, color: "white" };
  });
};

export const parseInlineMarkdownSegments = (line: string): MarkdownInlineSegment[] => {
  const segments: MarkdownInlineSegment[] = [];
  let cursor = 0;
  let buffer = "";

  const pushBuffer = () => {
    if (!buffer) {
      return;
    }
    segments.push({ text: buffer, kind: "text" });
    buffer = "";
  };

  while (cursor < line.length) {
    if (line.startsWith("`", cursor)) {
      const end = line.indexOf("`", cursor + 1);
      if (end !== -1) {
        pushBuffer();
        segments.push({
          text: line.slice(cursor + 1, end),
          kind: "code",
        });
        cursor = end + 1;
        continue;
      }
    }

    if (line.startsWith("**", cursor)) {
      const end = line.indexOf("**", cursor + 2);
      if (end !== -1) {
        pushBuffer();
        segments.push({
          text: line.slice(cursor + 2, end),
          kind: "strong",
        });
        cursor = end + 2;
        continue;
      }
    }

    buffer += line[cursor] ?? "";
    cursor += 1;
  }

  pushBuffer();
  return segments.filter(segment => segment.text.length > 0);
};

export const parseInlineCodeSegments = (line: string) =>
  parseInlineMarkdownSegments(line).map(segment => ({
    text: segment.text,
    isCode: segment.kind === "code",
  }));

const renderSegments = (
  segments: CodeSegment[],
  keyPrefix: string,
  options?: { backgroundColor?: ChatItem["color"] }
) => (
  <Text backgroundColor={options?.backgroundColor}>
    {segments.map((segment, index) => (
      <Text
        key={`${keyPrefix}-${index}`}
        color={segment.color}
        backgroundColor={segment.backgroundColor ?? options?.backgroundColor}
      >
        {segment.text}
      </Text>
    ))}
  </Text>
);

const renderInlineMarkdownLine = (
  line: string,
  key: string,
  color: ChatItem["color"],
  prefix?: string
) => {
  const segments = parseInlineMarkdownSegments(line);
  if (segments.length === 0) {
    return (
      <Text key={key} color={color}>
        {prefix ?? ""}
        {line || " "}
      </Text>
    );
  }

  return (
    <Text key={key} color={color}>
      {prefix ?? ""}
      {segments.map((segment, index) =>
        segment.kind === "code" ? (
          <Text
            key={`${key}-code-${index}`}
            color="white"
            backgroundColor="gray"
          >
            {segment.text}
          </Text>
        ) : segment.kind === "strong" ? (
          <Text key={`${key}-strong-${index}`} color={color} bold>
            {segment.text}
          </Text>
        ) : (
          <Text key={`${key}-text-${index}`} color={color}>
            {segment.text}
          </Text>
        )
      )}
    </Text>
  );
};

const renderCodeBlock = (code: string, itemIndex: number, langHint?: string) => {
  const language = langHint || inferCodeLanguage(code);
  const lines = code.split("\n");
  return (
    <Box key={`code-${itemIndex}-${language}`} flexDirection="column" marginTop={1}>
      <Text dimColor>{`  code | ${language}`}</Text>
      {lines.map((line, lineIndex) => (
        <Box key={`code-line-${itemIndex}-${lineIndex}`}>
          <Text dimColor>{`  ${String(lineIndex + 1).padStart(3, " ")} `}</Text>
          {renderSegments(tokenizeCodeLine(line), `code-token-${itemIndex}-${lineIndex}`, {
            backgroundColor: "gray",
          })}
        </Box>
      ))}
    </Box>
  );
};

export const isTranscriptDiffLine = (line: string, neighbors?: { prev?: string; next?: string }) => {
  if (line.startsWith("@@")) {
    return true;
  }

  const diffWithLineNumber = /^([+-])\s*\d+\s*\|/.test(line);
  if (diffWithLineNumber) {
    return true;
  }

  const simpleDiff = /^([+-])\s+\S/.exec(line);
  if (!simpleDiff) {
    return false;
  }

  const prev = neighbors?.prev?.trimStart() ?? "";
  const next = neighbors?.next?.trimStart() ?? "";
  const currentSign = simpleDiff[1];
  const oppositeSign = currentSign === "+" ? "-" : "+";

  return (
    prev.startsWith("@@") ||
    next.startsWith("@@") ||
    prev.startsWith(oppositeSign) ||
    next.startsWith(oppositeSign)
  );
};

export const parseMarkdownBlocks = (text: string): MarkdownBlock[] => {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let listState: { ordered: boolean; items: string[] } | null = null;
  let diffLines: string[] = [];
  let inCode = false;
  let codeLanguage = "";
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      kind: "paragraph",
      text: paragraphLines.map(line => line.trim()).join(" "),
    });
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listState || listState.items.length === 0) {
      listState = null;
      return;
    }
    blocks.push({
      kind: "list",
      ordered: listState.ordered,
      items: [...listState.items],
    });
    listState = null;
  };

  const flushDiff = () => {
    if (diffLines.length === 0) {
      return;
    }
    blocks.push({
      kind: "diff",
      lines: [...diffLines],
    });
    diffLines = [];
  };

  const flushCode = () => {
    blocks.push({
      kind: "code",
      language: codeLanguage || undefined,
      content: codeLines.join("\n"),
    });
    codeLines = [];
    codeLanguage = "";
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const prev = index > 0 ? lines[index - 1] : undefined;
    const next = index < lines.length - 1 ? lines[index + 1] : undefined;

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      flushDiff();
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLanguage = trimmed.slice(3).trim();
      }
      return;
    }

    if (inCode) {
      codeLines.push(line);
      return;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushDiff();
      return;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushDiff();
      blocks.push({ kind: "rule" });
      return;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const headingLevel = headingMatch[1] ?? "";
      const headingText = headingMatch[2] ?? "";
      flushParagraph();
      flushList();
      flushDiff();
      blocks.push({
        kind: "heading",
        level: headingLevel.length,
        text: headingText,
      });
      return;
    }

    if (isTranscriptDiffLine(line, { prev, next })) {
      flushParagraph();
      flushList();
      diffLines.push(line);
      return;
    }

    const unorderedMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unorderedMatch) {
      const itemText = unorderedMatch[1] ?? "";
      flushParagraph();
      flushDiff();
      if (!listState || listState.ordered) {
        flushList();
        listState = { ordered: false, items: [] };
      }
      listState.items.push(itemText);
      return;
    }

    const orderedMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (orderedMatch) {
      const itemText = orderedMatch[1] ?? "";
      flushParagraph();
      flushDiff();
      if (!listState || !listState.ordered) {
        flushList();
        listState = { ordered: true, items: [] };
      }
      listState.items.push(itemText);
      return;
    }

    flushList();
    flushDiff();
    paragraphLines.push(line);
  });

  if (inCode) {
    flushCode();
  }
  flushParagraph();
  flushList();
  flushDiff();
  return blocks;
};

const renderMessageItem = (item: ChatItem, itemIndex: number) => {
  if (!item.text) {
    return null;
  }

  const color = resolveItemColor(item);
  const messageLabel = getMessageLabel(item);
  const blocks = parseMarkdownBlocks(item.text);
  const nodes: React.ReactNode[] = [];
  blocks.forEach((block, blockIndex) => {
    if (block.kind === "paragraph") {
      nodes.push(
        renderInlineMarkdownLine(
          block.text,
          `paragraph-${itemIndex}-${blockIndex}`,
          color,
          "  "
        )
      );
      return;
    }

    if (block.kind === "heading") {
      nodes.push(
        <Text
          key={`heading-${itemIndex}-${blockIndex}`}
          color="cyan"
          bold
        >
          {`  ${block.text}`}
        </Text>
      );
      return;
    }

    if (block.kind === "rule") {
      nodes.push(
        <Text key={`rule-${itemIndex}-${blockIndex}`} dimColor>
          {"  ─────────────────────────"}
        </Text>
      );
      return;
    }

    if (block.kind === "list") {
      block.items.forEach((entry, entryIndex) => {
        const marker = block.ordered ? `${entryIndex + 1}. ` : "• ";
        nodes.push(
          renderInlineMarkdownLine(
            entry,
            `list-${itemIndex}-${blockIndex}-${entryIndex}`,
            color,
            `  ${marker}`
          )
        );
      });
      return;
    }

    if (block.kind === "code") {
      nodes.push(
        renderCodeBlock(
          block.content,
          itemIndex * 1000 + blockIndex,
          block.language
        )
      );
      return;
    }

    if (block.kind === "diff") {
      block.lines.forEach((line, lineIndex) => {
        nodes.push(
          <Box key={`diff-${itemIndex}-${blockIndex}-${lineIndex}`} marginTop={1}>
            <Text dimColor>  </Text>
            {renderSegments(
              tokenizeCodeLine(line),
              `diff-token-${itemIndex}-${blockIndex}-${lineIndex}`
            )}
          </Box>
        );
      });
    }
  });

  return (
    <Box key={`item-${itemIndex}`} flexDirection="column" marginBottom={1}>
      <Text bold color={messageLabel.color}>
        {messageLabel.label}
      </Text>
      {nodes}
    </Box>
  );
};

const renderShellHeader = (
  status: ChatStatus,
  activeSessionId: string | null,
  currentModel: string,
  usage: TokenUsage | null,
  pendingCount: number,
  activePanel: string,
  spinner: string
) => {
  const statusBadge = getStatusBadge(status, spinner);
  const queueColor = pendingCount > 0 ? "yellow" : "green";
  const tokenSummary = [
    `Prompt ${usage ? String(usage.promptTokens) : "-"}`,
    `Completion ${usage ? String(usage.completionTokens) : "-"}`,
    `Total ${usage ? String(usage.totalTokens) : "-"}`,
  ].join("  |  ");

  return (
    <Box marginBottom={SECTION_GAP} flexDirection="column">
      <Box>
        <Text bold color="cyan">
          {BRAND_NAME}
        </Text>
        <Text> </Text>
        <Text
          color={statusBadge.textColor}
          backgroundColor={statusBadge.backgroundColor}
        >
          {` ${statusBadge.headerLabel} `}
        </Text>
        <Text> </Text>
        <Text dimColor>model </Text>
        <Text>{shortenValue(currentModel || "none", 22)}</Text>
        <Text dimColor>{`  |  queue `}</Text>
        <Text color={queueColor}>{String(pendingCount)}</Text>
        {activePanel !== "idle" ? (
          <>
            <Text dimColor>{`  |  panel `}</Text>
            <Text dimColor>{activePanel}</Text>
          </>
        ) : null}
      </Box>
      <Text dimColor>
        {`session ${shortenValue(activeSessionId ?? "none", 26)}  |  ${tokenSummary}`}
      </Text>
    </Box>
  );
};

const renderSubtleHeader = (title: string, detail?: string) => (
  <Box justifyContent="space-between" marginBottom={1} flexWrap="wrap">
    <Text bold color="cyan">
      {title}
    </Text>
    {detail ? <Text dimColor>{detail}</Text> : null}
  </Box>
);

const renderPanelHeader = (
  title: string,
  page: PagedResult<unknown>,
  activeSessionId: string | null,
  currentModel: string,
  currentLabel?: string
) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color="cyan">
      {`${title}  page ${page.currentPage}/${page.totalPages}  total ${page.total}`}
    </Text>
    <Text dimColor>
      {`session ${shortenValue(activeSessionId ?? "none", 22)}  |  model ${shortenValue(
        currentModel || "none",
        22
      )}${currentLabel ? `  |  current ${shortenValue(currentLabel, 24)}` : ""}`}
    </Text>
  </Box>
);

const renderPickerItem = (label: string, meta: string, selected: boolean, badge?: string) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={selected ? "cyan" : "gray"}
    paddingX={1}
    paddingY={selected ? 1 : 0}
    marginTop={1}
  >
    <Box justifyContent="space-between" flexWrap="wrap">
      <Box>
        <Text color={selected ? "black" : "gray"} backgroundColor={selected ? "cyan" : undefined}>
          {selected ? "▶ " : "  "}
        </Text>
        <Text> </Text>
        <Text bold color={selected ? "white" : "gray"} backgroundColor={selected ? "blue" : undefined}>
          {selected ? ` ${label} ` : label}
        </Text>
      </Box>
      {badge ? (
        <Text color={selected ? "black" : "cyan"} backgroundColor={selected ? "white" : undefined}>
          {` ${badge} `}
        </Text>
      ) : null}
    </Box>
    {meta ? (
      <Box marginTop={selected ? 1 : 0}>
        <Text dimColor>{meta}</Text>
      </Box>
    ) : null}
  </Box>
);

const getActionTone = (action: PendingReviewItem["request"]["action"]) => {
  if (action === "run_command" || action === "run_shell") {
    return { border: "red", badgeBg: "red", badgeFg: "black" } as const;
  }
  if (action === "delete_file") {
    return { border: "red", badgeBg: "red", badgeFg: "black" } as const;
  }
  if (action === "edit_file") {
    return { border: "yellow", badgeBg: "yellow", badgeFg: "black" } as const;
  }
  if (
    action === "create_file" ||
    action === "write_file" ||
    action === "create_dir" ||
    action === "copy_path" ||
    action === "move_path"
  ) {
    return { border: "cyan", badgeBg: "cyan", badgeFg: "black" } as const;
  }
  return { border: "gray", badgeBg: "gray", badgeFg: "white" } as const;
};

const getApprovalPreviewHeading = (action: PendingReviewItem["request"]["action"]) => {
  switch (action) {
    case "create_file":
      return "Diff preview · new file";
    case "write_file":
      return "Diff preview · write";
    case "edit_file":
      return "Diff preview · edit";
    case "delete_file":
      return "Diff preview · delete";
    case "copy_path":
      return "Path preview · copy";
    case "move_path":
      return "Path preview · move";
    case "run_command":
      return "Process preview";
    case "run_shell":
      return "Shell preview";
    case "create_dir":
      return "Directory preview";
    default:
      return "Preview";
  }
};

const describeApprovalAction = (action: PendingReviewItem["request"]["action"]) => {
  switch (action) {
    case "create_file":
      return "new file";
    case "write_file":
      return "overwrite / write";
    case "edit_file":
      return "targeted edit";
    case "delete_file":
      return "delete";
    case "copy_path":
      return "copy path";
    case "move_path":
      return "move path";
    case "run_command":
      return "process";
    case "run_shell":
      return "shell command";
    case "create_dir":
      return "new directory";
    default:
      return action;
  }
};

const formatApprovalLabel = (label: string) =>
  label
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

const classifyApprovalPreviewLine = (line: string): ApprovalPreviewLine => {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "blank", raw: line };
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return {
      kind: "section",
      raw: line,
      label: trimmed.slice(1, -1),
    };
  }

  if (line.startsWith("@@")) {
    return { kind: "hunk", raw: line };
  }

  const diffMatch = /^([+-])\s*(\d+)?\s*\|\s?(.*)$/.exec(line);
  if (diffMatch) {
    return {
      kind: diffMatch[1] === "+" ? "add" : "remove",
      raw: line,
      lineNumber: diffMatch[2],
      content: diffMatch[3] ?? "",
    };
  }

  if (line.startsWith("+")) {
    return { kind: "add", raw: line, content: line.slice(1).trimStart() };
  }

  if (line.startsWith("-")) {
    return { kind: "remove", raw: line, content: line.slice(1).trimStart() };
  }

  const metaMatch = /^([a-z][a-z0-9_ ]*):\s*(.*)$/i.exec(trimmed);
  if (metaMatch) {
    const [, key = "", value = ""] = metaMatch;
    return {
      kind: "kv",
      raw: line,
      key: key.trim(),
      value,
    };
  }

  return { kind: "context", raw: line };
};

const renderApprovalSummaryRow = (
  label: string,
  value: string,
  accent?: "cyan" | "yellow" | "red" | "green" | "magenta" | "white"
) => (
  <Box>
    <Text dimColor>· </Text>
    <Text dimColor>{`${label.padEnd(12, " ")} `}</Text>
    <Text color={accent ?? "white"}>{value}</Text>
  </Box>
);

const getApprovalDiffGutterWidth = (lines: string[]) => {
  const widest = lines.reduce((max, line) => {
    const match = /^[+-]\s*(\d+)\s*\|/.exec(line);
    return Math.max(max, match?.[1]?.length ?? 0);
  }, 0);
  return Math.max(4, widest);
};

const renderApprovalLine = (
  line: string,
  index: number,
  action: PendingReviewItem["request"]["action"],
  gutterWidth: number
) => {
  const parsed = classifyApprovalPreviewLine(line);

  if (parsed.kind === "blank") {
    return <Text key={`approval-line-${index}`}> </Text>;
  }

  if (parsed.kind === "section") {
    return (
      <Box key={`approval-section-${index}`}>
        <Text dimColor>┌ </Text>
        <Text dimColor>{`${" ".repeat(gutterWidth)}   `}</Text>
        <Text color="cyan" bold>
          {`Section  ${parsed.label ?? "preview"}`}
        </Text>
      </Box>
    );
  }

  if (parsed.kind === "hunk") {
    return (
      <Box key={`approval-hunk-${index}`}>
        <Text dimColor>│ </Text>
        <Text dimColor>{`${" ".repeat(gutterWidth)} │ `}</Text>
        <Text color="cyan" bold>
          {`Hunk  ${parsed.raw}`}
        </Text>
      </Box>
    );
  }

  if (parsed.kind === "add" || parsed.kind === "remove") {
    const tone = parsed.kind === "add" ? "green" : "red";
    return (
      <Box key={`approval-diff-${index}`}>
        <Text color={tone}>{parsed.kind === "add" ? "+" : "-"}</Text>
        <Text> </Text>
        <Text dimColor>
          {parsed.lineNumber
            ? `${parsed.lineNumber.padStart(gutterWidth, " ")} │ `
            : `${" ".repeat(gutterWidth)} · `}
        </Text>
        {renderSegments(tokenizeCodeLine(parsed.content ?? ""), `approval-token-${index}`)}
      </Box>
    );
  }

  if (parsed.kind === "kv") {
    const key = parsed.key ?? "value";
    const keyTone =
      key === "command"
        ? "yellow"
        : key === "shell" || key === "risk"
          ? "red"
        : key === "source" || key === "destination"
          ? "cyan"
          : key === "cwd"
            ? "magenta"
            : "white";
    const borderColor =
      action === "run_command" || action === "run_shell"
        ? "red"
        : key === "source" || key === "destination"
          ? "cyan"
          : "gray";
    return (
      <Box key={`approval-kv-${index}`}>
        <Text color={borderColor}>› </Text>
        <Text dimColor>{`${" ".repeat(gutterWidth)} · `}</Text>
        <Text dimColor>{`${formatApprovalLabel(key)} `}</Text>
        <Text color={keyTone}>{parsed.value || "(empty)"}</Text>
      </Box>
    );
  }

  return (
    <Box key={`approval-context-${index}`}>
      <Text dimColor>· </Text>
      <Text dimColor>{`${" ".repeat(gutterWidth)} · `}</Text>
      <Text color="gray">{parsed.raw}</Text>
    </Box>
  );
};

const renderApprovalPanel = (
  pendingReviews: PendingReviewItem[],
  approvalPanel: ChatScreenProps["approvalPanel"],
  currentModel: string,
  activeSessionId: string | null
) => {
  const selectedPending = pendingReviews[approvalPanel.selectedIndex];
  if (!selectedPending) {
    return null;
  }

  const selectedBlocked = approvalPanel.blockedItemId === selectedPending.id;
  const selectedInFlight = approvalPanel.inFlightId === selectedPending.id;
  const blockedReason = approvalPanel.blockedReason?.trim() ?? "";
  const tone = getActionTone(selectedPending.request.action);
  const approvalState = selectedInFlight
    ? `${approvalPanel.actionState ?? "approve"}...`
    : selectedBlocked
      ? "blocked"
      : "ready";
  const previewSource =
    approvalPanel.previewMode === "full"
      ? selectedPending.previewFull
      : selectedPending.previewSummary;
  const previewWindow = getPreviewWindow(previewSource, approvalPanel.previewOffset);
  const diffGutterWidth = getApprovalDiffGutterWidth(previewWindow.pageLines);
  const queueStart = Math.max(0, approvalPanel.selectedIndex - 2);
  const queueItems = pendingReviews.slice(
    queueStart,
    Math.min(pendingReviews.length, approvalPanel.selectedIndex + 3)
  );

  return (
    <Box
      marginBottom={SECTION_GAP}
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
    >
      <Box justifyContent="space-between" flexWrap="wrap" marginBottom={1}>
        <Text bold color="yellow">
          Code Approval
        </Text>
        <Text dimColor>
          {`focus ${approvalPanel.selectedIndex + 1}/${pendingReviews.length}  |  ${approvalPanel.previewMode}  |  ${approvalState}  |  session ${shortenValue(activeSessionId ?? "none", 12)}  |  model ${shortenValue(currentModel, 12)}`}
        </Text>
      </Box>

      <Text dimColor>
        {`current ${selectedPending.id}  |  ${selectedPending.request.action}  |  ${selectedPending.request.path}`}
      </Text>
      <Text dimColor>{selectedPending.createdAt}</Text>
      {selectedInFlight ? (
        <Box flexDirection="column">
          <Text color="cyan">
            {`${approvalPanel.actionState === "reject" ? "Rejecting" : "Approving"} current item...`}
          </Text>
          <Text dimColor>hotkeys locked until the current approval action finishes</Text>
        </Box>
      ) : null}
      {selectedBlocked ? (
        <Box flexDirection="column">
          <Text color="red">
            {`Last error: ${shortenValue(blockedReason || "approval failed", 120)}`}
          </Text>
          <Text dimColor>
            approve blocked for current item  |  ↑/↓ switch  |  r/d reject  |  a retry after cooldown
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        {queueItems.map((item, localIndex) => {
          const index = queueStart + localIndex;
          const selected = index === approvalPanel.selectedIndex;
          const tone = getActionTone(item.request.action);
          const blocked = approvalPanel.blockedItemId === item.id;
          const inFlight = approvalPanel.inFlightId === item.id;
          return (
            <Box key={`review-list-${item.id}`}>
              <Text
                color={selected ? "black" : "gray"}
                backgroundColor={selected ? "cyan" : undefined}
              >
                {selected ? " > " : "   "}
              </Text>
              <Text> </Text>
              <Text
                color={selected ? "black" : tone.badgeFg}
                backgroundColor={selected ? "white" : tone.badgeBg}
              >
                {` ${item.request.action} `}
              </Text>
              <Text> </Text>
              <Text
                color={selected ? "black" : "gray"}
                backgroundColor={selected ? "cyan" : undefined}
              >
                {shortenValue(item.request.path, 72)}
              </Text>
              {blocked ? (
                <>
                  <Text> </Text>
                  <Text color="black" backgroundColor="red">
                    {" blocked "}
                  </Text>
                </>
              ) : null}
              {inFlight ? (
                <>
                  <Text> </Text>
                  <Text color="black" backgroundColor="cyan">
                    {` ${approvalPanel.actionState ?? "busy"} `}
                  </Text>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Text color="cyan">Action summary</Text>
      <Box flexDirection="column">
        <Box justifyContent="space-between" flexWrap="wrap">
          <Text color={tone.badgeFg} backgroundColor={tone.badgeBg}>
            {` ${selectedPending.request.action} `}
          </Text>
          <Text dimColor>{describeApprovalAction(selectedPending.request.action)}</Text>
        </Box>
        {renderApprovalSummaryRow("Path", selectedPending.request.path, "white")}
        {"destination" in selectedPending.request ? (
          renderApprovalSummaryRow("Destination", selectedPending.request.destination, "cyan")
        ) : null}
        {"command" in selectedPending.request ? (
          <>
            {"action" in selectedPending.request && selectedPending.request.action === "run_shell"
              ? renderApprovalSummaryRow("Shell", "platform default", "red")
              : null}
            {renderApprovalSummaryRow("Command", selectedPending.request.command, "yellow")}
            {"args" in selectedPending.request && selectedPending.request.args.length > 0
              ? renderApprovalSummaryRow("Args", selectedPending.request.args.join(" "), "white")
              : null}
            {renderApprovalSummaryRow("Cwd", selectedPending.request.cwd ?? ".", "magenta")}
          </>
        ) : null}
        {renderApprovalSummaryRow("Preview mode", approvalPanel.previewMode, "cyan")}
        {renderApprovalSummaryRow(
          "State",
          approvalState,
          selectedBlocked ? "red" : selectedInFlight ? "yellow" : "green"
        )}
      </Box>

      <Text color="cyan">
        {`${getApprovalPreviewHeading(selectedPending.request.action)}  ${previewWindow.safeOffset + 1}-${Math.min(
          previewWindow.safeOffset + previewWindow.pageLines.length,
          previewWindow.totalLines
        )}/${previewWindow.totalLines}`}
      </Text>
      <Box flexDirection="column">
        {previewWindow.pageLines.map((line, index) =>
          renderApprovalLine(line, index, selectedPending.request.action, diffGutterWidth)
        )}
      </Box>

      <Text dimColor>
        Up/Down: select  Tab: summary/full  j/k or PgUp/PgDn: scroll  a: approve/retry  r/d: reject  Esc: close
      </Text>
    </Box>
  );
};

const renderSimplePanel = (
  title: string,
  page: PagedResult<any>,
  activeSessionId: string | null,
  currentModel: string,
  currentLabel: string | undefined,
  rows: React.ReactNode,
  footer: string
) => (
  <Box
    marginBottom={SECTION_GAP}
    flexDirection="column"
    borderStyle="round"
    borderColor="gray"
    paddingX={1}
    paddingY={1}
  >
    {renderPanelHeader(title, page, activeSessionId, currentModel, currentLabel)}
    {rows}
    <Text dimColor>{footer}</Text>
  </Box>
);

const renderCompactPanelHeader = (
  title: string,
  page: PagedResult<unknown>,
  activeSessionId: string | null,
  currentModel: string,
  currentLabel?: string
) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color="cyan">
      {`${title}  page ${page.currentPage}/${page.totalPages}  total ${page.total}`}
    </Text>
    <Text dimColor>
      {`session ${shortenValue(activeSessionId ?? "none", 22)}  |  model ${shortenValue(
        currentModel || "none",
        22
      )}${currentLabel ? `  |  current ${shortenValue(currentLabel, 24)}` : ""}`}
    </Text>
  </Box>
);

const renderCompactPickerItem = (
  label: string,
  meta: string,
  selected: boolean,
  badge?: string
) => (
  <Box flexDirection="column" marginTop={1}>
    <Text
      color={selected ? "black" : "white"}
      backgroundColor={selected ? "cyan" : undefined}
    >
      {`${selected ? "> " : "  "}${label}${badge ? `  [${badge}]` : ""}`}
    </Text>
    {meta ? <Text dimColor>{`   ${meta}`}</Text> : null}
  </Box>
);

const renderCompactSimplePanel = (
  title: string,
  page: PagedResult<any>,
  activeSessionId: string | null,
  currentModel: string,
  currentLabel: string | undefined,
  rows: React.ReactNode,
  footer: string
) => (
  <Box marginBottom={SECTION_GAP} flexDirection="column">
    {renderCompactPanelHeader(title, page, activeSessionId, currentModel, currentLabel)}
    {rows}
    <Text dimColor>{footer}</Text>
  </Box>
);

const renderCompactApprovalSummaryRow = (
  label: string,
  value: string,
  accent?: "cyan" | "yellow" | "red" | "green" | "magenta" | "white"
) => (
  <Box>
    <Text dimColor>{`${label}: `}</Text>
    <Text color={accent ?? "white"}>{value}</Text>
  </Box>
);

const renderCompactApprovalLine = (
  line: string,
  index: number,
  action: PendingReviewItem["request"]["action"],
  gutterWidth: number
) => {
  const parsed = classifyApprovalPreviewLine(line);

  if (parsed.kind === "blank") {
    return <Text key={`approval-line-${index}`}> </Text>;
  }

  if (parsed.kind === "section") {
    return (
      <Text key={`approval-section-${index}`} dimColor>
        {`[${parsed.label ?? "preview"}]`}
      </Text>
    );
  }

  if (parsed.kind === "hunk") {
    return (
      <Text
        key={`approval-hunk-${index}`}
        color="black"
        backgroundColor="cyan"
      >
        {` ${parsed.raw} `}
      </Text>
    );
  }

  if (parsed.kind === "add" || parsed.kind === "remove") {
    const backgroundColor = parsed.kind === "add" ? "green" : "red";
    const marker = parsed.kind === "add" ? "+" : "-";
    const lineNumber = parsed.lineNumber
      ? parsed.lineNumber.padStart(gutterWidth, " ")
      : " ".repeat(gutterWidth);
    return (
      <Text
        key={`approval-diff-${index}`}
        color="black"
        backgroundColor={backgroundColor}
      >
        {` ${marker} ${lineNumber} | ${parsed.content ?? ""} `}
      </Text>
    );
  }

  if (parsed.kind === "kv") {
    const key = parsed.key ?? "value";
    const keyTone =
      key === "command"
        ? "yellow"
        : key === "shell" || key === "risk"
          ? "red"
        : key === "source" || key === "destination"
          ? "cyan"
          : key === "cwd"
            ? "magenta"
            : "white";
    return (
      <Box key={`approval-kv-${index}`}>
        <Text dimColor>{`${formatApprovalLabel(key)}: `}</Text>
        <Text color={keyTone}>{parsed.value || "(empty)"}</Text>
      </Box>
    );
  }

  const tone = action === "run_command" || action === "run_shell" ? "white" : "gray";
  return (
    <Text key={`approval-context-${index}`} color={tone}>
      {parsed.raw}
    </Text>
  );
};

const renderCompactApprovalPanel = (
  pendingReviews: PendingReviewItem[],
  approvalPanel: ChatScreenProps["approvalPanel"],
  currentModel: string,
  activeSessionId: string | null
) => {
  const selectedPending = pendingReviews[approvalPanel.selectedIndex];
  if (!selectedPending) {
    return null;
  }

  const selectedBlocked = approvalPanel.blockedItemId === selectedPending.id;
  const selectedInFlight = approvalPanel.inFlightId === selectedPending.id;
  const blockedReason = approvalPanel.blockedReason?.trim() ?? "";
  const approvalState = selectedInFlight
    ? `${approvalPanel.actionState ?? "approve"}...`
    : selectedBlocked
      ? "blocked"
      : "ready";
  const previewSource =
    approvalPanel.previewMode === "full"
      ? selectedPending.previewFull
      : selectedPending.previewSummary;
  const previewWindow = getPreviewWindow(previewSource, approvalPanel.previewOffset);
  const diffGutterWidth = getApprovalDiffGutterWidth(previewWindow.pageLines);
  const queueStart = Math.max(0, approvalPanel.selectedIndex - 2);
  const queueItems = pendingReviews.slice(
    queueStart,
    Math.min(pendingReviews.length, approvalPanel.selectedIndex + 3)
  );

  return (
    <Box marginBottom={SECTION_GAP} flexDirection="column">
      <Text bold color="yellow">
        {`Code Approval  ${approvalPanel.selectedIndex + 1}/${pendingReviews.length}  |  ${approvalPanel.previewMode}  |  ${approvalState}`}
      </Text>
      <Text dimColor>
        {`session ${shortenValue(activeSessionId ?? "none", 12)}  |  model ${shortenValue(currentModel, 12)}`}
      </Text>
      <Text dimColor>
        {`current ${selectedPending.id}  |  ${selectedPending.request.action}  |  ${selectedPending.request.path}`}
      </Text>
      <Text dimColor>{selectedPending.createdAt}</Text>

      {selectedInFlight ? (
        <Box flexDirection="column">
          <Text color="cyan">
            {`${approvalPanel.actionState === "reject" ? "Rejecting" : "Approving"} current item...`}
          </Text>
          <Text dimColor>hotkeys locked until the current approval action finishes</Text>
        </Box>
      ) : null}

      {selectedBlocked ? (
        <Box flexDirection="column">
          <Text color="red">
            {`Last error: ${shortenValue(blockedReason || "approval failed", 120)}`}
          </Text>
          <Text dimColor>
            approve blocked for current item  |  ↑/↓ switch  |  r/d reject  |  a retry after cooldown
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {queueItems.map((item, localIndex) => {
          const index = queueStart + localIndex;
          const selected = index === approvalPanel.selectedIndex;
          const blocked = approvalPanel.blockedItemId === item.id;
          const inFlight = approvalPanel.inFlightId === item.id;
          return (
            <Box key={`compact-review-list-${item.id}`}>
              <Text
                color={selected ? "black" : "white"}
                backgroundColor={selected ? "cyan" : undefined}
              >
                {`${selected ? "> " : "  "}${item.request.action}  ${shortenValue(item.request.path, 72)}`}
              </Text>
              {blocked ? (
                <>
                  <Text> </Text>
                  <Text color={selected ? "black" : "red"}>blocked</Text>
                </>
              ) : null}
              {inFlight ? (
                <>
                  <Text> </Text>
                  <Text color={selected ? "black" : "cyan"}>
                    {approvalPanel.actionState ?? "busy"}
                  </Text>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Text color="cyan">Action summary</Text>
      <Text dimColor>{describeApprovalAction(selectedPending.request.action)}</Text>
      <Box flexDirection="column">
        {renderCompactApprovalSummaryRow("Path", selectedPending.request.path, "white")}
        {"destination" in selectedPending.request ? (
          renderCompactApprovalSummaryRow(
            "Destination",
            selectedPending.request.destination,
            "cyan"
          )
        ) : null}
        {"command" in selectedPending.request ? (
          <>
            {"action" in selectedPending.request &&
            selectedPending.request.action === "run_shell"
              ? renderCompactApprovalSummaryRow("Shell", "platform default", "red")
              : null}
            {renderCompactApprovalSummaryRow(
              "Command",
              selectedPending.request.command,
              "yellow"
            )}
            {"args" in selectedPending.request &&
            selectedPending.request.args.length > 0
              ? renderCompactApprovalSummaryRow(
                  "Args",
                  selectedPending.request.args.join(" "),
                  "white"
                )
              : null}
            {renderCompactApprovalSummaryRow(
              "Cwd",
              selectedPending.request.cwd ?? ".",
              "magenta"
            )}
          </>
        ) : null}
        {renderCompactApprovalSummaryRow(
          "Preview mode",
          approvalPanel.previewMode,
          "cyan"
        )}
        {renderCompactApprovalSummaryRow(
          "State",
          approvalState,
          selectedBlocked ? "red" : selectedInFlight ? "yellow" : "green"
        )}
      </Box>

      <Text color="cyan">
        {`${getApprovalPreviewHeading(selectedPending.request.action)}  ${previewWindow.safeOffset + 1}-${Math.min(
          previewWindow.safeOffset + previewWindow.pageLines.length,
          previewWindow.totalLines
        )}/${previewWindow.totalLines}`}
      </Text>
      <Box flexDirection="column">
        {previewWindow.pageLines.map((line, index) =>
          renderCompactApprovalLine(
            line,
            index,
            selectedPending.request.action,
            diffGutterWidth
          )
        )}
      </Box>

      <Text dimColor>
        Up/Down: select  Tab: summary/full  j/k or PgUp/PgDn: scroll  a: approve/retry  r/d: reject  Esc: close
      </Text>
    </Box>
  );
};

export const ChatScreen = ({
  items,
  liveAssistantText,
  status,
  input,
  inputCommandState,
  resumePicker,
  sessionsPanel,
  modelPicker,
  pendingReviews,
  approvalPanel,
  activeSessionId,
  currentModel,
  usage,
  onInputChange,
  onSubmit,
}: ChatScreenProps) => {
  const [spinnerIndex, setSpinnerIndex] = React.useState(0);
  const approvalModeActive = approvalPanel.active;
  const shouldAnimateStreaming = ENABLE_STREAMING_ANIMATION && !approvalModeActive;

  React.useEffect(() => {
    if (status !== "streaming" || !shouldAnimateStreaming) {
      setSpinnerIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerIndex(previous => (previous + 1) % SPINNER_FRAMES.length);
    }, 220);
    return () => clearInterval(timer);
  }, [shouldAnimateStreaming, status]);

  const resumePage = React.useMemo(
    () => formatPaged(resumePicker.sessions, resumePicker.selectedIndex, resumePicker.pageSize),
    [resumePicker.pageSize, resumePicker.selectedIndex, resumePicker.sessions]
  );
  const sessionsPage = React.useMemo(
    () => formatPaged(sessionsPanel.sessions, sessionsPanel.selectedIndex, sessionsPanel.pageSize),
    [sessionsPanel.pageSize, sessionsPanel.selectedIndex, sessionsPanel.sessions]
  );
  const modelPage = React.useMemo(
    () => formatPaged(modelPicker.models, modelPicker.selectedIndex, modelPicker.pageSize),
    [modelPicker.models, modelPicker.pageSize, modelPicker.selectedIndex]
  );

  const isPanelActive =
    resumePicker.active ||
    sessionsPanel.active ||
    modelPicker.active ||
    approvalPanel.active;
  const activePanel = sessionsPanel.active
    ? "sessions"
    : resumePicker.active
      ? "resume"
      : modelPicker.active
        ? "models"
        : approvalPanel.active
          ? "approval"
          : "idle";

  const transcriptNodes = React.useMemo(
    () => items.map((item, index) => renderMessageItem(item, index)),
    [items]
  );
  const liveAssistantNode = React.useMemo(
    () =>
      liveAssistantText
        ? renderMessageItem(
            {
              role: "assistant",
              text: liveAssistantText,
              kind: "transcript",
              tone: "neutral",
            },
            items.length
          )
        : null,
    [items.length, liveAssistantText]
  );

  const spinner = shouldAnimateStreaming
    ? SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] || STREAMING_IDLE_GLYPH
    : STREAMING_IDLE_GLYPH;
  const statusBadge = getStatusBadge(status, spinner);
  const topSuggestions = inputCommandState.suggestions.slice(0, 3);
  const suggestionSummary = topSuggestions
    .map(suggestion => `${suggestion.command} ${suggestion.description}`)
    .join("  ·  ");
  const pendingSummary = pendingReviews[approvalPanel.selectedIndex]
    ? `${pendingReviews[approvalPanel.selectedIndex]?.request.action}  |  ${pendingReviews[approvalPanel.selectedIndex]?.request.path}`
    : "no active review";

  if (approvalModeActive) {
    return (
      <Box flexDirection="column">
        {renderCompactApprovalPanel(
          pendingReviews,
          approvalPanel,
          currentModel,
          activeSessionId
        )}

        <Box flexShrink={0} flexDirection="column">
          <Text dimColor>approval panel active</Text>
          <Box>
            <Text color="yellow">Review mode</Text>
            <Text> </Text>
            <TextInput
              value={input}
              focus={false}
              onChange={onInputChange}
              onSubmit={onSubmit}
              placeholder="Approval panel active..."
            />
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {renderShellHeader(
        status,
        activeSessionId,
        currentModel,
        usage,
        pendingReviews.length,
        activePanel,
        spinner
      )}
      <Box marginBottom={SECTION_GAP} flexDirection="column">
        {transcriptNodes}
        {liveAssistantNode}
      </Box>

      {sessionsPanel.active &&
        renderCompactSimplePanel(
          "Sessions",
          sessionsPage,
          activeSessionId,
          currentModel,
          activeSessionId ?? undefined,
          sessionsPage.pageItems.map((session, localIndex) => {
            const index = sessionsPage.pageStart + localIndex;
            const selected = index === sessionsPanel.selectedIndex;
            const isCurrent = session.id === activeSessionId;
            const meta = `${session.updatedAt}${session.title ? `  |  ${session.title}` : ""}`;
            return (
              <React.Fragment key={`session-picker-${session.id}`}>
                {renderCompactPickerItem(
                  session.id,
                  meta,
                  selected,
                  isCurrent ? "current" : undefined
                )}
              </React.Fragment>
            );
          }),
          "Up/Down: select  Left/Right: page  Enter: resume  Esc: close"
        )}

      {resumePicker.active &&
        renderCompactSimplePanel(
          "Resume",
          resumePage,
          activeSessionId,
          currentModel,
          activeSessionId ?? undefined,
          resumePage.pageItems.map((session, localIndex) => {
            const index = resumePage.pageStart + localIndex;
            const selected = index === resumePicker.selectedIndex;
            const isCurrent = session.id === activeSessionId;
            const meta = `${session.updatedAt}${session.title ? `  |  ${session.title}` : ""}`;
            return (
              <React.Fragment key={`resume-picker-${session.id}`}>
                {renderCompactPickerItem(
                  session.id,
                  meta,
                  selected,
                  isCurrent ? "current" : undefined
                )}
              </React.Fragment>
            );
          }),
          "Up/Down: select  Left/Right: page  Enter: resume  Esc: close"
        )}

      {modelPicker.active &&
        renderCompactSimplePanel(
          "Models",
          modelPage,
          activeSessionId,
          currentModel,
          currentModel,
          modelPage.pageItems.map((model, localIndex) => {
            const index = modelPage.pageStart + localIndex;
            const selected = index === modelPicker.selectedIndex;
            return (
              <React.Fragment key={`model-picker-${model}-${index}`}>
                {renderCompactPickerItem(
                  model,
                  model === currentModel ? "currently active" : "",
                  selected,
                  model === currentModel ? "current" : undefined
                )}
              </React.Fragment>
            );
          }),
          "Up/Down: select  Left/Right: page  Enter: switch  Esc: close"
        )}

      {pendingReviews.length > 0 && (
        <Text color="yellow" dimColor>
          {`review ${pendingReviews.length} pending  |  ${pendingSummary}`}
        </Text>
      )}

      {approvalPanel.active
        ? renderCompactApprovalPanel(
            pendingReviews,
            approvalPanel,
            currentModel,
            activeSessionId
          )
        : null}

      <Box flexShrink={0} flexDirection="column">
        <Box>
          <Text color={statusBadge.inputColor}>
            {statusBadge.inputLabel}
          </Text>
          <Text> </Text>
          <TextInput
            value={input}
            focus={!isPanelActive}
            onChange={onInputChange}
            onSubmit={onSubmit}
            placeholder={isPanelActive ? "Panel active..." : "Ask something..."}
          />
        </Box>
        {!isPanelActive && inputCommandState.active ? (
          <Text dimColor>
            {`commands  ${suggestionSummary}`}
          </Text>
        ) : null}
        {!isPanelActive && inputCommandState.historyPosition !== null ? (
          <Text dimColor>
            {`history ${inputCommandState.historyPosition}/${inputCommandState.historySize}  |  Up/Down recall input`}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};
