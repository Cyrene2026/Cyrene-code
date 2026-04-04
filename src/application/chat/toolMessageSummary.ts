import type { ChatItem } from "../../shared/types/chat";

const TERMINAL_TOOL_ACTIONS = new Set([
  "run_command",
  "run_shell",
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
]);

const getFieldValue = (lines: string[], key: string) =>
  lines
    .map(line => line.trim())
    .find(line => line.toLowerCase().startsWith(`${key.toLowerCase()}:`))
    ?.replace(new RegExp(`^${key}:\\s*`, "i"), "")
    .trim() ?? "";

const inferApprovalTerminalAction = (body: string) => {
  const lines = body.split("\n");
  const explicitAction = getFieldValue(lines, "action");
  if (TERMINAL_TOOL_ACTIONS.has(explicitAction)) {
    return explicitAction;
  }

  const status = getFieldValue(lines, "status").toLowerCase();
  const hasCommand = Boolean(getFieldValue(lines, "command"));
  const hasShell = Boolean(getFieldValue(lines, "shell"));
  const hasInput = Boolean(getFieldValue(lines, "input"));
  const hasProgram = Boolean(getFieldValue(lines, "program"));
  const hasBusy = Boolean(getFieldValue(lines, "busy"));
  const hasAlive = Boolean(getFieldValue(lines, "alive"));
  const hasPendingOutput = Boolean(getFieldValue(lines, "pending_output"));
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

export const normalizeMcpMessage = (raw: string): {
  text: string;
  kind: ChatItem["kind"];
  tone: ChatItem["tone"];
  color: ChatItem["color"];
} => {
  const [header = "", ...rest] = raw.split("\n");
  const body = rest.join("\n");

  if (header.startsWith("[tool result]")) {
    const detail = header.replace("[tool result]", "").trim();
    return {
      text: `Tool result: ${detail}${body ? `\n${body}` : ""}`,
      kind: "tool_status",
      tone: "info",
      color: "cyan",
    };
  }
  if (header.startsWith("[tool error]")) {
    const detail = header.replace("[tool error]", "").trim();
    return {
      text: `Tool error: ${detail}${body ? `\n${body}` : ""}`,
      kind: "error",
      tone: "danger",
      color: "red",
    };
  }
  if (header.startsWith("[approved]")) {
    const id = header.replace("[approved]", "").trim();
    return {
      text: `Approved ${id}${body ? `\n${body}` : ""}`,
      kind: "review_status",
      tone: "success",
      color: "green",
    };
  }
  if (header.startsWith("[approve failed]")) {
    const id = header.replace("[approve failed]", "").trim();
    return {
      text: `Approve failed ${id}${body ? `\n${body}` : ""}`,
      kind: "error",
      tone: "danger",
      color: "red",
    };
  }
  if (header.startsWith("[rejected]")) {
    const id = header.replace("[rejected]", "").trim();
    return {
      text: `Rejected ${id}`,
      kind: "review_status",
      tone: "warning",
      color: "yellow",
    };
  }
  if (raw.startsWith("Pending operation not found:")) {
    const id = raw.replace("Pending operation not found:", "").trim();
    return {
      text: `Pending operation not found: ${id}`,
      kind: "error",
      tone: "danger",
      color: "red",
    };
  }

  return {
    text: raw,
    kind: "system_hint",
    tone: "neutral",
    color: "white",
  };
};

const summarizeListDirBody = (body: string, maxItems = 4) => {
  const lines = body
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "(empty directory)";
  }

  if (lines.length === 1) {
    return lines[0] ?? "(empty directory)";
  }

  const visible = lines.slice(0, maxItems).join(", ");
  const more = lines.length - Math.min(lines.length, maxItems);
  return `${visible} (${lines.length} items${more > 0 ? `, +${more} more` : ""})`;
};

const parseListDirBody = (body: string) => {
  const lines = body
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const confirmation = lines.find(line => line.startsWith("[confirmed directory state]"));
  const entries = lines.filter(line => !line.startsWith("[confirmed directory state]"));
  return {
    confirmation,
    entrySummary: summarizeListDirBody(entries.join("\n")),
  };
};

export const summarizeToolMessage = (raw: string): {
  text: string;
  kind: ChatItem["kind"];
  tone: ChatItem["tone"];
  color: ChatItem["color"];
} => {
  const normalized = normalizeMcpMessage(raw);
  const [firstLine = "", ...rest] = normalized.text.split("\n");
  const body = rest.join("\n").trim();
  const lowerBody = body.toLowerCase();

  if (firstLine.startsWith("Tool result:")) {
    const detail = firstLine.replace("Tool result:", "").trim();
    const action = detail.split(/\s+/, 1)[0] ?? "";
    if (TERMINAL_TOOL_ACTIONS.has(action)) {
      return {
        ...normalized,
        text: normalized.text,
      };
    }
    if (detail.startsWith("list_dir ")) {
      const { confirmation, entrySummary } = parseListDirBody(body);
      return {
        ...normalized,
        text: `Tool: ${detail} | ${confirmation ? "confirmed directory state" : "directory state"} | ${entrySummary}`,
      };
    }
    if (detail.startsWith("read_file ")) {
      const bodyLine =
        body.split("\n").find(line => line.trim().length > 0)?.trim() ?? "(empty file)";
      return {
        ...normalized,
        text: `Tool: ${detail} | ${bodyLine}`,
      };
    }
    let summary = `Tool: ${detail}`;
    if (body) {
      const bodyLine =
        body.split("\n").find(line => line.trim().length > 0)?.trim() ?? "";
      if (
        bodyLine &&
        bodyLine.toLowerCase() !== detail.toLowerCase() &&
        !lowerBody.includes("more lines")
      ) {
        summary = `${summary} | ${bodyLine}`;
      }
    }
    return {
      ...normalized,
      text: summary,
    };
  }

  if (firstLine.startsWith("Tool error:")) {
    const detail = firstLine.replace("Tool error:", "").trim();
    const action = detail.split(/\s+/, 1)[0] ?? "";
    if (TERMINAL_TOOL_ACTIONS.has(action)) {
      return {
        ...normalized,
        text: normalized.text,
      };
    }
    const reason = body.split("\n").find(line => line.trim().length > 0)?.trim();
    return {
      ...normalized,
      text: reason ? `Tool error: ${detail} | ${reason}` : `Tool error: ${detail}`,
    };
  }

  if (firstLine.startsWith("Approved")) {
    const action = inferApprovalTerminalAction(body);
    if (TERMINAL_TOOL_ACTIONS.has(action)) {
      return {
        ...normalized,
        text: normalized.text,
      };
    }
    const detail = firstLine.replace("Approved", "").trim();
    const resultLine = body.split("\n").find(line => line.trim().length > 0)?.trim();
    return {
      ...normalized,
      text: resultLine ? `Approved ${detail} | ${resultLine}` : `Approved ${detail}`,
    };
  }

  if (firstLine.startsWith("Approve failed") || firstLine.startsWith("Approval error")) {
    const action = inferApprovalTerminalAction(body);
    if (TERMINAL_TOOL_ACTIONS.has(action)) {
      return {
        ...normalized,
        text: normalized.text,
      };
    }
    const detail = firstLine
      .replace("Approve failed", "")
      .replace("Approval error", "")
      .trim();
    const reason = body.split("\n").find(line => line.trim().length > 0)?.trim();
    return {
      ...normalized,
      text: reason ? `Approval error: ${detail} | ${reason}` : `Approval error: ${detail}`,
    };
  }

  return {
    ...normalized,
    text: firstLine,
  };
};
