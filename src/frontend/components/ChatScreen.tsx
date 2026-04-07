import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import {
  getComposerHint,
  type ComposerKeymap,
} from "../../application/chat/composerKeymap";
import {
  clampCursorOffset,
  getCursorPosition,
  getInputLines,
} from "../../application/chat/multilineInput";
import type { PendingReviewItem } from "../../core/mcp";
import type { TokenUsage } from "../../core/query/tokenUsage";
import type { SessionListItem } from "../../core/session/types";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";
import type { AuthStatus } from "../../infra/auth/types";

type ChatScreenProps = {
  items: ChatItem[];
  liveAssistantText: string;
  status: ChatStatus;
  appRoot: string;
  input: string;
  inputCursorOffset: number;
  inputCommandState: {
    active: boolean;
    mode: "idle" | "command" | "file" | "shell";
    currentCommand: string | null;
    suggestions: Array<{
      command: string;
      description: string;
      group?: string;
      matchRanges?: MatchRange[];
      baseCommand?: string;
      template?: string | null;
      argumentHints?: Array<{
        label: string;
        optional: boolean;
      }>;
      insertValue?: string;
    }>;
    selectedIndex: number;
    historyPosition: number | null;
    historySize: number;
    shellShortcut: {
      active: boolean;
      action:
        | "run_shell"
        | "open_shell"
        | "read_shell"
        | "shell_status"
        | "interrupt_shell"
        | "close_shell"
        | null;
      command: string;
      actionLabel: string;
      description: string;
    };
    fileMentions: {
      references: string[];
      activeQuery: string | null;
      suggestions: Array<{
        path: string;
        description: string;
      }>;
      loading: boolean;
      preview?: {
        path: string | null;
        text: string;
        meta: string | null;
        loading: boolean;
      };
    };
  };
  shellSession: {
    visible: boolean;
    status: "none" | "idle" | "running" | "exited" | "closed";
    shell: string | null;
    cwd: string | null;
    busy: boolean;
    alive: boolean;
    pendingOutput: boolean;
    lastExit: string | null;
    lastEvent: "opened" | "interrupted" | null;
    openedAt?: number | null;
    runningSince?: number | null;
    lastOutputSummary?: string | null;
    lastOutputAt?: number | null;
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
  providerPicker: {
    active: boolean;
    providers: string[];
    selectedIndex: number;
    pageSize: number;
    currentKeySource?: string | null;
    providerProfiles?: Record<
      string,
      "openai" | "gemini" | "anthropic" | "custom" | "local" | "none"
    >;
    providerProfileSources?: Record<
      string,
      "manual" | "inferred" | "local" | "none"
    >;
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
  authPanel: {
    active: boolean;
    mode: "auto_onboarding" | "manual_login";
    step: "provider" | "api_key" | "model" | "confirm";
    providerBaseUrl: string;
    apiKey: string;
    model: string;
    cursorOffset: number;
    error: string | null;
    info: string | null;
    saving: boolean;
    persistenceTarget: AuthStatus["persistenceTarget"];
  };
  authStatus: AuthStatus;
  composerKeymap: ComposerKeymap;
  activeSessionId: string | null;
  currentModel: string;
  currentProvider: string;
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

type MatchRange = {
  start: number;
  end: number;
};

type CommandArgumentHint = {
  label: string;
  optional: boolean;
};

type CommandTemplateMeta = {
  baseCommand: string;
  template: string | null;
  argumentHints: CommandArgumentHint[];
  insertValue: string;
};

type InkTone = ChatItem["color"] | string;

type CodeSegment = {
  text: string;
  color?: InkTone;
  backgroundColor?: InkTone;
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
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{
        text: string;
        marker?: string;
      }>;
    }
  | { kind: "code"; language?: string; content: string }
  | { kind: "diff"; lines: string[] }
  | { kind: "rule" };

type TerminalTranscript = {
  action: string;
  shell?: string;
  commandLine: string;
  metaParts: string[];
  outputLines: string[];
};

type RenderClipResult = {
  text: string;
  clipped: boolean;
  hiddenLines: number;
  hiddenChars: number;
};

type RenderClipOptions = {
  maxLines?: number;
  maxChars?: number;
  preferTail?: boolean;
  suppressNotice?: boolean;
};

type WrappedComposerSegment = {
  text: string;
  startOffset: number;
  endOffset: number;
};

type ComposerVisualRow = {
  prefix: string;
  text: string;
  isCursorRow: boolean;
  cursorColumn: number;
};

type ComposerTone = {
  borderColor: "gray" | "cyan" | "yellow" | "magenta" | "red";
  panelBorderColor: "cyan" | "yellow" | "magenta" | "red";
  chipBackground: "cyan" | "yellow" | "magenta" | "red";
  chipText: "black";
  chipLabel:
    | "READY"
    | "PREPARING"
    | "REQUESTING"
    | "WORKING"
    | "REVIEW"
    | "ERROR";
  metaLabel: string;
  promptColor: "cyan" | "yellow" | "magenta" | "red";
  helperColor: "gray" | "cyan" | "yellow" | "magenta" | "red";
};

type GraphemeSegment = {
  text: string;
  startOffset: number;
  endOffset: number;
};

const APP_NAME = "Cyrene Code";
const SECTION_GAP = 1;
const SPINNER_FRAMES = [".", "o", "O", "o"];
const STREAMING_IDLE_GLYPH = "*";
const ENABLE_STREAMING_ANIMATION = process.env.CYRENE_ANIMATE_STREAMING === "1";
const MAX_COMPOSER_VISIBLE_LINES = 6;
const COMPOSER_CURSOR_GLYPH = "|";
const DEFAULT_TERMINAL_COLUMNS = 80;
const COMPOSER_CHROME_WIDTH = 24;
const MIN_COMPOSER_WRAP_WIDTH = 16;
const MAX_COMPOSER_WRAP_WIDTH = 96;
const APPROVAL_DIFF_ADD_FOREGROUND = "#dcfce7";
const APPROVAL_DIFF_ADD_BACKGROUND = "#14532d";
const APPROVAL_DIFF_REMOVE_FOREGROUND = "#fee2e2";
const APPROVAL_DIFF_REMOVE_BACKGROUND = "#7f1d1d";
const APPROVAL_DIFF_ADD_ACCENT = "#166534";
const APPROVAL_DIFF_REMOVE_ACCENT = "#991b1b";
const MAX_RENDERED_TRANSCRIPT_ITEMS = 80;
const MAX_TRANSCRIPT_WINDOW_LINES = 20_000;
const MAX_TRANSCRIPT_WINDOW_CHARS = 1_000_000;
const MAX_RENDER_TEXT_LINES = 420;
const MAX_RENDER_TEXT_CHARS = 24000;
const MAX_STREAMING_RENDER_TEXT_LINES = 48;
const MAX_STREAMING_RENDER_TEXT_CHARS = 4000;
const MAX_RENDERED_TERMINAL_OUTPUT_LINES = 220;
const MAX_COMPACT_TERMINAL_OUTPUT_LINES = 2;
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

const clipPreviewLine = (value: string, max = 88) =>
  value.length <= max ? value : `${value.slice(0, Math.max(1, max - 3))}...`;

const getSlashInsertValue = (command: string) => {
  switch (command) {
    case "/provider <url>":
      return "/provider ";
    case "/provider profile <openai|gemini|anthropic|custom> [url]":
      return "/provider profile ";
    case "/provider profile clear [url]":
      return "/provider profile clear ";
    case "/model <name>":
      return "/model ";
    case "/system <text>":
      return "/system ";
    case "/resume <id>":
      return "/resume ";
    case "/search-session <query>":
      return "/search-session ";
    case "/search-session #<tag> [query]":
      return "/search-session #";
    case "/tag add <tag>":
      return "/tag add ";
    case "/tag remove <tag>":
      return "/tag remove ";
    case "/pin <note>":
      return "/pin ";
    case "/unpin <index>":
      return "/unpin ";
    case "/skills enable <id>":
      return "/skills enable ";
    case "/skills disable <id>":
      return "/skills disable ";
    case "/skills remove <id>":
      return "/skills remove ";
    case "/skills use <id>":
      return "/skills use ";
    case "/skills show <id>":
      return "/skills show ";
    case "/review <id>":
      return "/review ";
    case "/approve [id]":
      return "/approve ";
    case "/reject [id]":
      return "/reject ";
    default:
      return command;
  }
};

const getCommandTemplateMeta = (
  suggestion: ChatScreenProps["inputCommandState"]["suggestions"][number]
): CommandTemplateMeta => {
  if (
    suggestion.baseCommand &&
    Array.isArray(suggestion.argumentHints) &&
    "insertValue" in suggestion
  ) {
    return {
      baseCommand: suggestion.baseCommand,
      template:
        typeof suggestion.template === "string" ? suggestion.template : null,
      argumentHints: suggestion.argumentHints,
      insertValue:
        typeof suggestion.insertValue === "string"
          ? suggestion.insertValue
          : getSlashInsertValue(suggestion.command),
    };
  }

  const [baseCommand = suggestion.command, ...rest] = suggestion.command
    .trim()
    .split(/\s+/);
  const template = rest.length > 0 ? rest.join(" ") : null;
  const argumentHints: CommandArgumentHint[] = [];
  const argumentPattern = /#?<([^>]+)>|\[([^\]]+)\]/g;
  let match: RegExpExecArray | null = null;

  while ((match = argumentPattern.exec(template ?? "")) !== null) {
    const label = (match[1] ?? match[2] ?? "").trim().replace(/^#/, "");
    if (!label) {
      continue;
    }
    argumentHints.push({
      label,
      optional: Boolean(match[2]),
    });
  }

  return {
    baseCommand,
    template,
    argumentHints,
    insertValue: getSlashInsertValue(suggestion.command),
  };
};

const sliceMatchRanges = (
  ranges: MatchRange[] = [],
  start: number,
  end: number
) =>
  ranges
    .map(range => ({
      start: Math.max(start, range.start),
      end: Math.min(end, range.end),
    }))
    .filter(range => range.end > range.start)
    .map(range => ({
      start: range.start - start,
      end: range.end - start,
    }));

const buildHighlightSegments = (text: string, ranges: MatchRange[] = []) => {
  if (ranges.length === 0) {
    return [{ text, highlight: false }];
  }

  const ordered = [...ranges].sort((left, right) =>
    left.start === right.start ? left.end - right.end : left.start - right.start
  );
  const segments: Array<{ text: string; highlight: boolean }> = [];
  let cursor = 0;

  for (const range of ordered) {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));

    if (start > cursor) {
      segments.push({
        text: text.slice(cursor, start),
        highlight: false,
      });
    }

    if (end > start) {
      segments.push({
        text: text.slice(start, end),
        highlight: true,
      });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      highlight: false,
    });
  }

  return segments.filter(segment => segment.text.length > 0);
};

const renderHighlightedText = (
  text: string,
  ranges: MatchRange[] | undefined,
  options: {
    selected?: boolean;
    tone: ComposerTone;
    baseColor?: InkTone;
    highlightColor?: InkTone;
    dimColor?: boolean;
  }
) => (
  <Text
    bold={options.selected}
    color={options.baseColor ?? (options.selected ? "white" : "gray")}
    dimColor={options.dimColor}
  >
    {buildHighlightSegments(text, ranges).map((segment, index) => (
      <Text
        key={`${text}-${index}`}
        color={
          segment.highlight ? options.highlightColor ?? options.tone.promptColor : undefined
        }
        bold={options.selected || segment.highlight}
      >
        {segment.text}
      </Text>
    ))}
  </Text>
);

const groupPaletteWindow = <T extends { group?: string }>(
  items: Array<{ item: T; index: number }>
) => {
  const groups = new Map<string, Array<{ item: T; index: number }>>();
  for (const entry of items) {
    const group = entry.item.group ?? "Commands";
    const bucket = groups.get(group);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(group, [entry]);
    }
  }
  return [...groups.entries()];
};

