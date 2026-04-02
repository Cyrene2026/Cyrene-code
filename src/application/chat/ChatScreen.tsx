import React from "react";
import { Box, Text, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { SessionListItem } from "../../core/session/types";
import type { FileAction, PendingReviewItem } from "../../core/tools/mcp/types";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";

type ChatScreenProps = {
  items: ChatItem[];
  status: ChatStatus;
  input: string;
  resumePicker: {
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
    lastOpenedAt: string | null;
  };
  onInputChange: (next: string) => void;
  onSubmit: () => void;
};

const PENDING_HINT =
  "Use /review to inspect the queue, /approve <id> to apply, or /reject <id> to cancel.";

const APPROVAL_HINT = "↑/↓ select  Tab preview  a approve  r reject  Esc close";

const KEYWORD_PATTERN =
  /\b(?:def|class|return|if|elif|else|for|while|in|import|from|async|await|try|except|finally|with|as|const|let|var|function|export|type|interface|extends|implements|new|throw|switch|case|break|continue|public|private|protected)\b/g;

const resolveItemColor = (item: ChatItem) => {
  if (item.kind === "error" || item.tone === "danger") {
    return "red";
  }
  if (item.kind === "review_status" && item.tone === "warning") {
    return "red";
  }
  if (item.kind === "review_status") {
    return "yellow";
  }
  if (item.kind === "tool_status" || item.tone === "info") {
    return "blue";
  }
  if (item.kind === "system_hint") {
    return "gray";
  }
  if (item.tone === "success") {
    return "green";
  }
  if (item.color) {
    return item.color;
  }
  return "white";
};

const isDangerAction = (action: FileAction) =>
  action === "delete_file" || action === "edit_file";

const getActionBadge = (
  action: FileAction
): {
  backgroundColor: "red" | "yellow" | "cyan" | "blue" | "gray";
  textColor: "white" | "black";
  label: string;
} => {
  if (action === "delete_file") {
    return { backgroundColor: "red", textColor: "white", label: "DELETE" };
  }
  if (action === "edit_file") {
    return { backgroundColor: "yellow", textColor: "black", label: "EDIT" };
  }
  if (action === "write_file") {
    return { backgroundColor: "cyan", textColor: "black", label: "WRITE" };
  }
  if (action === "create_file") {
    return { backgroundColor: "blue", textColor: "white", label: "CREATE" };
  }
  if (action === "create_dir") {
    return { backgroundColor: "blue", textColor: "white", label: "MKDIR" };
  }
  if (action === "list_dir") {
    return { backgroundColor: "gray", textColor: "white", label: "LIST" };
  }
  return { backgroundColor: "gray", textColor: "white", label: "READ" };
};

const ellipsize = (value: string, max = 56) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const formatTimestamp = (value: string) => {
  const normalized = value.replace("T", " ").replace("Z", "");
  return normalized.length > 16 ? normalized.slice(0, 16) : normalized;
};

const inferLanguageFromPath = (text: string) => {
  const pathMatch = text.match(/path(?:=|:\s*)([^\s|]+)/i);
  const candidate = pathMatch?.[1] ?? "";
  const extMatch = candidate.match(/\.([a-z0-9]+)$/i);
  const ext = (extMatch?.[1] ?? "").toLowerCase();
  if (ext === "py") {
    return "python";
  }
  if (ext === "ts" || ext === "tsx") {
    return "typescript";
  }
  if (ext === "js" || ext === "jsx") {
    return "javascript";
  }
  if (ext === "json") {
    return "json";
  }
  if (ext === "yaml" || ext === "yml") {
    return "yaml";
  }
  return "";
};

const renderCodeTokens = (line: string, language?: string) => {
  const nodes: React.ReactNode[] = [];
  const tokenPattern =
    /(#[^\n]*$|\/\/[^\n]*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let cursor = 0;
  let keyIndex = 0;

  const pushKeywordChunks = (chunk: string) => {
    let start = 0;
    for (const match of chunk.matchAll(KEYWORD_PATTERN)) {
      const token = match[0];
      const index = match.index ?? 0;
      if (index > start) {
        nodes.push(chunk.slice(start, index));
      }
      nodes.push(
        <Text key={`${language ?? "plain"}-kw-${keyIndex++}`} color="cyan">
          {token}
        </Text>
      );
      start = index + token.length;
    }
    if (start < chunk.length) {
      nodes.push(chunk.slice(start));
    }
  };

  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      pushKeywordChunks(line.slice(cursor, index));
    }
    const color = token.startsWith("#") || token.startsWith("//") ? "gray" : "yellow";
    nodes.push(
      <Text key={`${language ?? "plain"}-tok-${keyIndex++}`} color={color}>
        {token}
      </Text>
    );
    cursor = index + token.length;
  }

  if (cursor < line.length) {
    pushKeywordChunks(line.slice(cursor));
  }

  return nodes.length > 0 ? nodes : [line];
};

