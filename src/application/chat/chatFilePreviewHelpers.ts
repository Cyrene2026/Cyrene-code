export type FilePreviewResult = {
  text: string;
  meta: string | null;
};

export type OutlineEntry = {
  line: number;
  label: string;
};

export type ShellSessionStatus = "none" | "idle" | "running" | "exited" | "closed";

export type ShellSessionState = {
  visible: boolean;
  status: ShellSessionStatus;
  shell: string | null;
  cwd: string | null;
  busy: boolean;
  alive: boolean;
  pendingOutput: boolean;
  lastExit: string | null;
  lastEvent: "opened" | "interrupted" | null;
  openedAt: number | null;
  runningSince: number | null;
  lastOutputSummary: string | null;
  lastOutputAt: number | null;
};

export type ParsedShellSessionSnapshot = Omit<
  ShellSessionState,
  "openedAt" | "runningSince" | "lastOutputSummary" | "lastOutputAt"
> & {
  outputSummary: string | null;
  hasOutputSummary: boolean;
};

export const EMPTY_SHELL_SESSION_STATE: ShellSessionState = {
  visible: false,
  status: "none",
  shell: null,
  cwd: null,
  busy: false,
  alive: false,
  pendingOutput: false,
  lastExit: null,
  lastEvent: null,
  openedAt: null,
  runningSince: null,
  lastOutputSummary: null,
  lastOutputAt: null,
};

export const SHELL_SESSION_ACTIONS = new Set([
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
]);

const getFieldValues = (lines: string[], key: string) =>
  lines
    .map(line => line.trim())
    .filter(line => line.toLowerCase().startsWith(`${key.toLowerCase()}:`))
    .map(line => line.replace(new RegExp(`^${key}:\\s*`, "i"), "").trim());

const getLastFieldValue = (lines: string[], key: string) => {
  const values = getFieldValues(lines, key);
  return values[values.length - 1] ?? "";
};

const normalizeNullableField = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") {
    return null;
  }
  return trimmed;
};

const parseBooleanField = (value: string) =>
  value.trim().toLowerCase() === "true";

export const extractMessageBody = (raw: string) => {
  const [, ...rest] = raw.split("\n");
  return rest.join("\n").trim();
};

const parseNumberedPreviewLine = (line: string) => {
  const match = line.match(/^\s*(>\s*)?(\d+)\s+\|\s?(.*)$/);
  if (!match) {
    return null;
  }

  return {
    highlighted: Boolean(match[1]),
    lineNumber: Number.parseInt(match[2] ?? "0", 10),
    text: match[3] ?? "",
  };
};

export const parseReadRangePreview = (raw: string): FilePreviewResult => {
  const body = extractMessageBody(raw);
  if (!body) {
    return {
      text: "",
      meta: null,
    };
  }

  const lines = body.split("\n");
  const range = getLastFieldValue(lines, "lines");
  const previewLines = lines
    .map(parseNumberedPreviewLine)
    .filter((line): line is NonNullable<typeof line> => line !== null)
    .map(line => line.text)
    .filter(Boolean);
  const fallbackLines =
    previewLines.length > 0
      ? previewLines
      : lines
          .map(line => line.trim())
          .filter(
            line =>
              Boolean(line) &&
              !line.toLowerCase().startsWith("path:") &&
              !line.toLowerCase().startsWith("lines:") &&
              !line.toLowerCase().startsWith("note:")
          );

  return {
    text: fallbackLines.slice(0, 6).join("\n"),
    meta: range ? `lines ${range}` : null,
  };
};

export const parseSearchTextContextPreview = (
  raw: string
): FilePreviewResult => {
  const body = extractMessageBody(raw);
  if (!body) {
    return {
      text: "",
      meta: null,
    };
  }

  const lines = body.split("\n");
  const previewLines = lines
    .map(parseNumberedPreviewLine)
    .filter((line): line is NonNullable<typeof line> => line !== null);

  if (previewLines.length === 0) {
    return {
      text: "",
      meta: null,
    };
  }

  const startLine = previewLines[0]?.lineNumber ?? null;
  const endLine = previewLines[previewLines.length - 1]?.lineNumber ?? startLine;
  const rangeLabel =
    startLine === null
      ? null
      : startLine === endLine
        ? `line ${startLine}`
        : `lines ${startLine}-${endLine}`;

  return {
    text: previewLines
      .slice(0, 6)
      .map(line => `${line.highlighted ? "› " : ""}${line.text}`)
      .join("\n"),
    meta: rangeLabel ? `context hit  |  ${rangeLabel}` : "context hit",
  };
};

export const parseOutlineEntries = (raw: string): OutlineEntry[] =>
  extractMessageBody(raw)
    .split("\n")
    .map(parseNumberedPreviewLine)
    .filter((line): line is NonNullable<typeof line> => line !== null)
    .map(line => ({
      line: line.lineNumber,
      label: line.text.trim(),
    }))
    .filter(entry => Boolean(entry.label));

