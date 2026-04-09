import { getUncachedPromptTokenCount } from "../../core/query/tokenUsage";

const ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[H";
const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[90m";
const ANSI_CYAN = "\x1b[96m";
const ANSI_WHITE = "\x1b[97m";

export type ExitSummarySnapshot = {
  startedAt: string;
  activeSessionId: string | null;
  currentModel: string;
  requestCount: number;
  stateUpdateCount: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type BuildExitScreenOptions = {
  ansi?: boolean;
  now?: Date | string | number;
  confirmHint?: string;
};

type CreateExitHandlerOptions = {
  ansi?: boolean;
  now?: () => Date | string | number;
  confirmBeforeExit?: boolean;
  confirmTimeoutMs?: number;
  forceExit?: () => void;
  stdin?: {
    on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
    off: (event: "data", listener: (chunk: Buffer | string) => void) => void;
    isTTY?: boolean;
  };
  signalTarget?: {
    on: (event: "SIGINT", listener: () => void) => void;
    off: (event: "SIGINT", listener: () => void) => void;
  };
};

const stripAnsi = (value: string) =>
  value.replace(/\x1B\[[0-9;]*m/g, "");

const colorize = (value: string, code: string, ansi: boolean) =>
  ansi ? `${code}${value}${ANSI_RESET}` : value;

const formatDuration = (startedAt: string, now: Date | string | number = new Date()) => {
  const startedMs = Date.parse(startedAt);
  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.parse(now);

  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) {
    return "0s";
  }

  let remainingSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds -= days * 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds -= hours * 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  remainingSeconds -= minutes * 60;
  const seconds = remainingSeconds;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.slice(0, 3).join(" ");
};

const padCardLine = (line: string, width: number) => {
  const visibleLength = stripAnsi(line).length;
  const trailing = Math.max(0, width - visibleLength);
  return `│ ${line}${" ".repeat(trailing)} │`;
};

export const buildExitScreen = (
  summary: ExitSummarySnapshot,
  options: BuildExitScreenOptions = {}
) => {
  const ansi = options.ansi ?? true;
  const confirmHint = options.confirmHint?.trim() || "";
  const sessionLabel = summary.activeSessionId ?? "-";
  const modelLabel = summary.currentModel.trim() || "-";
  const runtimeLabel = formatDuration(summary.startedAt, options.now);
  const uncachedPromptTokens = getUncachedPromptTokenCount(summary);
  const rows = [
    ["session", sessionLabel],
    ["model", modelLabel],
    ["runtime", runtimeLabel],
    ["requests", String(summary.requestCount)],
    ["state updates", String(summary.stateUpdateCount)],
    ["prompt uncached", String(uncachedPromptTokens)],
    ["cached", String(summary.cachedTokens)],
    ["completion", String(summary.completionTokens)],
    ["total", String(summary.totalTokens)],
  ] as const;

  const labelWidth = rows.reduce(
    (maxWidth, [label]) => Math.max(maxWidth, label.length),
    0
  );
  const bodyLines = rows.map(([label, value]) => {
    const plain = `${label.padEnd(labelWidth)} ${value}`;
    const visibleGap = plain.length - label.length;
    const coloredLabel = colorize(label, ANSI_DIM, ansi);
    const coloredValue = colorize(value, ANSI_WHITE, ansi);
    return `${coloredLabel}${" ".repeat(visibleGap)}${coloredValue}`;
  });

  const bye = colorize("bye!", ANSI_CYAN, ansi);
  const hintLine = confirmHint ? colorize(confirmHint, ANSI_DIM, ansi) : "";
  const plainTitle = "CYRENE | Session Summary";
  const title = ansi
    ? `${ANSI_CYAN}${ANSI_BOLD}CYRENE${ANSI_RESET}${ANSI_CYAN} | Session Summary${ANSI_RESET}`
    : plainTitle;
  const contentWidth = Math.max(
    plainTitle.length,
    stripAnsi(bye).length,
    stripAnsi(hintLine).length,
    ...bodyLines.map(line => stripAnsi(line).length)
  );

  const top = `┌${"─".repeat(contentWidth + 2)}┐`;
  const divider = `├${"─".repeat(contentWidth + 2)}┤`;
  const bottom = `└${"─".repeat(contentWidth + 2)}┘`;
  const lines = [
    top,
    padCardLine(title, contentWidth),
    divider,
    ...bodyLines.map(line => padCardLine(line, contentWidth)),
    divider,
    ...(hintLine ? [padCardLine(hintLine, contentWidth)] : []),
    ...(hintLine ? [divider] : []),
    padCardLine(bye, contentWidth),
    bottom,
  ];

  return `${ansi ? ANSI_CLEAR_SCREEN : ""}${lines.join("\n")}\n`;
};

export const createExitHandler = (
  getSnapshot: () => ExitSummarySnapshot,
  write: (text: string) => void,
  exit: () => void,
  options: CreateExitHandlerOptions = {}
) => {
  type ExitState = "idle" | "awaiting_confirm" | "finalized";
  let state: ExitState = "idle";
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let stdinListener: ((chunk: Buffer | string) => void) | null = null;
  let sigintListener: (() => void) | null = null;
  const stdin = options.stdin ?? process.stdin;
  const signalTarget = options.signalTarget ?? process;

  const cleanupConfirmGuards = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (stdinListener) {
      stdin.off("data", stdinListener);
      stdinListener = null;
    }
    if (sigintListener) {
      signalTarget.off("SIGINT", sigintListener);
      sigintListener = null;
    }
  };

  const finalize = () => {
    if (state === "finalized") {
      return false;
    }
    state = "finalized";
    cleanupConfirmGuards();
    options.forceExit?.();
    return true;
  };

  const armConfirmGuards = () => {
    if (!options.forceExit) {
      return;
    }

    stdinListener = chunk => {
      const raw = chunk.toString();
      if (raw.includes("\r") || raw.includes("\n")) {
        finalize();
      }
    };

    sigintListener = () => {
      finalize();
    };

    const canReadConfirmInput = stdin?.isTTY !== false;
    if (canReadConfirmInput && stdin?.on) {
      stdin.on("data", stdinListener);
    }
    signalTarget.on("SIGINT", sigintListener);

    const confirmTimeoutMs = options.confirmTimeoutMs ?? 10_000;
    if (confirmTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        finalize();
      }, confirmTimeoutMs);
    }
  };

  return () => {
    if (state === "finalized") {
      return false;
    }
    if (state === "awaiting_confirm") {
      return finalize();
    }

    const confirmBeforeExit = options.confirmBeforeExit ?? true;
    const snapshot = getSnapshot();
    const screen = buildExitScreen(snapshot, {
      ansi: options.ansi,
      now: options.now?.(),
      confirmHint: confirmBeforeExit
        ? "Press Enter or Ctrl+C to exit"
        : undefined,
    });

    try {
      exit();
    } finally {
      write(screen);
    }

    if (confirmBeforeExit) {
      state = "awaiting_confirm";
      armConfirmGuards();
      return true;
    }

    state = "finalized";
    return true;
  };
};
