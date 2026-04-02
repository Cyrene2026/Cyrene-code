import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { SessionListItem } from "../../core/session/types";
import type { PendingReviewItem } from "../../core/tools/mcp/types";
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
  };
  activeSessionId: string | null;
  currentModel: string;
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
};

const BRAND_NAME = "CYRENE";
const SECTION_GAP = 1;
const SPINNER_FRAMES = ["·", "•", "●", "•"];
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

const shortenValue = (value: string, max = 20) =>
  value.length <= max ? value : `${value.slice(0, Math.max(1, max - 3))}...`;

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

const renderSegments = (segments: CodeSegment[], keyPrefix: string) => (
  <Text>
    {segments.map((segment, index) => (
      <Text key={`${keyPrefix}-${index}`} color={segment.color}>
        {segment.text}
      </Text>
    ))}
  </Text>
);

const renderPlainLine = (
  line: string,
  key: string,
  color: ChatItem["color"],
  prefix?: string
) => (
  <Text key={key} color={color}>
    {prefix ?? ""}
    {line || " "}
  </Text>
);

const renderCodeBlock = (code: string, itemIndex: number, langHint?: string) => {
  const language = langHint || inferCodeLanguage(code);
  const lines = code.split("\n");
  return (
    <Box
      key={`code-${itemIndex}-${language}`}
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      marginBottom={1}
    >
      <Text dimColor>{`code | ${language}`}</Text>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line, lineIndex) => (
          <Box key={`code-line-${itemIndex}-${lineIndex}`}>
            <Text dimColor>{String(lineIndex + 1).padStart(3, " ")} </Text>
            {renderSegments(tokenizeCodeLine(line), `code-token-${itemIndex}-${lineIndex}`)}
          </Box>
        ))}
      </Box>
    </Box>
  );
};

const renderMessageItem = (item: ChatItem, itemIndex: number) => {
  if (!item.text) {
    return null;
  }

  const color = resolveItemColor(item);
  const lines = item.text.split("\n");
  const nodes: React.ReactNode[] = [];
  let inCode = false;
  let codeLanguage = "";
  let codeBuffer: string[] = [];

  const flushCode = () => {
    if (!codeBuffer.length) {
      return;
    }
    nodes.push(renderCodeBlock(codeBuffer.join("\n"), itemIndex, codeLanguage));
    codeBuffer = [];
    codeLanguage = "";
  };

  lines.forEach((line, lineIndex) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLanguage = line.trim().slice(3).trim();
      }
      return;
    }

    if (inCode) {
      codeBuffer.push(line);
      return;
    }

    const isDiff = line.startsWith("+") || line.startsWith("-") || line.startsWith("@@");
    if (isDiff) {
      nodes.push(
        <Box
          key={`diff-${itemIndex}-${lineIndex}`}
          borderStyle="single"
          borderColor={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : "cyan"}
          paddingX={1}
          marginTop={1}
        >
          {renderSegments(tokenizeCodeLine(line), `diff-token-${itemIndex}-${lineIndex}`)}
        </Box>
      );
      return;
    }

    nodes.push(
      renderPlainLine(
        line,
        `line-${itemIndex}-${lineIndex}`,
        color,
        item.role === "user" && lineIndex === 0 ? "> " : undefined
      )
    );
  });

  if (inCode) {
    flushCode();
  }

  return (
    <Box key={`item-${itemIndex}`} flexDirection="column" marginBottom={1}>
      {nodes}
    </Box>
  );
};

const renderMetric = (label: string, value: string, accent?: "cyan" | "yellow" | "green") => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={accent ?? "gray"}
    paddingX={1}
    marginRight={1}
    marginBottom={1}
    minWidth={18}
  >
    <Text dimColor>{label}</Text>
    <Text bold color={accent ?? "white"}>
      {value}
    </Text>
  </Box>
);