export const pickOutlineEntry = (
  entries: OutlineEntry[],
  query: string
): OutlineEntry | null => {
  if (entries.length === 0) {
    return null;
  }

  const normalizedTokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter(Boolean);

  if (normalizedTokens.length === 0) {
    return entries[0] ?? null;
  }

  for (const entry of entries) {
    const normalizedLabel = entry.label.toLowerCase();
    let searchStart = 0;
    let matched = true;
    for (const token of normalizedTokens) {
      const index = normalizedLabel.indexOf(token, searchStart);
      if (index < 0) {
        matched = false;
        break;
      }
      searchStart = index + token.length;
    }
    if (matched) {
      return entry;
    }
  }

  return (
    entries.find(entry =>
      normalizedTokens.some(token => entry.label.toLowerCase().includes(token))
    ) ??
    entries[0] ??
    null
  );
};

export const formatSymbolPreviewMeta = (
  entry: OutlineEntry,
  rangeMeta: string | null
) => `symbol ${entry.label}${rangeMeta ? `  |  ${rangeMeta}` : ""}`;

const parseShellOutputSummary = (lines: string[]) => {
  const outputIndex = lines.findIndex(
    line => line.trim().toLowerCase() === "output:"
  );

  if (outputIndex < 0) {
    return {
      summary: null,
      present: false,
    };
  }

  const meaningfulLines = lines
    .slice(outputIndex + 1)
    .map(line => line.trim())
    .filter(line => Boolean(line) && line !== "(no new output)");

  if (meaningfulLines.length === 0) {
    return {
      summary: null,
      present: true,
    };
  }

  const outputTruncated = parseBooleanField(
    getLastFieldValue(lines, "output_truncated")
  );
  const summary = meaningfulLines
    .slice(-2)
    .map(line => line.replace(/\s+/g, " "))
    .join("  ·  ");

  return {
    summary:
      summary.length > 120
        ? `${summary.slice(0, 117)}...`
        : outputTruncated
          ? `${summary} ...`
          : summary,
    present: true,
  };
};

export const parseShellSessionMessage = (
  raw: string
): ParsedShellSessionSnapshot | null => {
  const body = extractMessageBody(raw);
  if (!body) {
    return null;
  }

  const lines = body.split("\n");
  const statusValues = getFieldValues(lines, "status").map(value =>
    value.toLowerCase()
  );
  const primaryStatus = statusValues[0] ?? "";
  const effectiveStatus =
    [...statusValues]
      .reverse()
      .find(value =>
        value === "none" ||
        value === "idle" ||
        value === "running" ||
        value === "exited"
      ) ?? primaryStatus;

  const shell = normalizeNullableField(getLastFieldValue(lines, "shell"));
  const cwd = normalizeNullableField(getLastFieldValue(lines, "cwd"));
  const busy = parseBooleanField(getLastFieldValue(lines, "busy"));
  const alive = parseBooleanField(getLastFieldValue(lines, "alive"));
  const pendingOutput = parseBooleanField(
    getLastFieldValue(lines, "pending_output")
  );
  const lastExitValue = getLastFieldValue(lines, "last_exit");
  const lastExit =
    !lastExitValue ||
    lastExitValue.toLowerCase() === "unknown" ||
    lastExitValue.toLowerCase() === "none"
      ? null
      : lastExitValue;
  const outputSummary = parseShellOutputSummary(lines);

  if (
    statusValues.length === 0 &&
    !shell &&
    !cwd &&
    !busy &&
    !alive &&
    !pendingOutput &&
    !lastExit &&
    !outputSummary.present
  ) {
    return null;
  }

  const isClosed = primaryStatus === "closed";
  const status: ShellSessionStatus = isClosed
    ? "closed"
    : effectiveStatus === "running"
      ? "running"
      : effectiveStatus === "idle"
        ? "idle"
        : effectiveStatus === "exited"
          ? "exited"
          : "none";

  return {
    visible:
      !isClosed &&
      status !== "none" &&
      (shell !== null ||
        cwd !== null ||
        busy ||
        alive ||
        pendingOutput ||
        lastExit !== null ||
        status === "exited"),
    status,
    shell,
    cwd,
    busy,
    alive,
    pendingOutput,
    lastExit,
    lastEvent:
      primaryStatus === "opened" || primaryStatus === "interrupted"
        ? primaryStatus
        : null,
    outputSummary: outputSummary.summary,
    hasOutputSummary: outputSummary.present,
  };
};

export const areShellSessionsEqual = (
  left: ShellSessionState,
  right: ShellSessionState
) =>
  left.visible === right.visible &&
  left.status === right.status &&
  left.shell === right.shell &&
  left.cwd === right.cwd &&
  left.busy === right.busy &&
  left.alive === right.alive &&
  left.pendingOutput === right.pendingOutput &&
  left.lastExit === right.lastExit &&
  left.lastEvent === right.lastEvent &&
  left.openedAt === right.openedAt &&
  left.runningSince === right.runningSince &&
  left.lastOutputSummary === right.lastOutputSummary &&
  left.lastOutputAt === right.lastOutputAt;
