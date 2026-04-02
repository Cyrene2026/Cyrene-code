import type { ChatItem } from "../../shared/types/chat";

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
    if (detail.startsWith("list_dir ")) {
      return {
        ...normalized,
        text: `Tool: ${detail} | ${summarizeListDirBody(body)}`,
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
    const reason = body.split("\n").find(line => line.trim().length > 0)?.trim();
    return {
      ...normalized,
      text: reason ? `Tool error: ${detail} | ${reason}` : `Tool error: ${detail}`,
    };
  }

  if (firstLine.startsWith("Approved")) {
    const detail = firstLine.replace("Approved", "").trim();
    const resultLine = body.split("\n").find(line => line.trim().length > 0)?.trim();
    return {
      ...normalized,
      text: resultLine ? `Approved ${detail} | ${resultLine}` : `Approved ${detail}`,
    };
  }

  if (firstLine.startsWith("Approve failed")) {
    const detail = firstLine.replace("Approve failed", "").trim();
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