const renderShellHeader = (
  status: ChatStatus,
  activeSessionId: string | null,
  currentModel: string,
  pendingCount: number,
  activePanel: string,
  spinner: string
) => (
  <Box
    marginBottom={SECTION_GAP}
    flexDirection="column"
    borderStyle="round"
    borderColor="cyan"
    paddingX={1}
    paddingY={1}
  >
    <Box justifyContent="space-between" flexWrap="wrap">
      <Box flexDirection="column">
        <Text bold color="cyan">
          {BRAND_NAME}
        </Text>
        <Text dimColor>coding console · review-aware shell</Text>
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <Text color="black" backgroundColor={status === "streaming" ? "yellow" : "green"}>
          {` ${status === "streaming" ? `${spinner} WORKING` : "READY"} `}
        </Text>
        <Text dimColor>{`panel ${activePanel} | approvals ${pendingCount}`}</Text>
      </Box>
    </Box>
    <Box marginTop={1} flexWrap="wrap">
      {renderMetric("Session", shortenValue(activeSessionId ?? "none", 26), "cyan")}
      {renderMetric("Model", shortenValue(currentModel || "none", 26))}
      {renderMetric("Panel", activePanel, activePanel === "idle" ? "green" : "yellow")}
      {renderMetric("Queue", String(pendingCount), pendingCount > 0 ? "yellow" : "green")}
    </Box>
  </Box>
);

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
    <Box justifyContent="space-between" flexWrap="wrap">
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>
        {`page ${page.currentPage}/${page.totalPages}  total ${page.total}`}
      </Text>
    </Box>
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
  if (action === "run_command") {
    return { border: "red", badgeBg: "red", badgeFg: "black" } as const;
  }
  if (action === "delete_file") {
    return { border: "red", badgeBg: "red", badgeFg: "black" } as const;
  }
  if (action === "edit_file") {
    return { border: "yellow", badgeBg: "yellow", badgeFg: "black" } as const;
  }
  if (action === "create_file" || action === "write_file" || action === "create_dir") {
    return { border: "cyan", badgeBg: "cyan", badgeFg: "black" } as const;
  }
  return { border: "gray", badgeBg: "gray", badgeFg: "white" } as const;
};