const renderDiffLine = (line: string, key: string, prefix: string) => {
  const normalized = line.trimStart();
  const match = normalized.match(/^([+-])(\s*\d+\s+\|)(.*)$/);
  if (!match) {
    return null;
  }

  const sign = match[1] ?? "+";
  const linePart = (match[2] ?? "").trim();
  const content = match[3] ?? "";
  const marker = `${sign} ${linePart}`.padEnd(12, " ");
  const backgroundColor = sign === "+" ? "green" : "red";

  return (
    <Text key={key} color="gray">
      {prefix}
      <Text color="black" backgroundColor={backgroundColor}>
        {marker}
      </Text>
      <Text color="gray"> {renderCodeTokens(content, "diff")}</Text>
    </Text>
  );
};

const renderFormattedText = (
  text: string,
  baseColor: string,
  keyPrefix: string,
  options?: {
    prefixFirstLine?: string;
  }
) => {
  const nodes: React.ReactNode[] = [];
  const lines = text.split("\n");
  const inferredLanguage = inferLanguageFromPath(text);
  let inCodeBlock = false;
  let codeLanguage = "";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const key = `${keyPrefix}-${lineIndex}`;
    const normalized = line.trimStart();
    const prefix =
      lineIndex === 0 && options?.prefixFirstLine ? options.prefixFirstLine : "";
    const isFence = normalized.startsWith("```");

    if (isFence) {
      inCodeBlock = !inCodeBlock;
      codeLanguage = inCodeBlock ? normalized.slice(3).trim() : "";
      const languageLabel = codeLanguage || inferredLanguage || "plain";
      nodes.push(
        <Text key={key} color="cyan">
          {line}
        </Text>
      );
      if (inCodeBlock) {
        nodes.push(
          <Text key={`${key}-lang`} color="gray">
            [{`code: ${languageLabel}`}]
          </Text>
        );
      }
      continue;
    }

    if (inCodeBlock) {
      const diffNode = renderDiffLine(line, key, prefix);
      if (diffNode) {
        nodes.push(diffNode);
        continue;
      }
      nodes.push(
        <Text key={key} color="gray">
          {prefix}
          {renderCodeTokens(line, codeLanguage || inferredLanguage || "plain")}
        </Text>
      );
      continue;
    }

    nodes.push(
      <Text key={key} color={baseColor}>
        {prefix}
        {line}
      </Text>
    );
  }

  return nodes;
};

const renderTranscriptItem = (item: ChatItem, itemIndex: number) => (
  <Box key={`item-${itemIndex}`} flexDirection="column">
    {renderFormattedText(item.text, resolveItemColor(item), `item-${itemIndex}`, {
      prefixFirstLine: item.role === "user" ? "> " : undefined,
    })}
  </Box>
);

