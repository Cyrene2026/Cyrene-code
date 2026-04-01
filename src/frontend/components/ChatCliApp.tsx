import React from "react";
import type { QueryTransport } from "../../core/query/transport";
import type { SessionStore } from "../../core/session/store";
import { useChatApp } from "../../application/chat/useChatApp";
import { ChatScreen } from "./ChatScreen";

type ChatCliAppProps = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
};

export const ChatCliApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
}: ChatCliAppProps) => {
  const { items, input, status, setInput, submit } = useChatApp({
    transport,
    sessionStore,
    defaultSystemPrompt,
    projectPrompt,
    pinMaxCount,
  });

  return (
    <ChatScreen
      items={items}
      input={input}
      status={status}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
