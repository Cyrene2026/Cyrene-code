import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { ChatItem, ChatStatus } from "../../shared/types/chat";

type ChatScreenProps = {
  items: ChatItem[];
  status: ChatStatus;
  input: string;
  onInputChange: (next: string) => void;
  onSubmit: () => void;
};

export const ChatScreen = ({
  items,
  status,
  input,
  onInputChange,
  onSubmit,
}: ChatScreenProps) => {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        {items.map((item, index) => (
          <Text key={`${item.role}-${index}`}>
            {item.role === "user" ? "> " : ""}
            {item.text}
          </Text>
        ))}
      </Box>
      <Box>
        <Text color={status === "streaming" ? "yellow" : "green"}>
          {status === "streaming" ? "streaming" : "ready"}{" "}
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
