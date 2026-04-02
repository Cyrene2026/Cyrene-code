import React from "react";
import { Box, Static, Text } from "ink";
import TextInput from "ink-text-input";
import type { SessionListItem } from "../../core/session/types";
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
  onInputChange: (next: string) => void;
  onSubmit: () => void;
};

const renderCodeTokens = (line: string, language?: string) => {
  const chunks: React.ReactNode[] = [];
  const tokenPattern =
    /(#.*$|\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:def|class|return|if|elif|else|for|while|in|import|from|async|await|try|except|finally|with|as|const|let|var|function|export|type|interface|extends|implements|new|throw)\b)/g;
  let lastIndex = 0;

  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      chunks.push(line.slice(lastIndex, index));
    }

    let color: "green" | "yellow" | "cyan" = "cyan";
    if (token.startsWith("#") || token.startsWith("//")) {
      color = "green";
    } else if (token.startsWith("\"") || token.startsWith("'")) {
      color = "yellow";
    }

    chunks.push(
      <Text key={`${language ?? "plain"}-${index}`} color={color}>
        {token}
      </Text>
    );
    lastIndex = index + token.length;
  }

  if (lastIndex < line.length) {
    chunks.push(line.slice(lastIndex));
  }

  return chunks.length > 0 ? chunks : line;
};

const renderTranscriptItem = (item: ChatItem, itemIndex: number) => {
  const nodes: React.ReactNode[] = [];
  const lines = item.text.split("\n");
  let inCodeBlock = false;
  let codeLanguage = "";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const key = `${item.role}-${itemIndex}-${lineIndex}`;
    const normalized = line.trimStart();
    const isFence = normalized.startsWith("```");

    if (isFence) {
      inCodeBlock = !inCodeBlock;
      codeLanguage = inCodeBlock ? normalized.slice(3).trim() : "";
      nodes.push(
        <Text key={key} color="cyan">
          {line}
        </Text>
      );
      continue;
    }

    const isAdd = normalized.startsWith("+ ") && normalized.includes(" | ");
    const isDel = normalized.startsWith("- ") && normalized.includes(" | ");
    const prefix = item.role === "user" && lineIndex === 0 ? "> " : "";
    const parts = normalized.match(/^([+-]\s+\d+\s+\|)(.*)$/);

    if (isAdd) {
      nodes.push(
        <Text key={key} color="white">
          {prefix}
          <Text color="green">{parts?.[1] ?? "+ |"}</Text>
          <Text color="white">
            {renderCodeTokens(parts?.[2] ?? normalized, codeLanguage || "python")}
          </Text>
        </Text>
      );
      continue;
    }

    if (isDel) {
      nodes.push(
        <Text key={key} color="white">
          {prefix}
          <Text color="red">{parts?.[1] ?? "- |"}</Text>
          <Text color="white">
            {renderCodeTokens(parts?.[2] ?? normalized, codeLanguage || "python")}
          </Text>
        </Text>
      );
      continue;
    }

    if (inCodeBlock) {
      nodes.push(
        <Text key={key} color="white">
          {renderCodeTokens(line, codeLanguage)}
        </Text>
      );
      continue;
    }

    nodes.push(
      <Text key={key} color={item.color ?? "white"}>
        {prefix}
        {line}
      </Text>
    );
  }

  return <Box key={`item-${itemIndex}`} flexDirection="column">{nodes}</Box>;
};

const TranscriptView = React.memo(
  ({ historyItems, activeItem }: { historyItems: ChatItem[]; activeItem?: ChatItem }) => (
    <Box marginBottom={1} flexDirection="column">
      <Static items={historyItems}>
        {(item, index) => renderTranscriptItem(item, index)}
      </Static>
      {activeItem ? renderTranscriptItem(activeItem, historyItems.length) : null}
    </Box>
  )
);

TranscriptView.displayName = "TranscriptView";

export const ChatScreen = ({
  items,
  status,
  input,
  resumePicker,
  modelPicker,
  onInputChange,
  onSubmit,
}: ChatScreenProps) => {
  const historyItems = items.slice(0, -1);
  const activeItem = items.at(-1);
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

  return (
    <Box flexDirection="column">
      <TranscriptView historyItems={historyItems} activeItem={activeItem} />
      {resumePicker.active && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan">
            Resume Sessions (Page {currentPage}/{totalPages})
          </Text>
          {pageSessions.map((session, localIndex) => {
            const index = pageStart + localIndex;
            return (
            <Text key={session.id} color={index === resumePicker.selectedIndex ? "green" : undefined}>
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
      <Box flexShrink={0}>
        <Text color={status === "streaming" ? "yellow" : "green"}>
          {(status === "streaming" ? "streaming" : "ready").padEnd(10, " ")}
        </Text>
        <TextInput
          value={input}
          onChange={onInputChange}
          onSubmit={onSubmit}
          placeholder="Ask something..."
        />
      </Box>
    </Box>
  );
};