export const ChatScreen = ({
  items,
  status,
  input,
  resumePicker,
  modelPicker,
  pendingReviews,
  approvalPanel,
  onInputChange,
  onSubmit,
}: ChatScreenProps) => {
  const { stdout } = useStdout();
  const isNarrow = stdout.columns < 110;
  const renderedItems = React.useMemo(
    () => items.map((item, index) => renderTranscriptItem(item, index)),
    [items]
  );
  const pageStart =
    Math.floor(resumePicker.selectedIndex / resumePicker.pageSize) *
    resumePicker.pageSize;
  const pageSessions = resumePicker.sessions.slice(
    pageStart,
    pageStart + resumePicker.pageSize
  );
  const currentPage = Math.floor(resumePicker.selectedIndex / resumePicker.pageSize) + 1;
  const totalPages = Math.max(
    1,
    Math.ceil(resumePicker.sessions.length / resumePicker.pageSize)
  );
  const modelPageStart =
    Math.floor(modelPicker.selectedIndex / modelPicker.pageSize) *
    modelPicker.pageSize;
  const modelPageItems = modelPicker.models.slice(
    modelPageStart,
    modelPageStart + modelPicker.pageSize
  );
  const modelCurrentPage =
    Math.floor(modelPicker.selectedIndex / modelPicker.pageSize) + 1;
  const modelTotalPages = Math.max(
    1,
    Math.ceil(modelPicker.models.length / modelPicker.pageSize)
  );
  const selectedPendingReview =
    pendingReviews[
      Math.max(0, Math.min(approvalPanel.selectedIndex, pendingReviews.length - 1))
    ];
  const selectedBadge = selectedPendingReview
    ? getActionBadge(selectedPendingReview.request.action)
    : null;
  const dangerCount = pendingReviews.filter(item =>
    isDangerAction(item.request.action)
  ).length;
  const detailPreview = selectedPendingReview
    ? approvalPanel.previewMode === "full"
      ? selectedPendingReview.previewFull
      : selectedPendingReview.previewSummary
    : "";
  const detailNodes = React.useMemo(
    () =>
      renderFormattedText(
        detailPreview,
        "white",
        `approval-preview-${selectedPendingReview?.id ?? "none"}`
      ),
    [detailPreview, selectedPendingReview?.id]
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        {renderedItems}
      </Box>
      {resumePicker.active && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan">
            Resume Sessions (Page {currentPage}/{totalPages})
          </Text>
          {pageSessions.map((session, localIndex) => {
            const index = pageStart + localIndex;
            return (
              <Text
                key={session.id}
                color={index === resumePicker.selectedIndex ? "green" : undefined}
              >
                {index === resumePicker.selectedIndex ? "> " : "  "}
                {session.id} | {session.updatedAt} | {session.title}
              </Text>
            );
          })}
          <Text dimColor>Left/Right: page  Enter: resume  Esc: cancel</Text>
        </Box>
      )}
      {modelPicker.active && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan">
            Select Model (Page {modelCurrentPage}/{modelTotalPages})
          </Text>
          {modelPageItems.map((model, localIndex) => {
            const index = modelPageStart + localIndex;
            return (
              <Text
                key={model}
                color={index === modelPicker.selectedIndex ? "green" : undefined}
              >
                {index === modelPicker.selectedIndex ? "> " : "  "}
                {model}
              </Text>
            );
          })}
          <Text dimColor>
            Up/Down: select  Left/Right: page  Enter: switch  Esc: cancel
          </Text>
        </Box>
      )}
      {pendingReviews.length > 0 && (
        <Box
          marginBottom={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={approvalPanel.active ? "yellow" : "gray"}
          paddingX={1}
        >
          <Box flexDirection={isNarrow ? "column" : "row"} justifyContent="space-between">
            <Text color={approvalPanel.active ? "yellow" : "cyan"}>
              Approval Queue · {pendingReviews.length} pending
            </Text>
            {selectedPendingReview && (
              <Text dimColor>
                Focus {approvalPanel.selectedIndex + 1}/{pendingReviews.length} ·{" "}
                {selectedPendingReview.id} · {selectedPendingReview.request.action}
              </Text>
            )}
          </Box>
          {selectedPendingReview && (
            <Text color="gray">
              {selectedPendingReview.request.path}
            </Text>
          )}
          <Text dimColor>
            {approvalPanel.active
              ? APPROVAL_HINT
              : `${PENDING_HINT} Current focus: ${
                  selectedPendingReview
                    ? `${selectedPendingReview.id} · ${selectedPendingReview.request.action}`
                    : "none"
                }`}
          </Text>
        </Box>
      )}
      {approvalPanel.active && selectedPendingReview && selectedBadge && (
        <Box
          marginBottom={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={dangerCount > 0 ? "red" : "yellow"}
          paddingX={1}
        >
          <Box flexDirection={isNarrow ? "column" : "row"} justifyContent="space-between">
            <Box flexDirection="column">
              <Box>
                <Text color="yellow">Code Approval</Text>
                <Text color="gray"> · {pendingReviews.length} pending</Text>
                <Text color="gray"> · focus {approvalPanel.selectedIndex + 1}/</Text>
                <Text color="gray">{pendingReviews.length}</Text>
              </Box>
              <Box marginTop={0}>
                <Text color="black" backgroundColor={dangerCount > 0 ? "red" : "yellow"}>
                  {dangerCount > 0 ? ` danger ${dangerCount} ` : " normal "}
                </Text>
                <Text> </Text>
                <Text color="black" backgroundColor="cyan">
                  {` ${approvalPanel.previewMode} `}
                </Text>
                {approvalPanel.lastOpenedAt && (
                  <>
                    <Text> </Text>
                    <Text dimColor>opened {formatTimestamp(approvalPanel.lastOpenedAt)}</Text>
                  </>
                )}
              </Box>
            </Box>
            <Text dimColor>{APPROVAL_HINT}</Text>
          </Box>
          <Box
            marginTop={1}
            flexDirection={isNarrow ? "column" : "row"}
            justifyContent="space-between"
          >
            <Box
              flexDirection="column"
              width={isNarrow ? undefined : 40}
              marginRight={isNarrow ? 0 : 1}
              marginBottom={isNarrow ? 1 : 0}
            >
              <Text color="cyan">Queue</Text>
              {pendingReviews.map((item, index) => {
                const badge = getActionBadge(item.request.action);
                const selected = index === approvalPanel.selectedIndex;
                return (
                  <Box
                    key={item.id}
                    flexDirection="column"
                    borderStyle="round"
                    borderColor={selected ? "cyan" : "gray"}
                    paddingX={1}
                    marginTop={1}
                  >
                    <Text color={selected ? "cyan" : "gray"}>
                      {selected ? "> " : "  "}
                      #{index + 1} · {item.id}
                    </Text>
                    <Text color={selected ? "white" : "gray"}>
                      <Text
                        backgroundColor={badge.backgroundColor}
                        color={badge.textColor}
                      >
                        {` ${badge.label} `}
                      </Text>{" "}
                      {ellipsize(item.request.path, isNarrow ? 64 : 28)}
                    </Text>
                    <Text dimColor>{formatTimestamp(item.createdAt)}</Text>
                  </Box>
                );
              })}
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Text color="cyan">Detail</Text>
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor={isDangerAction(selectedPendingReview.request.action) ? "red" : "gray"}
                paddingX={1}
                marginTop={1}
              >
                <Box flexDirection={isNarrow ? "column" : "row"} justifyContent="space-between">
                  <Text>
                    <Text
                      backgroundColor={selectedBadge.backgroundColor}
                      color={selectedBadge.textColor}
                    >
                      {` ${selectedBadge.label} `}
                    </Text>{" "}
                    {selectedPendingReview.request.path}
                  </Text>
                  <Text dimColor>{formatTimestamp(selectedPendingReview.createdAt)}</Text>
                </Box>
                <Text color="gray">id: {selectedPendingReview.id}</Text>
                <Text color="gray">
                  preview: {approvalPanel.previewMode} · Tab toggles summary/full
                </Text>
                {approvalPanel.previewMode === "summary" && (
                  <Text dimColor>Showing condensed review. Press Tab for full preview.</Text>
                )}
                <Box flexDirection="column" marginTop={1}>
                  {detailNodes}
                </Box>
              </Box>
            </Box>
          </Box>
        </Box>
      )}
      <Box flexShrink={0}>
        <Text
          color={
            approvalPanel.active
              ? "yellow"
              : status === "streaming"
                ? "yellow"
                : "green"
          }
        >
          {(
            approvalPanel.active
              ? "Review Mode"
              : status === "streaming"
                ? "Streaming"
                : "Ready"
          ).padEnd(20, " ")}
        </Text>
        <TextInput
          value={input}
          focus={!approvalPanel.active && !modelPicker.active && !resumePicker.active}
          onChange={onInputChange}
          onSubmit={onSubmit}
          placeholder={
            approvalPanel.active
              ? "Approval panel active..."
              : "Ask something..."
          }
        />
      </Box>
    </Box>
  );
};