const formatDuration = (startAt: number | null | undefined, now: number) => {
  if (!startAt) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - startAt) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const renderCommandPaletteRow = (
  suggestion: ChatScreenProps["inputCommandState"]["suggestions"][number],
  selected: boolean,
  tone: ComposerTone
) => {
  const templateMeta = getCommandTemplateMeta(suggestion);
  const baseText = templateMeta.baseCommand;
  const templateText = templateMeta.template ?? "";
  const baseRanges = sliceMatchRanges(
    suggestion.matchRanges,
    0,
    baseText.length
  );
  const templateOffset =
    suggestion.command.length > baseText.length ? baseText.length + 1 : baseText.length;
  const templateRanges = templateText
    ? sliceMatchRanges(
        suggestion.matchRanges,
        templateOffset,
        templateOffset + templateText.length
      )
    : [];
  const argumentSummary = templateMeta.argumentHints
    .map(argument => `${argument.label}${argument.optional ? "?" : ""}`)
    .join(", ");
  const insertsTemplate = templateMeta.insertValue !== suggestion.command;

  return (
    <Box key={`composer-command-${suggestion.command}`} flexDirection="column">
      <Box flexWrap="wrap">
        <Text color={selected ? tone.promptColor : "gray"}>
          {selected ? "→" : "·"}
        </Text>
        <Text> </Text>
        {renderHighlightedText(baseText, baseRanges, {
          selected,
          tone,
        })}
        {templateText ? (
          <>
            <Text> </Text>
            {renderHighlightedText(templateText, templateRanges, {
              selected,
              tone,
              baseColor: selected ? "gray" : "gray",
              dimColor: !selected,
            })}
          </>
        ) : null}
        <Text dimColor>{`  ${suggestion.description}`}</Text>
      </Box>
      {selected && (templateText || argumentSummary || insertsTemplate) ? (
        <Box marginLeft={2} flexWrap="wrap">
          {templateText ? (
            <>
              <Text dimColor>template </Text>
              <Text>{templateMeta.baseCommand}</Text>
              <Text dimColor>{` ${templateText}`}</Text>
            </>
          ) : null}
          {argumentSummary ? (
            <>
              <Text dimColor>{templateText ? `  |  args ` : `args `}</Text>
              <Text>{argumentSummary}</Text>
            </>
          ) : null}
          {insertsTemplate ? (
            <>
              <Text dimColor>
                {templateText || argumentSummary ? `  |  Tab ` : "Tab "}
              </Text>
              <Text>{clipPreviewLine(templateMeta.insertValue, 28)}</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};

const getShellSessionBadge = (
  shellSession: ChatScreenProps["shellSession"]
): {
  label: string;
  backgroundColor: "cyan" | "yellow" | "red" | "magenta";
  textColor: "black";
} => {
  if (shellSession.status === "running") {
    return {
      label: " SHELL RUNNING ",
      backgroundColor: "yellow",
      textColor: "black",
    };
  }
  if (shellSession.status === "exited" || !shellSession.alive) {
    return {
      label: " SHELL EXITED ",
      backgroundColor: "red",
      textColor: "black",
    };
  }
  if (shellSession.lastEvent === "interrupted") {
    return {
      label: " SHELL INTERRUPTED ",
      backgroundColor: "magenta",
      textColor: "black",
    };
  }
  return {
    label: " SHELL IDLE ",
    backgroundColor: "cyan",
    textColor: "black",
  };
};

const renderShellSessionBar = (
  shellSession: ChatScreenProps["shellSession"],
  now: number
) => {
  if (!shellSession.visible) {
    return null;
  }

  const badge = getShellSessionBadge(shellSession);
  const liveDuration = formatDuration(shellSession.openedAt, now);
  const runningDuration = formatDuration(shellSession.runningSince, now);
  const outputAge = formatDuration(shellSession.lastOutputAt, now);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box flexWrap="wrap">
        <Text
          color={badge.textColor}
          backgroundColor={badge.backgroundColor}
        >
          {badge.label}
        </Text>
        <Text> </Text>
        <Text>{shellSession.shell ?? "shell"}</Text>
        <Text dimColor>{`  |  cwd `}</Text>
        <Text>{shortenValue(shellSession.cwd ?? "workspace", 36)}</Text>
        {liveDuration ? (
          <>
            <Text dimColor>{`  |  live `}</Text>
            <Text>{liveDuration}</Text>
          </>
        ) : null}
        {runningDuration ? (
          <>
            <Text dimColor>{`  |  run `}</Text>
            <Text color="yellow">{runningDuration}</Text>
          </>
        ) : null}
        {shellSession.pendingOutput ? (
          <>
            <Text dimColor>{`  |  buffer `}</Text>
            <Text color="yellow">ready</Text>
          </>
        ) : null}
        {shellSession.lastEvent ? (
          <>
            <Text dimColor>{`  |  event `}</Text>
            <Text>{shellSession.lastEvent}</Text>
          </>
        ) : null}
        {shellSession.lastExit ? (
          <>
            <Text dimColor>{`  |  exit `}</Text>
            <Text>{shellSession.lastExit}</Text>
          </>
        ) : null}
      </Box>
      {shellSession.lastOutputSummary ? (
        <Box flexWrap="wrap">
          <Text dimColor>recent </Text>
          <Text>{clipPreviewLine(shellSession.lastOutputSummary, 104)}</Text>
          {outputAge ? (
            <>
              <Text dimColor>{`  |  age `}</Text>
              <Text>{outputAge}</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};

const fitLinesToCharBudget = (
  lines: string[],
  maxChars: number,
  preferTail: boolean
) => {
  if (lines.length === 0) {
    return lines;
  }

  const kept: string[] = [];
  let usedChars = 0;
  const iterate = preferTail ? [...lines].reverse() : lines;

  for (const line of iterate) {
    const additional = kept.length === 0 ? line.length : line.length + 1;
    if (kept.length > 0 && usedChars + additional > maxChars) {
      break;
    }
    if (kept.length === 0 && additional > maxChars) {
      const clippedLine = preferTail
        ? line.slice(-maxChars)
        : line.slice(0, maxChars);
      kept.push(clippedLine);
      usedChars = clippedLine.length;
      break;
    }
    kept.push(line);
    usedChars += additional;
  }

  return preferTail ? kept.reverse() : kept;
};

const countCodeFenceLines = (lines: string[]) =>
  lines.reduce(
    (count, line) => count + (line.trim().startsWith("```") ? 1 : 0),
    0
  );

const getLastCodeFenceLine = (lines: string[]) => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (candidate?.startsWith("```")) {
      return candidate;
    }
  }
  return "```";
};

const clipTextForRender = (
  text: string,
  options: RenderClipOptions = {}
): RenderClipResult => {
  const maxLines = Math.max(1, options.maxLines ?? MAX_RENDER_TEXT_LINES);
  const maxChars = Math.max(1, options.maxChars ?? MAX_RENDER_TEXT_CHARS);
  const preferTail = options.preferTail ?? false;
  const allLines = text.split("\n");
  const initialVisibleLines = preferTail
    ? allLines.slice(-maxLines)
    : allLines.slice(0, maxLines);
  const initialVisibleLineCount = initialVisibleLines.length;
  let visibleLines = fitLinesToCharBudget(
    initialVisibleLines,
    maxChars,
    preferTail
  );
  const visibleStartIndex = preferTail
    ? Math.max(0, allLines.length - visibleLines.length)
    : 0;
  if (preferTail && visibleLines.length > 0) {
    const hiddenPrefix = allLines.slice(0, visibleStartIndex);
    const insideCodeBlock = countCodeFenceLines(hiddenPrefix) % 2 === 1;
    if (insideCodeBlock && !visibleLines[0]?.trim().startsWith("```")) {
      visibleLines = [getLastCodeFenceLine(hiddenPrefix), ...visibleLines];
    }
  }
  const clippedText = visibleLines.join("\n");

  const hiddenLines = preferTail
    ? Math.max(0, allLines.length - initialVisibleLineCount)
    : Math.max(0, allLines.length - visibleLines.length);
  const hiddenChars = Math.max(0, text.length - clippedText.length);
  return {
    text: clippedText,
    clipped: hiddenLines > 0 || hiddenChars > 0,
    hiddenLines,
    hiddenChars,
  };
};

const formatRenderClipNotice = (
  clip: RenderClipResult,
  options: RenderClipOptions = {}
) => {
  if (!clip.clipped) {
    return "";
  }
  const parts = [
    clip.hiddenLines > 0 ? `${clip.hiddenLines} lines` : "",
    clip.hiddenChars > 0 ? `${clip.hiddenChars} chars` : "",
  ].filter(Boolean);
  const prefix = options.preferTail ? "showing latest slice, " : "";
  return `[render clipped] ${prefix}omitted ${parts.join(" / ")} to keep terminal stable`;
};

const getMessageClipOptions = (item: ChatItem): RenderClipOptions =>
  item.role === "assistant" && item.kind === "transcript"
    ? {
        preferTail: true,
      }
    : {};

const getApproximateMessageRenderCost = (item: ChatItem) => {
  const text = item.text ?? "";
  const lineCount = text ? text.split("\n").length : 0;

  return {
    lineCount: Math.min(lineCount, MAX_RENDER_TEXT_LINES),
    charCount: Math.min(text.length, MAX_RENDER_TEXT_CHARS),
  };
};

const getTranscriptWindow = (items: ChatItem[]) => {
  if (items.length === 0) {
    return { items, hiddenCount: 0 };
  }

  let visibleItems = 0;
  let visibleLines = 0;
  let visibleChars = 0;
  let startIndex = items.length - 1;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const cost = getApproximateMessageRenderCost(item);
    const nextItemCount = visibleItems + 1;
    const nextLineCount = visibleLines + cost.lineCount;
    const nextCharCount = visibleChars + cost.charCount;
    const exceedsWindow =
      visibleItems > 0 &&
      (nextItemCount > MAX_RENDERED_TRANSCRIPT_ITEMS ||
        nextLineCount > MAX_TRANSCRIPT_WINDOW_LINES ||
        nextCharCount > MAX_TRANSCRIPT_WINDOW_CHARS);

    if (exceedsWindow) {
      break;
    }

    startIndex = index;
    visibleItems = nextItemCount;
    visibleLines = nextLineCount;
    visibleChars = nextCharCount;
  }

  return {
    items: items.slice(startIndex),
    hiddenCount: startIndex,
  };
};

const formatProviderLabel = (provider: string, max = 22) => {
  if (!provider || provider === "none") {
    return "none";
  }
  try {
    const url = new URL(provider);
    const hostLabel = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    return shortenValue(hostLabel, max);
  } catch {
    return shortenValue(provider, max);
  }
};

type ProviderProfile =
  | "openai"
  | "gemini"
  | "anthropic"
  | "custom"
  | "local"
  | "none";

const formatProviderProfileLabel = (profile?: ProviderProfile | null) => {
  switch (profile) {
    case "openai":
      return "OpenAI-compatible";
    case "gemini":
      return "Gemini-compatible";
    case "anthropic":
      return "Anthropic-compatible";
    case "local":
      return "Local";
    case "none":
      return "none";
    default:
      return "Custom";
  }
};

type ProviderProfileSource = "manual" | "inferred" | "local" | "none";

const formatProviderProfileSourceLabel = (
  source?: ProviderProfileSource | null
) => {
  switch (source) {
    case "manual":
      return "manual";
    case "local":
      return "local";
    case "none":
      return "none";
    default:
      return "inferred";
  }
};

const getProviderEndpointKind = (
  provider: string,
  profile?: ProviderProfile | null
) => {
  if (!provider || provider === "none") {
    return "none";
  }
  if (profile === "local") {
    return "local";
  }
  try {
    const host = new URL(provider).hostname.toLowerCase();
    const isOfficial =
      (profile === "openai" && host.endsWith("openai.com")) ||
      (profile === "gemini" && host === "generativelanguage.googleapis.com") ||
      (profile === "anthropic" && host.endsWith("anthropic.com"));
    return isOfficial ? "official" : "relay/custom";
  } catch {
    return "custom";
  }
};

const formatKeySourceLabel = (keySource?: string | null) => {
  const normalized = keySource?.trim() ?? "";
  if (!normalized || normalized === "unknown") {
    return "unknown";
  }
  if (normalized === "CYRENE_OPENAI_API_KEY") {
    return "openai env";
  }
  if (normalized === "CYRENE_GEMINI_API_KEY") {
    return "gemini env";
  }
  if (normalized === "CYRENE_ANTHROPIC_API_KEY") {
    return "anthropic env";
  }
  if (normalized === "CYRENE_API_KEY") {
    return "shared env";
  }
  if (normalized === "process_env") {
    return "process env";
  }
  if (normalized === "user_env") {
    return "user env";
  }
  return normalized;
};

const splitIntoGraphemes = (value: string) => {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(value), segment => segment.segment);
  }

  return Array.from(value);
};

const segmentLineByGrapheme = (line: string): GraphemeSegment[] => {
  if (!line) {
    return [];
  }

  const graphemes = splitIntoGraphemes(line);
  const segments: GraphemeSegment[] = [];
  let currentOffset = 0;

  for (const grapheme of graphemes) {
    const nextOffset = currentOffset + grapheme.length;
    segments.push({
      text: grapheme,
      startOffset: currentOffset,
      endOffset: nextOffset,
    });
    currentOffset = nextOffset;
  }

  return segments;
};

const getStatusBadge = (status: ChatStatus, spinner: string) => {
  if (status === "preparing") {
    return {
      textColor: "black" as const,
      backgroundColor: "yellow" as const,
      headerLabel: `${spinner} PREPARING`,
      inputLabel: `${spinner} Preparing context`,
      inputColor: "yellow" as const,
    };
  }

  if (status === "requesting") {
    return {
      textColor: "black" as const,
      backgroundColor: "cyan" as const,
      headerLabel: `${spinner} REQUESTING`,
      inputLabel: `${spinner} Requesting model`,
      inputColor: "cyan" as const,
    };
  }

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

const getPreviewWindow = <T,>(lines: T[], offset: number, pageSize = 20) => {
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
  options?: { backgroundColor?: InkTone }
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
            color="cyan"
            bold
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
          {renderSegments(tokenizeCodeLine(line), `code-token-${itemIndex}-${lineIndex}`)}
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
  let listState:
    | {
        ordered: boolean;
        items: Array<{ text: string; marker?: string }>;
      }
    | null = null;
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
      lines: [...paragraphLines],
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

    const unorderedMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
    if (unorderedMatch) {
      const itemText = unorderedMatch[1] ?? "";
      flushParagraph();
      flushDiff();
      if (!listState || listState.ordered) {
        flushList();
        listState = { ordered: false, items: [] };
      }
      listState.items.push({ text: itemText });
      return;
    }

    const orderedMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (orderedMatch) {
      const markerNumber = orderedMatch[1] ?? "";
      const itemText = orderedMatch[2] ?? "";
      flushParagraph();
      flushDiff();
      if (!listState || !listState.ordered) {
        flushList();
        listState = { ordered: true, items: [] };
      }
      listState.items.push({
        text: itemText,
        marker: markerNumber ? `${markerNumber}. ` : undefined,
      });
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

const TERMINAL_ACTIONS = new Set([
  "run_command",
  "run_shell",
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
]);

const getTerminalFieldValue = (lines: string[], key: string) =>
  lines
    .map(line => line.trim())
    .find(line => line.toLowerCase().startsWith(`${key.toLowerCase()}:`))
    ?.replace(new RegExp(`^${key}:\\s*`, "i"), "")
    .trim() ?? "";

const inferApprovalTerminalAction = (lines: string[]) => {
  const explicitAction = getTerminalFieldValue(lines, "action");
  if (TERMINAL_ACTIONS.has(explicitAction)) {
    return explicitAction;
  }

  const status = getTerminalFieldValue(lines, "status").toLowerCase();
  const hasCommand = Boolean(getTerminalFieldValue(lines, "command"));
  const hasShell = Boolean(getTerminalFieldValue(lines, "shell"));
  const hasInput = Boolean(getTerminalFieldValue(lines, "input"));
  const hasProgram = Boolean(getTerminalFieldValue(lines, "program"));
  const hasBusy = Boolean(getTerminalFieldValue(lines, "busy"));
  const hasAlive = Boolean(getTerminalFieldValue(lines, "alive"));
  const hasPendingOutput = Boolean(getTerminalFieldValue(lines, "pending_output"));
  const hasOutput = lines.some(line => line.trim().toLowerCase() === "output:");

  if (hasInput) {
    return "write_shell";
  }
  if (hasCommand) {
    return hasShell ? "run_shell" : "run_command";
  }
  if (hasProgram || status === "opened") {
    return "open_shell";
  }
  if (status === "interrupted") {
    return "interrupt_shell";
  }
  if (status === "closed") {
    return "close_shell";
  }
  if (hasOutput) {
    return "read_shell";
  }
  if (hasBusy || hasAlive || hasPendingOutput) {
    return "shell_status";
  }
  return "";
};

const getTerminalPrompt = (action: string, shell?: string) =>
  shell === "pwsh" ? "PS>" : action === "run_command" ? ">" : "$";

const normalizeTranscriptPromptLine = (
  line: string,
  action: string,
  shell?: string
) => {
  const match = /^(PS>|>|[$])\s*(.*)$/.exec(line.trim());
  if (!match) {
    return null;
  }
  return {
    prompt: getTerminalPrompt(action, shell),
    text: match[2] ?? "",
  };
};

const getTerminalCommandPreview = (
  action: string,
  fields: Map<string, string>,
  outputLines: string[]
) => {
  if (action === "write_shell") {
    const hasPromptInOutput = outputLines.some(line =>
      /^(PS>|>|[$])\s+/.test(line.trim())
    );
    if (hasPromptInOutput) {
      return "";
    }
  }

  const args = fields.get("args");
  const command = fields.get("command");
  const input = fields.get("input");
  const program = fields.get("program");

  if (input) {
    return input;
  }
  if (command) {
    return [command, args && args !== "(none)" ? args : ""].filter(Boolean).join(" ");
  }
  if (action === "open_shell") {
    return "(shell opened)";
  }
  if (action === "interrupt_shell") {
    return "^C";
  }
  if (action === "close_shell") {
    return "(shell closed)";
  }
  if (action === "shell_status") {
    return "(shell status)";
  }
  if (action === "read_shell") {
    return "(read pending output)";
  }
  return program || "";
};

const parseTerminalTranscript = (item: ChatItem): TerminalTranscript | null => {
  const lines = item.text.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const approvalLike =
    firstLine.startsWith("Approved") ||
    firstLine.startsWith("Approve failed") ||
    firstLine.startsWith("Approval error") ||
    firstLine.startsWith("Rejected");
  let action = "";

  if (firstLine.startsWith("Tool result:")) {
    action = firstLine
      .replace("Tool result:", "")
      .trim()
      .split(/\s+/, 1)[0] ?? "";
  } else if (firstLine.startsWith("Tool error:")) {
    action = firstLine
      .replace("Tool error:", "")
      .trim()
      .split(/\s+/, 1)[0] ?? "";
  } else if (approvalLike) {
    action = inferApprovalTerminalAction(lines.slice(1));
  }

  const fields = new Map<string, string>();
  const outputLines: string[] = [];
  const looseLines: string[] = [];
  let readingOutput = false;

  for (const line of lines.slice(1)) {
    if (readingOutput) {
      outputLines.push(line);
      continue;
    }
    const match = /^([a-z_ ]+):\s*(.*)$/i.exec(line.trim());
    if (!match) {
      if (line.trim()) {
        looseLines.push(line);
      }
      continue;
    }
    const key = (match[1] ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    const value = (match[2] ?? "").trim();
    fields.set(key, value);
    if (key === "output") {
      readingOutput = true;
      if (value) {
        outputLines.push(value);
      }
    }
  }

  if (!TERMINAL_ACTIONS.has(action)) {
    return null;
  }

  const resolvedOutputLines =
    outputLines.length > 0
      ? outputLines
      : looseLines.length > 0
        ? looseLines
        : ["(no new output)"];
  const metaParts = [
    action,
    fields.get("status") ? `status ${fields.get("status")}` : "",
    fields.get("shell") ? `shell ${fields.get("shell")}` : "",
    fields.get("cwd") ? `cwd ${fields.get("cwd")}` : "",
    fields.get("exit") || fields.get("last_exit")
      ? `exit ${fields.get("exit") ?? fields.get("last_exit")}`
      : "",
    fields.get("busy") ? `busy ${fields.get("busy")}` : "",
    fields.get("alive") ? `alive ${fields.get("alive")}` : "",
    fields.get("pending_output") ? `pending ${fields.get("pending_output")}` : "",
  ].filter(Boolean);

  return {
    action,
    shell: fields.get("shell"),
    commandLine: getTerminalCommandPreview(action, fields, resolvedOutputLines),
    metaParts,
    outputLines: resolvedOutputLines,
  };
};

const getTerminalMeaningfulOutputLines = (outputLines: string[]) =>
  outputLines.filter(line => line.trim().toLowerCase() !== "(no new output)");

const getTerminalOutputSummary = (outputLines: string[]) => {
  const meaningfulLines = getTerminalMeaningfulOutputLines(outputLines);
  if (meaningfulLines.length === 0) {
    return "no output";
  }
  return meaningfulLines.length === 1 ? "1 line" : `${meaningfulLines.length} lines`;
};

const getTerminalTranscriptSummary = (transcript: TerminalTranscript) =>
  [
    transcript.commandLine ? shortenValue(transcript.commandLine, 64) : "",
    ...transcript.metaParts,
    `output ${getTerminalOutputSummary(transcript.outputLines)}`,
  ]
    .filter(Boolean)
    .join("  |  ");

const renderTerminalTranscript = (
  transcript: TerminalTranscript,
  itemIndex: number,
  clipNotice?: string
) => {
  const activityLabel = transcript.action.includes("shell") ? "shell" : "tool";
  const activityColor = activityLabel === "shell" ? "yellow" : "cyan";
  const summary = getTerminalTranscriptSummary(transcript);
  const meaningfulOutputLines = getTerminalMeaningfulOutputLines(transcript.outputLines);
  const visibleOutputLines = meaningfulOutputLines.slice(
    0,
    Math.min(MAX_RENDERED_TERMINAL_OUTPUT_LINES, MAX_COMPACT_TERMINAL_OUTPUT_LINES)
  );
  const hiddenOutputLines = Math.max(
    0,
    meaningfulOutputLines.length - visibleOutputLines.length
  );

  return (
    <Box key={`terminal-${itemIndex}`} flexDirection="column" marginBottom={1}>
      <Box flexWrap="wrap">
        <Text color={activityColor}>{`[${activityLabel}]`}</Text>
        {summary ? (
          <>
            <Text> </Text>
            <Text color="white">{summary}</Text>
          </>
        ) : null}
      </Box>
      {visibleOutputLines.length > 0 ? (
        <Box flexDirection="column">
          {visibleOutputLines.map((line, lineIndex) =>
            (() => {
              const promptLine = normalizeTranscriptPromptLine(
                line,
                transcript.action,
                transcript.shell
              );
              if (promptLine) {
                return (
                  <Box key={`terminal-output-${itemIndex}-${lineIndex}`}>
                    <Text dimColor>{"  "}</Text>
                    <Text color="green">{promptLine.prompt}</Text>
                    <Text> </Text>
                    <Text dimColor>{promptLine.text || " "}</Text>
                  </Box>
                );
              }

              const normalized = line.trim().toLowerCase();
              const lineColor =
                normalized.startsWith("[stderr]") ||
                normalized.startsWith("stderr") ||
                normalized.startsWith("error") ||
                normalized.startsWith("exception")
                  ? "red"
                  : line.trim() === "(no new output)"
                    ? "gray"
                    : "white";

              return (
                <Text
                  key={`terminal-output-${itemIndex}-${lineIndex}`}
                  color={lineColor === "white" ? undefined : lineColor}
                  dimColor={lineColor !== "red"}
                >
                  {`  ${line || " "}`}
                </Text>
              );
            })()
          )}
          {hiddenOutputLines > 0 ? (
            <Text dimColor>{`[+${hiddenOutputLines} more lines hidden]`}</Text>
          ) : null}
        </Box>
      ) : null}
      {clipNotice ? <Text dimColor>{clipNotice}</Text> : null}
    </Box>
  );
};

const shouldRenderCompactEventRow = (
  item: ChatItem,
  terminalTranscript: TerminalTranscript | null
) => {
  if (terminalTranscript) {
    return false;
  }

  if (item.role === "assistant" || item.role === "user") {
    return false;
  }

  if (item.kind === "tool_status" || item.kind === "review_status") {
    return true;
  }

  if ((item.kind === "system_hint" || item.kind === "error") && !item.text.includes("\n")) {
    return true;
  }

  return false;
};

const summarizeCompactEventText = (text: string) => {
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  const [firstLine = "", ...restLines] = lines;
  const normalizedFirstLine = firstLine.replace(/^(tool|review|system):\s*/i, "");

  return [normalizedFirstLine, ...restLines].join(" | ");
};

const renderCompactEventRow = (
  item: ChatItem,
  itemIndex: number,
  text: string,
  clipNotice: string,
  color: ChatItem["color"]
) => {
  const messageLabel = getMessageLabel(item);
  const eventLabel = item.kind === "system_hint" ? "note" : messageLabel.label;
  const summaryText = summarizeCompactEventText(text);

  return (
    <Box key={`item-${itemIndex}`} flexDirection="column" marginBottom={1}>
      <Box flexWrap="wrap">
        <Text color={messageLabel.color}>{`[${eventLabel}]`}</Text>
        <Text> </Text>
        {renderInlineMarkdownLine(
          summaryText,
          `compact-event-${itemIndex}`,
          color
        )}
      </Box>
      {clipNotice ? <Text dimColor>{clipNotice}</Text> : null}
    </Box>
  );
};

const renderMessageItem = (
  item: ChatItem,
  itemIndex: number,
  clipOptions: RenderClipOptions = {}
) => {
  if (!item.text) {
    return null;
  }

  const clip = clipTextForRender(item.text, clipOptions);
  const clipNotice = clipOptions.suppressNotice
    ? ""
    : formatRenderClipNotice(clip, clipOptions);
  const color = resolveItemColor(item);
  const terminalTranscript = parseTerminalTranscript({
    ...item,
    text: clip.text,
  });

  if (shouldRenderCompactEventRow(item, terminalTranscript)) {
    return renderCompactEventRow(item, itemIndex, clip.text, clipNotice, color);
  }

  const blocks = parseMarkdownBlocks(clip.text);
  const nodes: React.ReactNode[] = [];
  if (terminalTranscript) {
    nodes.push(renderTerminalTranscript(terminalTranscript, itemIndex, clipNotice));
  } else {
  blocks.forEach((block, blockIndex) => {
    if (block.kind === "paragraph") {
      block.lines.forEach((line, lineIndex) => {
        nodes.push(
          renderInlineMarkdownLine(
            line,
            `paragraph-${itemIndex}-${blockIndex}-${lineIndex}`,
            color,
            "  "
          )
        );
      });
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
        const marker = block.ordered ? (entry.marker ?? `${entryIndex + 1}. `) : "• ";
        nodes.push(
          renderInlineMarkdownLine(
            entry.text,
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
  if (clipNotice) {
    nodes.push(
      <Text key={`clip-${itemIndex}`} dimColor>
        {`  ${clipNotice}`}
      </Text>
    );
  }
  }

  if (terminalTranscript) {
    return (
      <Box key={`item-${itemIndex}`} flexDirection="column">
        {nodes}
      </Box>
    );
  }

  const messageLabel = getMessageLabel(item);
  return (
    <Box key={`item-${itemIndex}`} flexDirection="column" marginBottom={1}>
      <Text bold color={messageLabel.color}>
        {messageLabel.label}
      </Text>
      {nodes}
    </Box>
  );
};

const renderStatusLine = (
  status: ChatStatus,
  activeSessionId: string | null,
  currentModel: string,
  currentProvider: string,
  appRoot: string,
  usage: TokenUsage | null,
  pendingCount: number,
  activePanel: string,
  spinner: string
) => {
  const statusBadge = getStatusBadge(status, spinner);
  const queueColor = pendingCount > 0 ? "yellow" : "green";
  const tokenSummary = usage
    ? `tokens ${String(usage.totalTokens)}  |  prompt ${String(usage.promptTokens)}  |  completion ${String(
        usage.completionTokens
      )}`
    : "tokens -";

  return (
    <Box marginTop={SECTION_GAP} flexDirection="column">
      <Box flexWrap="wrap">
        <Text
          color={statusBadge.textColor}
          backgroundColor={statusBadge.backgroundColor}
        >
          {` ${statusBadge.headerLabel} `}
        </Text>
        <Text> </Text>
        <Text dimColor>model </Text>
        <Text>{shortenValue(currentModel || "none", 22)}</Text>
        <Text dimColor>{`  |  provider `}</Text>
        <Text>{formatProviderLabel(currentProvider || "none", 18)}</Text>
        <Text dimColor>{`  |  queue `}</Text>
        <Text color={queueColor}>{String(pendingCount)}</Text>
        {activePanel !== "idle" ? (
          <>
            <Text dimColor>{`  |  panel `}</Text>
            <Text>{activePanel}</Text>
          </>
        ) : null}
      </Box>
      <Text dimColor>
        {`session ${shortenValue(activeSessionId ?? "none", 18)}  |  cwd ${shortenValue(appRoot || "none", 42)}  |  ${tokenSummary}`}
      </Text>
    </Box>
  );
};

const getComposerTone = (status: ChatStatus): ComposerTone => {
  if (status === "preparing") {
    return {
      borderColor: "yellow",
      panelBorderColor: "yellow",
      chipBackground: "yellow",
      chipText: "black",
      chipLabel: "PREPARING",
      metaLabel: "building prompt context",
      promptColor: "yellow",
      helperColor: "yellow",
    };
  }

  if (status === "requesting") {
    return {
      borderColor: "cyan",
      panelBorderColor: "cyan",
      chipBackground: "cyan",
      chipText: "black",
      chipLabel: "REQUESTING",
      metaLabel: "opening model stream",
      promptColor: "cyan",
      helperColor: "cyan",
    };
  }

  if (status === "streaming") {
    return {
      borderColor: "yellow",
      panelBorderColor: "yellow",
      chipBackground: "yellow",
      chipText: "black",
      chipLabel: "WORKING",
      metaLabel: "model streaming",
      promptColor: "yellow",
      helperColor: "yellow",
    };
  }

  if (status === "awaiting_review") {
    return {
      borderColor: "magenta",
      panelBorderColor: "magenta",
      chipBackground: "magenta",
      chipText: "black",
      chipLabel: "REVIEW",
      metaLabel: "review lane",
      promptColor: "magenta",
      helperColor: "magenta",
    };
  }

  if (status === "error") {
    return {
      borderColor: "red",
      panelBorderColor: "red",
      chipBackground: "red",
      chipText: "black",
      chipLabel: "ERROR",
      metaLabel: "last step failed",
      promptColor: "red",
      helperColor: "red",
    };
  }

  return {
    borderColor: "gray",
    panelBorderColor: "cyan",
    chipBackground: "cyan",
    chipText: "black",
    chipLabel: "READY",
    metaLabel: "interactive lane",
    promptColor: "cyan",
    helperColor: "gray",
  };
};

const getComposerHelperText = (
  activePanel: string,
  inputCommandState: ChatScreenProps["inputCommandState"],
  shellSession: ChatScreenProps["shellSession"],
  composerKeymap: ComposerKeymap
) => {
  if (activePanel === "approval") {
    return "review hotkeys  |  a approve/retry  |  r reject  |  Tab preview  |  Esc close";
  }

  if (activePanel !== "idle") {
    return "panel active  |  close current panel to type";
  }

  if (inputCommandState.mode === "command") {
    const selectedSuggestion =
      inputCommandState.suggestions[inputCommandState.selectedIndex] ?? null;
    if (!selectedSuggestion) {
      return "command palette  |  no matching command  |  /help all commands";
    }

    const templateMeta = getCommandTemplateMeta(selectedSuggestion);
    const argumentSummary = templateMeta.argumentHints
      .map(argument => `${argument.label}${argument.optional ? "?" : ""}`)
      .join(", ");

    return argumentSummary
      ? `command palette  |  Tab insert template  |  args ${argumentSummary}`
      : templateMeta.insertValue !== selectedSuggestion.command
        ? `command palette  |  Tab accept  |  inserts ${templateMeta.insertValue.trim()}`
        : "command palette  |  Tab accept  |  ↑/↓ select  |  /help all commands";
  }

  if (inputCommandState.mode === "file") {
    if (!inputCommandState.fileMentions.activeQuery) {
      return "file mentions  |  type after @ to search the workspace";
    }
    if (inputCommandState.fileMentions.loading) {
      return `file mentions  |  searching @${inputCommandState.fileMentions.activeQuery}...`;
    }
    return inputCommandState.fileMentions.suggestions.length > 0
      ? "file mentions  |  Tab insert  |  ↑/↓ select"
      : `file mentions  |  no matches for @${inputCommandState.fileMentions.activeQuery}`;
  }

  if (inputCommandState.mode === "shell") {
    return "shell shortcut  |  Ctrl+D send  |  open/read/status/interrupt/close";
  }

  if (shellSession.visible) {
    return shellSession.pendingOutput
      ? "shell session live  |  !shell read  |  !shell interrupt  |  !shell close"
      : "shell session live  |  !shell status  |  !shell interrupt  |  !shell close";
  }

  if (inputCommandState.historyPosition !== null) {
    return `history ${inputCommandState.historyPosition}/${inputCommandState.historySize}  |  empty composer: Up/Down recall`;
  }

  return getComposerHint(composerKeymap);
};

const getComposerWindow = (input: string, inputCursorOffset: number) => {
  const wrapWidth = Math.max(
    MIN_COMPOSER_WRAP_WIDTH,
    Math.min(
      MAX_COMPOSER_WRAP_WIDTH,
      (process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS) - COMPOSER_CHROME_WIDTH
    )
  );
  const lines = getInputLines(input);
  const clampedCursorOffset = clampCursorOffset(input, inputCursorOffset);
  const cursorPosition = getCursorPosition(input, clampedCursorOffset);
  const visualRows: ComposerVisualRow[] = [];
  let cursorVisualRow = 0;

  const splitLine = (line: string): WrappedComposerSegment[] => {
    if (!line) {
      return [{ text: "", startOffset: 0, endOffset: 0 }];
    }

    const graphemes = splitIntoGraphemes(line);
    const segments: WrappedComposerSegment[] = [];
    let currentText = "";
    let currentWidth = 0;
    let currentOffset = 0;
    let segmentStartOffset = 0;

    for (const grapheme of graphemes) {
      const graphemeWidth = Math.max(1, stringWidth(grapheme));
      const nextOffset = currentOffset + grapheme.length;

      if (currentText && currentWidth + graphemeWidth > wrapWidth) {
        segments.push({
          text: currentText,
          startOffset: segmentStartOffset,
          endOffset: currentOffset,
        });
        currentText = grapheme;
        currentWidth = graphemeWidth;
        segmentStartOffset = currentOffset;
      } else {
        currentText += grapheme;
        currentWidth += graphemeWidth;
      }

      currentOffset = nextOffset;
    }

    segments.push({
      text: currentText,
      startOffset: segmentStartOffset,
      endOffset: currentOffset,
    });

    if (segments.length === 0) {
      segments.push({
        text: "",
        startOffset: 0,
        endOffset: 0,
      });
    }

    return segments;
  };

  lines.forEach((line, logicalLineIndex) => {
    const wrappedSegments = splitLine(line);
    const cursorSegmentIndex =
      logicalLineIndex === cursorPosition.line
        ? wrappedSegments.findIndex((segment, segmentIndex) => {
            const isLastSegment = segmentIndex === wrappedSegments.length - 1;
            return (
              cursorPosition.column >= segment.startOffset &&
              (cursorPosition.column < segment.endOffset ||
                (isLastSegment && cursorPosition.column === segment.endOffset))
            );
          })
        : -1;

    wrappedSegments.forEach((segment, segmentIndex) => {
      const isCursorRow =
        logicalLineIndex === cursorPosition.line &&
        segmentIndex === Math.max(0, cursorSegmentIndex);

      if (isCursorRow) {
        cursorVisualRow = visualRows.length;
      }

      visualRows.push({
        prefix:
          logicalLineIndex === 0 && segmentIndex === 0
            ? ">"
            : "│",
        text: segment.text,
        isCursorRow,
        cursorColumn: isCursorRow
          ? Math.max(0, cursorPosition.column - segment.startOffset)
          : 0,
      });
    });
  });

  const visibleCount = Math.min(MAX_COMPOSER_VISIBLE_LINES, visualRows.length);
  const maxStart = Math.max(0, visualRows.length - visibleCount);
  const startLine = Math.min(
    Math.max(0, cursorVisualRow - visibleCount + 1),
    maxStart
  );
  const endLine = startLine + visibleCount;

  return {
    rows: visualRows.slice(startLine, endLine),
  };
};

const renderComposerCursorLine = (
  line: string,
  cursorColumn: number,
  color: ComposerTone["promptColor"]
) => {
  const safeColumn = Math.max(0, Math.min(cursorColumn, line.length));
  const segments = segmentLineByGrapheme(line);
  const cursorSegment = segments.find(
    segment =>
      safeColumn >= segment.startOffset &&
      safeColumn < segment.endOffset
  );
  const before = cursorSegment
    ? segments
        .filter(segment => segment.endOffset <= cursorSegment.startOffset)
        .map(segment => segment.text)
        .join("")
    : line;
  const cursorChar = cursorSegment?.text ?? " ";
  const after = cursorSegment
    ? segments
        .filter(segment => segment.startOffset >= cursorSegment.endOffset)
        .map(segment => segment.text)
        .join("")
    : "";

  return (
    <Box>
      {before ? <Text>{before}</Text> : null}
      <Text color="white" backgroundColor={color}>
        {cursorChar === " " ? COMPOSER_CURSOR_GLYPH : cursorChar}
      </Text>
      {after ? <Text>{after}</Text> : null}
    </Box>
  );
};

const getPaletteWindow = <T,>(
  items: T[],
  selectedIndex: number,
  maxItems = 4
) => {
  if (items.length <= maxItems) {
    return items.map((item, index) => ({ item, index }));
  }

  const half = Math.floor(maxItems / 2);
  const start = Math.min(
    Math.max(0, selectedIndex - half),
    Math.max(0, items.length - maxItems)
  );

  return items
    .slice(start, start + maxItems)
    .map((item, offset) => ({ item, index: start + offset }));
};

const renderComposerPalette = (
  inputCommandState: ChatScreenProps["inputCommandState"],
  tone: ComposerTone,
  activePanel: string
) => {
  if (activePanel !== "idle") {
    return null;
  }

  if (inputCommandState.mode === "command") {
    const suggestionWindow = getPaletteWindow(
      inputCommandState.suggestions,
      inputCommandState.selectedIndex
    );
    const groupedSuggestions = groupPaletteWindow(suggestionWindow);

    return (
      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Command palette
        </Text>
        {suggestionWindow.length > 0 ? (
          groupedSuggestions.map(([group, entries]) => (
            <Box
              key={`composer-command-group-${group}`}
              flexDirection="column"
            >
              <Text dimColor>{group}</Text>
              {entries.map(({ item, index }) => {
                const selected = index === inputCommandState.selectedIndex;
                return renderCommandPaletteRow(item, selected, tone);
              })}
            </Box>
          ))
        ) : (
          <Text dimColor>
            {`No command match for ${inputCommandState.currentCommand ?? "/"}.`}
          </Text>
        )}
      </Box>
    );
  }

  if (inputCommandState.mode === "file") {
    const referenceSummary = inputCommandState.fileMentions.references
      .slice(0, 3)
      .join(", ");
    const suggestionWindow = getPaletteWindow(
      inputCommandState.fileMentions.suggestions,
      inputCommandState.selectedIndex
    );
    const selectedFile =
      inputCommandState.fileMentions.suggestions[inputCommandState.selectedIndex] ??
      null;
    const preview = inputCommandState.fileMentions.preview;
    const previewLines = preview?.text
      ? preview.text.split("\n").slice(0, 5)
      : [];

    return (
      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          File mentions
        </Text>
        {referenceSummary ? (
          <Text dimColor>
            {`attached  ${referenceSummary}${
              inputCommandState.fileMentions.references.length > 3
                ? `  +${inputCommandState.fileMentions.references.length - 3} more`
                : ""
            }`}
          </Text>
        ) : null}
        <Text dimColor>
          {inputCommandState.fileMentions.activeQuery
            ? `search  @${inputCommandState.fileMentions.activeQuery}`
            : "Type after @ to search workspace files."}
        </Text>
        {inputCommandState.fileMentions.loading ? (
          <Text dimColor>searching workspace...</Text>
        ) : suggestionWindow.length > 0 ? (
          suggestionWindow.map(({ item, index }) => {
            const selected = index === inputCommandState.selectedIndex;
            return (
              <Box key={`composer-file-${item.path}`} flexWrap="wrap">
                <Text color={selected ? tone.promptColor : "gray"}>
                  {selected ? "→" : "·"}
                </Text>
                <Text> </Text>
                <Text bold={selected} color={selected ? "white" : "gray"}>
                  {`@${item.path}`}
                </Text>
                <Text dimColor>{`  ${item.description}`}</Text>
              </Box>
            );
          })
        ) : inputCommandState.fileMentions.activeQuery ? (
          <Text dimColor>
            {`No workspace files match @${inputCommandState.fileMentions.activeQuery}.`}
          </Text>
        ) : null}
        {selectedFile ? (
          <Box marginTop={1} marginLeft={2} flexDirection="column">
            <Text dimColor>
              {`preview  @${selectedFile.path}${
                preview?.meta ? `  |  ${preview.meta}` : ""
              }`}
            </Text>
            {preview?.loading ? (
              <Text dimColor>loading preview...</Text>
            ) : previewLines.length > 0 ? (
              previewLines.map((line, index) => (
                <Text key={`composer-file-preview-${selectedFile.path}-${index}`}>
                  {clipPreviewLine(line)}
                </Text>
              ))
            ) : (
              <Text dimColor>preview unavailable for the selected file.</Text>
            )}
          </Box>
        ) : null}
      </Box>
    );
  }

  if (inputCommandState.mode === "shell") {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Shell shortcut
        </Text>
        <Text color="white">
          {inputCommandState.shellShortcut.actionLabel || "!shell"}
        </Text>
        <Text dimColor>
          {inputCommandState.shellShortcut.command
            ? inputCommandState.shellShortcut.command
            : "!shell <command>"}
        </Text>
        <Text dimColor>{inputCommandState.shellShortcut.description}</Text>
        <Text dimColor>
          !shell open [cwd]  |  !shell read  |  !shell status  |  !shell
          interrupt  |  !shell close
        </Text>
      </Box>
    );
  }

  return null;
};

const renderStreamingAssistantItem = (
  text: string,
  itemIndex: number,
  clipOptions: RenderClipOptions = {}
) => {
  if (!text) {
    return null;
  }

  const clip = clipTextForRender(text, clipOptions);
  const body = clip.text ? `  ${clip.text.replace(/\n/g, "\n  ")}` : "  ";

  return (
    <Box key={`streaming-item-${itemIndex}`} flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        cyrene
      </Text>
      <Text color={clip.text.trim() ? "white" : "gray"}>{body}</Text>
    </Box>
  );
};

const renderStartupSuggestion = (title: string, detail: string) => (
  <Box marginTop={1} flexWrap="wrap">
    <Text color="cyan">{"> "}</Text>
    <Text bold color="white">
      {title}
    </Text>
    <Text dimColor>{`  ${detail}`}</Text>
  </Box>
);

const renderStartupView = (
  appRoot: string,
  currentModel: string,
  currentProvider: string,
  activeSessionId: string | null,
  authStatus: AuthStatus
) => (
  <Box marginBottom={SECTION_GAP + 1} flexDirection="column">
    <Text bold color="white">
      {APP_NAME}
    </Text>
    <Text dimColor>Terminal-first coding assistant for the current workspace.</Text>
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>{`cwd ${shortenValue(appRoot || "none", 58)}`}</Text>
      <Text dimColor>
        {`mode ${authStatus.mode}  |  model ${shortenValue(currentModel || "none", 18)}  |  provider ${formatProviderLabel(currentProvider || "none", 18)}  |  session ${shortenValue(
          activeSessionId ?? "none",
          18
        )}`}
      </Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color="cyan">
        Start here
      </Text>
      {renderStartupSuggestion("Explain this repository", "Summarize the structure, stack, or a file.")}
      {renderStartupSuggestion("Fix something", "Point at an error, failing test, or suspicious behavior.")}
      {renderStartupSuggestion("Connect HTTP", "Use /login to save credentials, or skip and keep using local-core.")}
      {renderStartupSuggestion("Keep going", "Use /resume for a past session, /auth for status, or /model to switch models.")}
    </Box>
    <Text dimColor>
      Use `/` for commands. `/login`, `/logout`, and `/auth` manage provider access without blocking local fallback.
    </Text>
  </Box>
);

const maskSecretForRender = (value: string) =>
  value ? "•".repeat(value.length) : "";

const renderAuthWizardPanel = (
  authPanel: ChatScreenProps["authPanel"],
  authStatus: AuthStatus
) => {
  if (!authPanel.active) {
    return null;
  }

  const currentFieldRawValue =
    authPanel.step === "provider"
      ? authPanel.providerBaseUrl
      : authPanel.step === "api_key"
        ? authPanel.apiKey
        : authPanel.model;
  const currentFieldValue =
    authPanel.step === "api_key"
      ? maskSecretForRender(currentFieldRawValue)
      : currentFieldRawValue;
  const inputWindow = getComposerWindow(currentFieldValue, authPanel.cursorOffset);
  const title =
    authPanel.mode === "auto_onboarding" ? "Login Onboarding" : "Login";
  const stepLabel =
    authPanel.step === "provider"
      ? "1/4 provider base URL"
      : authPanel.step === "api_key"
        ? "2/4 API key"
        : authPanel.step === "model"
          ? "3/4 initial model"
          : "4/4 confirm";
  const fieldPrompt =
    authPanel.step === "provider"
      ? "Enter provider URL or preset name (openai / gemini / anthropic)."
      : authPanel.step === "api_key"
        ? "Paste the API key. It is masked and never written to the transcript."
        : authPanel.step === "model"
          ? "Optional initial model. Leave blank to use the current model or gpt-4o-mini."
          : "Review the target and press Enter to connect.";
  const providerPresetHint = "Quick preset: 1 OpenAI | 2 Gemini | 3 Anthropic";
  const effectiveModel = authPanel.model.trim() || authStatus.model || "gpt-4o-mini";

  return (
    <Box
      marginBottom={SECTION_GAP}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={1}
    >
      <Box justifyContent="space-between" flexWrap="wrap">
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{stepLabel}</Text>
      </Box>
      {authPanel.info ? <Text dimColor>{authPanel.info}</Text> : null}
      <Text color="white">{fieldPrompt}</Text>
      {authPanel.step === "provider" ? <Text dimColor>{providerPresetHint}</Text> : null}

      {authPanel.step !== "confirm" ? (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor={authPanel.error ? "red" : "cyan"}
          paddingX={1}
          flexDirection="column"
        >
          {inputWindow.rows.map((row, index) => (
            <Box key={`auth-wizard-row-${row.prefix}-${index}`}>
              <Text bold color="cyan">
                {row.prefix}
              </Text>
              <Text> </Text>
              <Box flexGrow={1}>
                {row.isCursorRow ? (
                  renderComposerCursorLine(row.text, row.cursorColumn, "cyan")
                ) : (
                  <Text>{row.text || " "}</Text>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text>{`1. provider  ${authPanel.providerBaseUrl || "(empty)"}`}</Text>
          <Text>{`2. api key   ${maskSecretForRender(authPanel.apiKey) || "(empty)"}`}</Text>
          <Text>{`3. model     ${effectiveModel}`}</Text>
          <Text dimColor>
            {`target  ${authPanel.persistenceTarget?.label ?? "unavailable"}  |  ${authPanel.persistenceTarget?.path ?? "(none)"}`}
          </Text>
          <Text dimColor>
            Enter: connect  |  1/2/3: edit field  |  Esc: {authPanel.mode === "auto_onboarding" ? "skip to local-core" : "close"}
          </Text>
        </Box>
      )}

      {authPanel.error ? (
        <Text color="red">{`error: ${authPanel.error}`}</Text>
      ) : null}

      {authPanel.step !== "confirm" ? (
        <Text dimColor>
          Enter: next
          {authPanel.step === "provider"
            ? "  |  1/2/3: preset + next"
            : ""}
          {`  |  Esc: ${authPanel.mode === "auto_onboarding" ? "skip to local-core" : "close"}`}
        </Text>
      ) : null}
    </Box>
  );
};

const renderMainComposer = (
  status: ChatStatus,
  input: string,
  inputCursorOffset: number,
  _onInputChange: (next: string) => void,
  _onSubmit: () => void,
  activePanel: string,
  showStartupView: boolean,
  inputCommandState: ChatScreenProps["inputCommandState"],
  shellSession: ChatScreenProps["shellSession"],
  shellClock: number,
  composerKeymap: ComposerKeymap
) => {
  const isPanelActive = activePanel !== "idle";
  const tone = getComposerTone(activePanel === "approval" ? "awaiting_review" : status);
  const metaLabel =
    activePanel === "approval"
      ? tone.metaLabel
      : activePanel !== "idle"
        ? "panel active"
        : status !== "idle"
          ? tone.metaLabel
          : shellSession.visible && inputCommandState.mode === "idle"
            ? "shell session"
          : inputCommandState.mode === "command"
            ? "command palette"
            : inputCommandState.mode === "file"
              ? "file mentions"
              : inputCommandState.mode === "shell"
                ? "shell shortcut"
                : "prompt ready";
  const helperText = shortenValue(
    getComposerHelperText(activePanel, inputCommandState, shellSession, composerKeymap),
    96
  );
  const placeholder =
    activePanel === "approval"
      ? "Review pending — approve or reject before typing..."
      : isPanelActive
        ? "Close the active panel to keep typing..."
        : inputCommandState.mode === "command"
          ? "Choose a slash command..."
          : inputCommandState.mode === "file"
            ? "Mention workspace files with @..."
            : inputCommandState.mode === "shell"
              ? "Type a shell command or shell session action..."
              : showStartupView
                ? "Ask about this workspace, mention files, or use / commands..."
                : "Ask Cyrene, mention files with @, or use / commands...";
  const composerWindow = getComposerWindow(input, inputCursorOffset);
  const statusSummary = `${tone.chipLabel.toLowerCase()}  |  ${metaLabel}`;
  const paletteNode = renderComposerPalette(
    inputCommandState,
    tone,
    activePanel
  );
  const shellSessionNode = renderShellSessionBar(shellSession, shellClock);

  return (
    <Box
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={tone.borderColor}
      paddingX={1}
    >
      <Box flexWrap="wrap">
        <Text bold color={tone.promptColor}>
          {isPanelActive ? "x" : ">"}
        </Text>
        <Text> </Text>
        <Text color={tone.helperColor} dimColor={tone.helperColor === "gray"}>
          {statusSummary}
        </Text>
      </Box>
      {shellSessionNode}
      <Box marginTop={1} flexDirection="column">
        {input ? (
          composerWindow.rows.map((row, visibleIndex) => {
            return (
              <Box key={`composer-line-${visibleIndex}`}>
                <Text bold color={tone.promptColor}>
                  {row.prefix}
                </Text>
                <Text> </Text>
                <Box flexGrow={1}>
                  {row.isCursorRow ? (
                    renderComposerCursorLine(
                      row.text,
                      row.cursorColumn,
                      tone.promptColor
                    )
                  ) : (
                    <Text>{row.text || " "}</Text>
                  )}
                </Box>
              </Box>
            );
          })
        ) : (
          <Box>
            <Text bold color={tone.promptColor}>
              {">"}
            </Text>
            <Text> </Text>
            <Box flexGrow={1}>
              <Text color="white" backgroundColor={tone.promptColor}>
                {COMPOSER_CURSOR_GLYPH}
              </Text>
              <Text dimColor>{` ${placeholder}`}</Text>
            </Box>
          </Box>
        )}
      </Box>
      {paletteNode}
      <Text dimColor>{helperText}</Text>
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
  if (
    action === "run_command" ||
    action === "run_shell" ||
    action === "open_shell" ||
    action === "write_shell"
  ) {
    return { border: "red", badgeBg: "red", badgeFg: "black" } as const;
  }
  if (action === "delete_file") {
    return { border: "red", badgeBg: "red", badgeFg: "black" } as const;
  }
  if (action === "edit_file" || action === "apply_patch") {
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
    case "apply_patch":
      return "Diff preview · patch";
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
    case "open_shell":
      return "Shell session preview";
    case "write_shell":
      return "Shell session preview";
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
    case "apply_patch":
      return "scoped patch";
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
    case "open_shell":
      return "open shell session";
    case "write_shell":
      return "shell input";
    case "create_dir":
      return "new directory";
    default:
      return action;
  }
};

const isCommandSummaryRequest = (request: PendingReviewItem["request"]) =>
  request.action === "run_command" ||
  request.action === "run_shell" ||
  request.action === "open_shell" ||
  request.action === "write_shell";

const isShellSummaryRequest = (request: PendingReviewItem["request"]) =>
  request.action === "run_shell" ||
  request.action === "open_shell" ||
  request.action === "write_shell";

const getApprovalRequestCwd = (request: PendingReviewItem["request"]) =>
  "cwd" in request && typeof request.cwd === "string" ? request.cwd : ".";

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

const inferSectionDiffMode = (label?: string): "add" | "remove" | null => {
  const normalized = (label ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes("old -") ||
    normalized.includes("to be removed") ||
    normalized.includes("to be overwritten")
  ) {
    return "remove";
  }
  if (normalized.includes("new +") || normalized.includes("to be written")) {
    return "add";
  }
  return null;
};

const isApprovalPreviewHeaderLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("action=")) {
    return false;
  }
  return trimmed
    .split("|")
    .map(part => part.trim())
    .every(part => /^[a-z_]+=.*/i.test(part));
};

const parseApprovalPreviewLines = (previewText: string): ApprovalPreviewLine[] => {
  let sectionMode: "add" | "remove" | null = null;
  const parsedLines: ApprovalPreviewLine[] = [];
  const rawLines = previewText.split("\n");

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";
    if (isApprovalPreviewHeaderLine(rawLine)) {
      const nextLine = rawLines[index + 1] ?? "";
      if (!nextLine.trim()) {
        index += 1;
      }
      continue;
    }

    const parsed = classifyApprovalPreviewLine(rawLine);
    if (parsed.kind === "section") {
      sectionMode = inferSectionDiffMode(parsed.label);
      parsedLines.push(parsed);
      continue;
    }
    if (parsed.kind === "context" && sectionMode) {
      const numbered = /^\s*(\d+)\s*\|\s?(.*)$/.exec(rawLine);
      if (numbered) {
        const [, lineNumber = "", content = ""] = numbered;
        parsedLines.push({
          kind: sectionMode,
          raw: rawLine,
          lineNumber,
          content,
        });
        continue;
      }
    }
    parsedLines.push(parsed);
  }

  return parsedLines;
};

const getApprovalDiffPalette = (kind: "add" | "remove") =>
  kind === "add"
    ? {
        accent: APPROVAL_DIFF_ADD_ACCENT,
        foreground: APPROVAL_DIFF_ADD_FOREGROUND,
        background: APPROVAL_DIFF_ADD_BACKGROUND,
        marker: "+",
      }
    : {
        accent: APPROVAL_DIFF_REMOVE_ACCENT,
        foreground: APPROVAL_DIFF_REMOVE_FOREGROUND,
        background: APPROVAL_DIFF_REMOVE_BACKGROUND,
        marker: "-",
      };

const getApprovalDiffStats = (previewText: string) =>
  parseApprovalPreviewLines(previewText).reduce(
    (stats, line) => {
      if (line.kind === "add") {
        stats.additions += 1;
      } else if (line.kind === "remove") {
        stats.deletions += 1;
      }
      return stats;
    },
    { additions: 0, deletions: 0 }
  );

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

const renderCompactApprovalMetric = (
  label: string,
  value: string,
  options?: {
    labelColor?: InkTone;
    valueColor?: InkTone;
    valueBackground?: InkTone;
  }
) => (
  <Box marginRight={1} marginTop={1}>
    <Text color={options?.labelColor ?? "gray"}>{`${label} `}</Text>
    <Text
      color={options?.valueColor ?? "white"}
      backgroundColor={options?.valueBackground}
    >
      {options?.valueBackground ? ` ${value} ` : value}
    </Text>
  </Box>
);

const renderCompactApprovalSection = (
  title: string,
  detail: string | undefined,
  children: React.ReactNode,
  borderColor: InkTone = "gray"
) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={borderColor}
    paddingX={1}
    paddingY={1}
    marginTop={1}
  >
    {renderSubtleHeader(title, detail)}
    {children}
  </Box>
);

const getApprovalDiffGutterWidth = (lines: ApprovalPreviewLine[]) => {
  const widest = lines.reduce((max, line) => {
    if (line.kind !== "add" && line.kind !== "remove") {
      return max;
    }
    return Math.max(max, line.lineNumber?.length ?? 0);
  }, 0);
  return Math.max(4, widest);
};

const renderApprovalLine = (
  parsed: ApprovalPreviewLine,
  index: number,
  action: PendingReviewItem["request"]["action"],
  gutterWidth: number
) => {
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
    const palette = getApprovalDiffPalette(parsed.kind);
    return (
      <Box key={`approval-diff-${index}`}>
        <Text color={palette.accent}>▌</Text>
        <Text> </Text>
        <Text color={palette.accent}>{palette.marker}</Text>
        <Text> </Text>
        <Text color={palette.foreground}>
          {parsed.lineNumber
            ? `${parsed.lineNumber.padStart(gutterWidth, " ")} │ `
            : `${" ".repeat(gutterWidth)} · `}
        </Text>
        {renderSegments(
          tokenizeCodeLine(parsed.content ?? "").map(segment => ({
            ...segment,
            color: segment.color === "red" || segment.color === "green" ? palette.foreground : segment.color,
          })),
          `approval-token-${index}`,
          { backgroundColor: palette.background }
        )}
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
      action === "run_command" ||
      action === "run_shell" ||
      action === "open_shell" ||
      action === "write_shell"
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
  const parsedPreviewLines = parseApprovalPreviewLines(previewSource);
  const previewWindow = getPreviewWindow(parsedPreviewLines, approvalPanel.previewOffset);
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
      borderStyle="single"
      borderColor={tone.border}
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
        {isCommandSummaryRequest(selectedPending.request) ? (
          <>
            {isShellSummaryRequest(selectedPending.request)
              ? renderApprovalSummaryRow("Shell", "platform default", "red")
              : null}
            {"command" in selectedPending.request
              ? renderApprovalSummaryRow("Command", selectedPending.request.command, "yellow")
              : null}
            {"input" in selectedPending.request
              ? renderApprovalSummaryRow("Input", selectedPending.request.input, "yellow")
              : null}
            {"args" in selectedPending.request && selectedPending.request.args.length > 0
              ? renderApprovalSummaryRow("Args", selectedPending.request.args.join(" "), "white")
              : null}
            {renderApprovalSummaryRow(
              "Cwd",
              getApprovalRequestCwd(selectedPending.request),
              "magenta"
            )}
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
  parsed: ApprovalPreviewLine,
  index: number,
  action: PendingReviewItem["request"]["action"],
  gutterWidth: number
) => {
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
    const palette = getApprovalDiffPalette(parsed.kind);
    const lineNumber = parsed.lineNumber
      ? parsed.lineNumber.padStart(gutterWidth, " ")
      : " ".repeat(gutterWidth);
    return (
      <Box key={`approval-diff-${index}`}>
        <Text color={palette.accent}>▌</Text>
        <Text
          color={palette.foreground}
          backgroundColor={palette.background}
        >
          {` ${palette.marker} ${lineNumber} | ${parsed.content ?? ""} `}
        </Text>
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
    return (
      <Box key={`approval-kv-${index}`}>
        <Text dimColor>{`${formatApprovalLabel(key)}: `}</Text>
        <Text color={keyTone}>{parsed.value || "(empty)"}</Text>
      </Box>
    );
  }

  const tone =
    action === "run_command" ||
    action === "run_shell" ||
    action === "open_shell" ||
    action === "write_shell"
      ? "white"
      : "gray";
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
  activeSessionId: string | null,
  appRoot: string
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
  const parsedPreviewLines = parseApprovalPreviewLines(previewSource);
  const diffStats = getApprovalDiffStats(previewSource);
  const previewWindow = getPreviewWindow(parsedPreviewLines, approvalPanel.previewOffset);
  const diffGutterWidth = getApprovalDiffGutterWidth(previewWindow.pageLines);
  const queueStart = Math.max(0, approvalPanel.selectedIndex - 2);
  const queueItems = pendingReviews.slice(
    queueStart,
    Math.min(pendingReviews.length, approvalPanel.selectedIndex + 3)
  );
  const tone = getActionTone(selectedPending.request.action);
  const hasDiffStats = diffStats.additions > 0 || diffStats.deletions > 0;
  const previewRangeLabel = `${previewWindow.safeOffset + 1}-${Math.min(
    previewWindow.safeOffset + previewWindow.pageLines.length,
    previewWindow.totalLines
  )}/${previewWindow.totalLines}`;

  return (
    <Box marginBottom={SECTION_GAP} flexDirection="column">
      <Box flexWrap="wrap">
        <Text bold color={tone.border}>
          [review]
        </Text>
        <Text> </Text>
        <Text color={tone.badgeFg} backgroundColor={tone.badgeBg}>
          {` ${selectedPending.request.action} `}
        </Text>
        <Text> </Text>
        <Text color="white">{shortenValue(selectedPending.request.path, 56)}</Text>
        <Text dimColor>
          {`  |  ${approvalPanel.selectedIndex + 1}/${pendingReviews.length}  |  ${approvalPanel.previewMode}  |  ${approvalState}`}
        </Text>
      </Box>
      <Text dimColor>
        {`cwd ${shortenValue(appRoot || "none", 28)}  |  session ${shortenValue(activeSessionId ?? "none", 14)}  |  model ${shortenValue(currentModel, 14)}  |  item ${selectedPending.id}`}
      </Text>
      <Text dimColor>{selectedPending.createdAt}</Text>

      {selectedInFlight ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">
            {`${approvalPanel.actionState === "reject" ? "Rejecting" : "Approving"} current item...`}
          </Text>
          <Text dimColor>review hotkeys are locked until the current action finishes</Text>
        </Box>
      ) : null}

      {selectedBlocked ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">
            {`Last error: ${shortenValue(blockedReason || "approval failed", 120)}`}
          </Text>
          <Text dimColor>retry with a  |  switch with ↑/↓  |  reject with r/d</Text>
        </Box>
      ) : null}

      {pendingReviews.length > 1 ? (
        <Box marginTop={1} flexDirection="column">
          <Box flexWrap="wrap">
            <Text color="cyan">[queue]</Text>
            <Text> </Text>
            <Text dimColor>{`${queueItems.length} visible  |  ${pendingReviews.length} total`}</Text>
          </Box>
          {queueItems.map((item, localIndex) => {
            const index = queueStart + localIndex;
            const selected = index === approvalPanel.selectedIndex;
            const itemTone = getActionTone(item.request.action);
            const blocked = approvalPanel.blockedItemId === item.id;
            const inFlight = approvalPanel.inFlightId === item.id;
            return (
              <Box key={`compact-review-list-${item.id}`} flexWrap="wrap">
                <Text color={selected ? "cyan" : "gray"}>{selected ? "> " : "  "}</Text>
                <Text color={itemTone.badgeFg} backgroundColor={itemTone.badgeBg}>
                  {` ${item.request.action} `}
                </Text>
                <Text> </Text>
                <Text color={selected ? "white" : "gray"}>
                  {shortenValue(item.request.path, 68)}
                </Text>
                {blocked ? (
                  <>
                    <Text> </Text>
                    <Text color="white" backgroundColor="red">
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
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Box flexWrap="wrap">
          <Text color="cyan">[selection]</Text>
          <Text> </Text>
          <Text dimColor>{describeApprovalAction(selectedPending.request.action)}</Text>
        </Box>
        {hasDiffStats ? (
          <Box flexWrap="wrap">
            {renderCompactApprovalMetric("Changes", `${diffStats.additions + diffStats.deletions}`)}
            {renderCompactApprovalMetric(`+${diffStats.additions} lines`, "added", {
              labelColor: APPROVAL_DIFF_ADD_ACCENT,
              valueColor: APPROVAL_DIFF_ADD_FOREGROUND,
              valueBackground: APPROVAL_DIFF_ADD_BACKGROUND,
            })}
            {renderCompactApprovalMetric(`-${diffStats.deletions} lines`, "deleted", {
              labelColor: APPROVAL_DIFF_REMOVE_ACCENT,
              valueColor: APPROVAL_DIFF_REMOVE_FOREGROUND,
              valueBackground: APPROVAL_DIFF_REMOVE_BACKGROUND,
            })}
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={hasDiffStats ? 1 : 0}>
          {renderCompactApprovalSummaryRow("Path", selectedPending.request.path, "white")}
          {"destination" in selectedPending.request ? (
            renderCompactApprovalSummaryRow(
              "Destination",
              selectedPending.request.destination,
              "cyan"
            )
          ) : null}
          {isCommandSummaryRequest(selectedPending.request) ? (
            <>
              {isShellSummaryRequest(selectedPending.request)
                ? renderCompactApprovalSummaryRow("Shell", "platform default", "red")
                : null}
              {"command" in selectedPending.request
                ? renderCompactApprovalSummaryRow(
                    "Command",
                    selectedPending.request.command,
                    "yellow"
                  )
                : null}
              {"input" in selectedPending.request
                ? renderCompactApprovalSummaryRow(
                    "Input",
                    selectedPending.request.input,
                    "yellow"
                  )
                : null}
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
                getApprovalRequestCwd(selectedPending.request),
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
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box flexWrap="wrap">
          <Text color="cyan">[preview]</Text>
          <Text> </Text>
          <Text bold color="white">
            {getApprovalPreviewHeading(selectedPending.request.action)}
          </Text>
          <Text dimColor>{`  ${previewRangeLabel}`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {previewWindow.pageLines.map((line, index) =>
            renderCompactApprovalLine(
              line,
              index,
              selectedPending.request.action,
              diffGutterWidth
            )
          )}
        </Box>
      </Box>

      <Text dimColor>
        Tab: preview  |  a: approve/retry  |  r/d: reject  |  j/k or PgUp/PgDn: scroll  |  Esc: close
      </Text>
    </Box>
  );
};

export const ChatScreen = ({
  items,
  liveAssistantText,
  status,
  appRoot,
  input,
  inputCursorOffset,
  inputCommandState,
  shellSession,
  resumePicker,
  sessionsPanel,
  modelPicker,
  providerPicker,
  pendingReviews,
  approvalPanel,
  authPanel,
  authStatus,
  composerKeymap,
  activeSessionId,
  currentModel,
  currentProvider,
  usage,
  onInputChange,
  onSubmit,
}: ChatScreenProps) => {
  const [spinnerIndex, setSpinnerIndex] = React.useState(0);
  const [shellClock, setShellClock] = React.useState(() => Date.now());
  const approvalModeActive = approvalPanel.active;
  const shouldAnimateStreaming = ENABLE_STREAMING_ANIMATION && !approvalModeActive;
  const isAnimatedWaitingStatus =
    status === "preparing" || status === "requesting" || status === "streaming";

  React.useEffect(() => {
    if (!isAnimatedWaitingStatus || !shouldAnimateStreaming) {
      setSpinnerIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerIndex(previous => (previous + 1) % SPINNER_FRAMES.length);
    }, 220);
    return () => clearInterval(timer);
  }, [isAnimatedWaitingStatus, shouldAnimateStreaming, status]);

  React.useEffect(() => {
    if (
      !shellSession.visible ||
      (!shellSession.openedAt && !shellSession.runningSince && !shellSession.lastOutputAt)
    ) {
      return;
    }

    setShellClock(Date.now());
    const timer = setInterval(() => {
      setShellClock(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [
    shellSession.lastOutputAt,
    shellSession.openedAt,
    shellSession.runningSince,
    shellSession.visible,
  ]);

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
  const providerPage = React.useMemo(
    () =>
      formatPaged(
        providerPicker.providers,
        providerPicker.selectedIndex,
        providerPicker.pageSize
      ),
    [providerPicker.pageSize, providerPicker.providers, providerPicker.selectedIndex]
  );

  const isPanelActive =
    authPanel.active ||
    resumePicker.active ||
    sessionsPanel.active ||
    modelPicker.active ||
    providerPicker.active ||
    approvalPanel.active;
  const activePanel = authPanel.active
    ? "auth"
    : sessionsPanel.active
    ? "sessions"
    : resumePicker.active
      ? "resume"
      : modelPicker.active
        ? "models"
        : providerPicker.active
          ? "provider"
        : approvalPanel.active
          ? "approval"
          : "idle";

  const showStartupView =
    activePanel === "idle" &&
    !liveAssistantText &&
    items.every(item => item.role === "system" && item.kind === "system_hint");
  const transcriptWindow = React.useMemo(
    () => (showStartupView ? getTranscriptWindow([]) : getTranscriptWindow(items)),
    [items, showStartupView]
  );
  const showTranscriptWindowNotice =
    transcriptWindow.hiddenCount > 0 &&
    !liveAssistantText &&
    !(status === "preparing" || status === "requesting" || status === "streaming");
  const transcriptNodes = React.useMemo(
    () =>
      transcriptWindow.items.map((item, index) =>
        renderMessageItem(item, index + transcriptWindow.hiddenCount, getMessageClipOptions(item))
      ),
    [transcriptWindow.hiddenCount, transcriptWindow.items]
  );
  const liveAssistantNode = React.useMemo(
    () =>
      liveAssistantText
        ? renderStreamingAssistantItem(
            liveAssistantText,
            items.length,
            {
              preferTail: true,
              maxLines: MAX_STREAMING_RENDER_TEXT_LINES,
              maxChars: MAX_STREAMING_RENDER_TEXT_CHARS,
              suppressNotice: true,
            }
          )
        : null,
    [items.length, liveAssistantText]
  );

  const spinner = shouldAnimateStreaming
    ? SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] || STREAMING_IDLE_GLYPH
    : STREAMING_IDLE_GLYPH;
  const pendingSummary = pendingReviews[approvalPanel.selectedIndex]
    ? `${pendingReviews[approvalPanel.selectedIndex]?.request.action}  |  ${pendingReviews[approvalPanel.selectedIndex]?.request.path}`
    : "no active review";
  const statusLineNode = React.useMemo(
    () =>
      renderStatusLine(
        status,
        activeSessionId,
        currentModel,
        currentProvider,
        appRoot,
        usage,
        pendingReviews.length,
        activePanel,
        spinner
      ),
    [
      activePanel,
      activeSessionId,
      appRoot,
      currentModel,
      currentProvider,
      pendingReviews.length,
      spinner,
      status,
      usage,
    ]
  );
  const composerNode = React.useMemo(
    () =>
      renderMainComposer(
        status,
        input,
        inputCursorOffset,
        onInputChange,
        onSubmit,
        activePanel,
        showStartupView,
        inputCommandState,
        shellSession,
        shellClock,
        composerKeymap
      ),
    [
      composerKeymap,
      input,
      inputCommandState,
      inputCursorOffset,
      isPanelActive,
      onInputChange,
      onSubmit,
      shellSession,
      shellClock,
      showStartupView,
      status,
    ]
  );

  return (
    <Box flexDirection="column">
      {authPanel.active ? renderAuthWizardPanel(authPanel, authStatus) : null}

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

      {providerPicker.active &&
        renderCompactSimplePanel(
          "Providers",
          providerPage,
          activeSessionId,
          currentModel,
          `${formatProviderLabel(currentProvider, 28)} | profile ${formatProviderProfileLabel(
            providerPicker.providerProfiles?.[currentProvider] ?? "custom"
          )} | source ${formatProviderProfileSourceLabel(
            providerPicker.providerProfileSources?.[currentProvider] ??
              "inferred"
          )} | key ${formatKeySourceLabel(providerPicker.currentKeySource)}`,
          providerPage.pageItems.map((provider, localIndex) => {
            const index = providerPage.pageStart + localIndex;
            const selected = index === providerPicker.selectedIndex;
            const isCurrent = provider === currentProvider;
            const profile = providerPicker.providerProfiles?.[provider] ?? "custom";
            const profileSource =
              providerPicker.providerProfileSources?.[provider] ?? "inferred";
            const endpointKind = getProviderEndpointKind(provider, profile);
            return (
              <React.Fragment key={`provider-picker-${provider}-${index}`}>
                {renderCompactPickerItem(
                  formatProviderLabel(provider, 36),
                  `profile ${formatProviderProfileLabel(profile)}  |  source ${formatProviderProfileSourceLabel(profileSource)}  |  endpoint ${endpointKind}  |  ${provider}`,
                  selected,
                  isCurrent ? "current" : undefined
                )}
              </React.Fragment>
            );
          }),
          `Up/Down: select  Left/Right: page  Enter: switch  Esc: close  |  key source ${formatKeySourceLabel(providerPicker.currentKeySource)}`
        )}

      {pendingReviews.length > 0 && !approvalPanel.active && (
        <Text color="yellow" dimColor>
          {`review ${pendingReviews.length} pending  |  ${pendingSummary}`}
        </Text>
      )}

      {approvalPanel.active
        ? renderCompactApprovalPanel(
            pendingReviews,
            approvalPanel,
            currentModel,
            activeSessionId,
            appRoot
          )
        : null}

      <Box marginBottom={SECTION_GAP} flexDirection="column">
        {showStartupView
          ? renderStartupView(appRoot, currentModel, currentProvider, activeSessionId, authStatus)
          : null}
        {showTranscriptWindowNotice ? (
          <Text dimColor>
            {`[render window] showing latest ${transcriptWindow.items.length} of ${items.length} messages`}
          </Text>
        ) : null}
        {transcriptNodes}
        {liveAssistantNode}
      </Box>

      {composerNode}
      {statusLineNode}
    </Box>
  );
};
