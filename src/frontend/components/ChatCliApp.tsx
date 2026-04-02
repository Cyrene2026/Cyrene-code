import React from "react";
import type { QueryTransport } from "../../core/query/transport";
import type { SessionStore } from "../../core/session/store";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import { useChatApp } from "../../application/chat/useChatApp";
import { ChatScreen } from "./ChatScreen";

type ChatCliAppProps = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
  mcpService: FileMcpService;
};

export const ChatCliApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  mcpService,
}: ChatCliAppProps) => {
  const {
    items,
    input,
    status,
    resumePicker,
    modelPicker,
    pendingReviews,
    approvalPanel,
    setInput,
    submit,
  } = useChatApp({
    transport,
    sessionStore,
    defaultSystemPrompt,
    projectPrompt,
    pinMaxCount,
    mcpService,
  });

  return (
    <ChatScreen
      items={items}
      input={input}
      status={status}
      resumePicker={resumePicker}
      modelPicker={modelPicker}
      pendingReviews={pendingReviews}
      approvalPanel={approvalPanel}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
