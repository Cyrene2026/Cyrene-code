import React, { useEffect, useMemo, useRef } from "react";
import { useApp, useInput } from "ink";
import type { QueryTransport } from "../../core/query/transport";
import type { SessionStore } from "../../core/session/store";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import { useChatApp } from "../../application/chat/useChatApp";
import { ChatScreen } from "./ChatScreen";
import { createExitHandler } from "./exitSummary";

type ChatCliAppProps = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
  queryMaxToolSteps?: number;
  mcpService: FileMcpService;
};

export const ChatCliApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  queryMaxToolSteps,
  mcpService,
}: ChatCliAppProps) => {
  const { exit } = useApp();
  const exitSnapshotRef = useRef<{
    sessionId: string | null;
    usage: ReturnType<typeof useChatApp>["usage"];
  }>({
    sessionId: null,
    usage: null,
  });
  const {
    items,
    liveAssistantText,
    input,
    inputCommandState,
    status,
    resumePicker,
    sessionsPanel,
    modelPicker,
    pendingReviews,
    approvalPanel,
    activeSessionId,
    currentModel,
    usage,
    setInput,
    submit,
  } = useChatApp({
    transport,
    sessionStore,
    defaultSystemPrompt,
    projectPrompt,
    pinMaxCount,
    queryMaxToolSteps,
    mcpService,
  });

  exitSnapshotRef.current = {
    sessionId: activeSessionId,
    usage,
  };

  const handleExit = useMemo(
    () =>
      createExitHandler(
        () => exitSnapshotRef.current,
        text => {
          process.stdout.write(text);
        },
        exit
      ),
    [exit]
  );

  useInput((inputValue, key) => {
    if (!key.ctrl || inputValue.toLowerCase() !== "c") {
      return;
    }
    handleExit();
  });

  useEffect(() => {
    process.on("SIGINT", handleExit);

    return () => {
      process.off("SIGINT", handleExit);
    };
  }, [handleExit]);

  return (
    <ChatScreen
      items={items}
      liveAssistantText={liveAssistantText}
      input={input}
      inputCommandState={inputCommandState}
      status={status}
      resumePicker={resumePicker}
      sessionsPanel={sessionsPanel}
      modelPicker={modelPicker}
      pendingReviews={pendingReviews}
      approvalPanel={approvalPanel}
      activeSessionId={activeSessionId}
      currentModel={currentModel}
      usage={usage}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