const renderApprovalLine = (line: string, index: number) => {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith("@@")) {
    return (
      <Box key={`approval-diff-${index}`}>
        {renderSegments(tokenizeCodeLine(line), `approval-token-${index}`)}
      </Box>
    );
  }

  if (line.trim().startsWith("[") && line.trim().endsWith("]")) {
    return (
      <Text key={`approval-label-${index}`} color="cyan" bold>
        {line}
      </Text>
    );
  }

  return (
    <Text key={`approval-line-${index}`} color="white">
      {line || " "}
    </Text>
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
  const blockedReason = approvalPanel.blockedReason?.trim() ?? "";
  const previewSource =
    approvalPanel.previewMode === "full"
      ? selectedPending.previewFull
      : selectedPending.previewSummary;
  const previewWindow = getPreviewWindow(previewSource, approvalPanel.previewOffset);
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
          {`focus ${approvalPanel.selectedIndex + 1}/${pendingReviews.length}  |  ${approvalPanel.previewMode}  |  ${selectedBlocked ? "blocked" : "ready"}  |  session ${shortenValue(activeSessionId ?? "none", 12)}  |  model ${shortenValue(currentModel, 12)}`}
        </Text>
      </Box>

      <Text dimColor>
        {`current ${selectedPending.id}  |  ${selectedPending.request.action}  |  ${selectedPending.request.path}`}
      </Text>
      <Text dimColor>{selectedPending.createdAt}</Text>
      {selectedBlocked ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">
            {`Last error: ${shortenValue(blockedReason || "approval failed", 120)}`}
          </Text>
          <Text dimColor>
            approve blocked for current item  |  ↑/↓ switch  |  r/d reject  |  a retry after cooldown
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} marginBottom={1} flexDirection="column">
        {queueItems.map((item, localIndex) => {
          const index = queueStart + localIndex;
          const selected = index === approvalPanel.selectedIndex;
          const tone = getActionTone(item.request.action);
          const blocked = approvalPanel.blockedItemId === item.id;
          return (
            <Text key={`review-list-${item.id}`} color={selected ? "white" : "gray"}>
              <Text color={selected ? "black" : tone.badgeBg} backgroundColor={selected ? "white" : undefined}>
                {selected ? "▶" : " "}
              </Text>
              <Text> </Text>
              <Text color={tone.badgeFg} backgroundColor={tone.badgeBg}>
                {` ${item.request.action} `}
              </Text>
              <Text> </Text>
              {shortenValue(item.request.path, 72)}
              {blocked ? (
                <>
                  <Text> </Text>
                  <Text color="black" backgroundColor="red">
                    {" blocked "}
                  </Text>
                </>
              ) : null}
            </Text>
          );
        })}
      </Box>

      <Text color="cyan">
        {`Preview  ${previewWindow.safeOffset + 1}-${Math.min(
          previewWindow.safeOffset + previewWindow.pageLines.length,
          previewWindow.totalLines
        )}/${previewWindow.totalLines}`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {previewWindow.pageLines.map((line, index) => renderApprovalLine(line, index))}
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

export const ChatScreen = ({
  items,
  status,
  input,
  resumePicker,
  sessionsPanel,
  modelPicker,
  pendingReviews,
  approvalPanel,
  activeSessionId,
  currentModel,
  onInputChange,
  onSubmit,
}: ChatScreenProps) => {
  const [spinnerIndex, setSpinnerIndex] = React.useState(0);
  const approvalModeActive = approvalPanel.active;

  React.useEffect(() => {
    if (status !== "streaming" || approvalModeActive) {
      setSpinnerIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerIndex(previous => (previous + 1) % SPINNER_FRAMES.length);
    }, 120);
    return () => clearInterval(timer);
  }, [approvalModeActive, status]);

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

  const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] || "·";

  if (approvalModeActive) {
    return (
      <Box flexDirection="column">
        {renderApprovalPanel(
          pendingReviews,
          approvalPanel,
          currentModel,
          activeSessionId
        )}

        <Box
          flexShrink={0}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          paddingY={1}
        >
          {renderSubtleHeader("Input", "approval panel active")}
          <Box marginTop={1}>
            <Text color="yellow">Review mode         </Text>
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
        pendingReviews.length,
        activePanel,
        spinner
      )}

      <Box
        marginBottom={SECTION_GAP}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        paddingY={1}
      >
        {renderSubtleHeader(
          "Conversation",
          `${items.length} items  |  ${isPanelActive ? "panel focus" : "free input"}`
        )}
        <Box marginTop={1} flexDirection="column">
          {transcriptNodes}
        </Box>
      </Box>

      {sessionsPanel.active &&
        renderSimplePanel(
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
            return renderPickerItem(session.id, meta, selected, isCurrent ? "current" : undefined);
          }),
          "Up/Down: select  Left/Right: page  Enter: resume  Esc: close"
        )}

      {resumePicker.active &&
        renderSimplePanel(
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
            return renderPickerItem(session.id, meta, selected, isCurrent ? "current" : undefined);
          }),
          "Up/Down: select  Left/Right: page  Enter: resume  Esc: close"
        )}

      {modelPicker.active &&
        renderSimplePanel(
          "Models",
          modelPage,
          activeSessionId,
          currentModel,
          currentModel,
          modelPage.pageItems.map((model, localIndex) => {
            const index = modelPage.pageStart + localIndex;
            const selected = index === modelPicker.selectedIndex;
            return renderPickerItem(model, model === currentModel ? "currently active" : "", selected, model === currentModel ? "current" : undefined);
          }),
          "Up/Down: select  Left/Right: page  Enter: switch  Esc: close"
        )}

      {pendingReviews.length > 0 && (
        <Box
          marginBottom={SECTION_GAP}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          paddingY={1}
        >
          {renderSubtleHeader(
            "Approval Queue",
            `${pendingReviews.length} pending  |  focus ${Math.min(
              approvalPanel.selectedIndex + 1,
              pendingReviews.length
            )}/${pendingReviews.length}`
          )}
          <Text dimColor>
            {pendingReviews[approvalPanel.selectedIndex]
              ? `${pendingReviews[approvalPanel.selectedIndex]?.request.action}  |  ${pendingReviews[approvalPanel.selectedIndex]?.request.path}`
              : "no active review"}
          </Text>
        </Box>
      )}

      {approvalPanel.active
        ? renderApprovalPanel(
            pendingReviews,
            approvalPanel,
            currentModel,
            activeSessionId
          )
        : null}

      <Box
        flexShrink={0}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        paddingY={1}
      >
        {renderSubtleHeader(
          "Input",
          isPanelActive ? "panel lock active" : "type and press Enter"
        )}
        <Box marginTop={1}>
          <Text color={status === "streaming" ? "yellow" : "green"}>
            {`${status === "streaming" ? `${spinner} Thinking` : "Ready"}`.padEnd(18, " ")}
          </Text>
          <TextInput
            value={input}
            focus={!isPanelActive}
            onChange={onInputChange}
            onSubmit={onSubmit}
            placeholder={isPanelActive ? "Panel active..." : "Ask something..."}
          />
        </Box>
      </Box>
    </Box>
  );
};
