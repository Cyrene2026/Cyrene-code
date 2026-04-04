import React, { useEffect, useMemo, useRef } from "react";
import { useApp, useInput } from "ink";
import type { QueryTransport } from "../../core/query/transport";
import type { SessionStore } from "../../core/session/store";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import { useChatApp } from "../../application/chat/useChatApp";
import { ChatScreen } from "./ChatScreen";
import { createExitHandler, type ExitSummarySnapshot } from "./exitSummary";

type ChatCliAppProps = {
  transport: QueryTransport;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
  queryMaxToolSteps?: number;
  mcpService: FileMcpService;
  appRoot: string;
};

export const ChatCliApp = ({
  transport,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  queryMaxToolSteps,
  mcpService,
  appRoot,
}: ChatCliAppProps) => {
  const { exit } = useApp();
  const exitSnapshotRef = useRef<ExitSummarySnapshot>({
    startedAt: new Date().toISOString(),
    activeSessionId: null,
    currentModel: transport.getModel(),
    requestCount: 0,
    summaryRequestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
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
    providerPicker,
    pendingReviews,
    approvalPanel,
    activeSessionId,
    currentModel,
    currentProvider,
    exitSummary,
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
    ...exitSummary,
  };

  const handleExit = useMemo(
    () =>
      createExitHandler(
        () => exitSnapshotRef.current,
        text => {
          process.stdout.write(text);
        },
        () => {
          mcpService.dispose();
          exit();
        },
        {
          ansi: process.stdout.isTTY !== false,
        }
      ),
    [exit, mcpService]
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
      mcpService.dispose();
    };
  }, [handleExit, mcpService]);

  return (
    <ChatScreen
      items={items}
      liveAssistantText={liveAssistantText}
      appRoot={appRoot}
      input={input}
      inputCommandState={inputCommandState}
      status={status}
      resumePicker={resumePicker}
      sessionsPanel={sessionsPanel}
      modelPicker={modelPicker}
      providerPicker={providerPicker}
      pendingReviews={pendingReviews}
      approvalPanel={approvalPanel}
      activeSessionId={activeSessionId}
      currentModel={currentModel}
      currentProvider={currentProvider}
      usage={usage}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
