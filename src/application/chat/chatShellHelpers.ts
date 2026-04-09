import type { ToolRequest } from "../../core/mcp";

export type ShellShortcutAction =
  | "run_shell"
  | "open_shell"
  | "read_shell"
  | "shell_status"
  | "interrupt_shell"
  | "close_shell";

export type ParsedShellShortcut = {
  active: boolean;
  request: ToolRequest | null;
  action: ShellShortcutAction | null;
  command: string;
  actionLabel: string;
  description: string;
};

export const parseShellShortcut = (rawInput: string): ParsedShellShortcut => {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("!shell")) {
    return {
      active: false,
      request: null,
      action: null,
      command: "",
      actionLabel: "",
      description: "",
    };
  }

  const remainder = trimmed.slice("!shell".length).trim();
  if (!remainder) {
    return {
      active: true,
      request: null,
      action: null,
      command: "",
      actionLabel: "!shell",
      description:
        "Run a safe shell command, or use open/read/status/interrupt/close.",
    };
  }

  const [subcommandRaw = "", ...rest] = remainder.split(/\s+/);
  const subcommand = subcommandRaw.toLowerCase();
  const tail = rest.join(" ").trim();

  if (subcommand === "open") {
    return {
      active: true,
      request: {
        action: "open_shell",
        path: ".",
        ...(tail ? { cwd: tail } : {}),
      },
      action: "open_shell",
      command: tail || ".",
      actionLabel: "open_shell",
      description: tail
        ? `Open a persistent shell session in ${tail}.`
        : "Open a persistent shell session in the workspace root.",
    };
  }

  if (subcommand === "read") {
    return {
      active: true,
      request: { action: "read_shell", path: "." },
      action: "read_shell",
      command: "read",
      actionLabel: "read_shell",
      description: "Read buffered output from the persistent shell session.",
    };
  }

  if (subcommand === "status") {
    return {
      active: true,
      request: { action: "shell_status", path: "." },
      action: "shell_status",
      command: "status",
      actionLabel: "shell_status",
      description: "Inspect persistent shell status, cwd, and pending output.",
    };
  }

  if (subcommand === "interrupt") {
    return {
      active: true,
      request: { action: "interrupt_shell", path: "." },
      action: "interrupt_shell",
      command: "interrupt",
      actionLabel: "interrupt_shell",
      description: "Interrupt the currently running persistent shell command.",
    };
  }

  if (subcommand === "close") {
    return {
      active: true,
      request: { action: "close_shell", path: "." },
      action: "close_shell",
      command: "close",
      actionLabel: "close_shell",
      description: "Close the persistent shell session and discard its state.",
    };
  }

  return {
    active: true,
    request: {
      action: "run_shell",
      path: ".",
      command: remainder,
    },
    action: "run_shell",
    command: remainder,
    actionLabel: "run_shell",
    description: "Run a one-shot shell command through the review lane.",
  };
};
