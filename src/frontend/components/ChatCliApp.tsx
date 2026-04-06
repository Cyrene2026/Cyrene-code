import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp, useInput } from "ink";
import type { QueryTransport } from "../../core/query/transport";
import type { SessionStore } from "../../core/session/store";
import type { FileMcpService } from "../../core/tools/mcp/fileMcpService";
import { useChatApp } from "../../application/chat/useChatApp";
import { ChatScreen } from "./ChatScreen";
import { createExitHandler, type ExitSummarySnapshot } from "./exitSummary";
import type { AuthRuntime } from "../../infra/auth/authRuntime";
import type { AuthStatus } from "../../infra/auth/types";

type ChatCliAppProps = {
  transport: QueryTransport;
  initialAuthStatus: AuthStatus;
  authRuntime: AuthRuntime;
  sessionStore: SessionStore;
  defaultSystemPrompt: string;
  projectPrompt: string;
  pinMaxCount: number;
  autoSummaryRefresh: boolean;
  queryMaxToolSteps?: number;
  mcpService: FileMcpService;
  appRoot: string;
};

export const ChatCliApp = ({
  transport,
  initialAuthStatus,
  authRuntime,
  sessionStore,
  defaultSystemPrompt,
  projectPrompt,
  pinMaxCount,
  autoSummaryRefresh,
  queryMaxToolSteps,
  mcpService,
  appRoot,
}: ChatCliAppProps) => {
  const { exit } = useApp();
  const [runtimeTransport, setRuntimeTransport] = useState<QueryTransport>(transport);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(initialAuthStatus);
  const exitSnapshotRef = useRef<ExitSummarySnapshot>({
    startedAt: new Date().toISOString(),
    activeSessionId: null,
    currentModel: runtimeTransport.getModel(),
    requestCount: 0,
    stateUpdateCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
  const authController = useMemo(
    () => ({
      status: authStatus,
      getStatus: async () => {
        const nextStatus = await authRuntime.getStatus();
        setAuthStatus(nextStatus);
        return nextStatus;
      },
      saveLogin: async (input: {
        providerBaseUrl: string;
        apiKey: string;
        model?: string;
      }) => {
        const result = await authRuntime.saveLogin(input);
        setRuntimeTransport(result.transport);
        setAuthStatus(result.status);
        return {
          ok: result.ok,
          message: result.message,
          status: result.status,
        };
      },
      logout: async () => {
        const result = await authRuntime.logout();
        setRuntimeTransport(result.transport);
        setAuthStatus(result.status);
        return {
          ok: result.ok,
          message: result.message,
          status: result.status,
        };
      },
    }),
    [authRuntime, authStatus]
  );
  const {
    items,
    liveAssistantText,
    input,
    inputCursorOffset,
    inputCommandState,
    shellSession,
    status,
    resumePicker,
    sessionsPanel,
    modelPicker,
    providerPicker,
    pendingReviews,
    approvalPanel,
    authPanel,
    activeSessionId,
    currentModel,
    currentProvider,
    exitSummary,
    usage,
    setInput,
    submit,
  } = useChatApp({
    transport: runtimeTransport,
    sessionStore,
    defaultSystemPrompt,
    projectPrompt,
    pinMaxCount,
    queryMaxToolSteps,
    mcpService,
    autoSummaryRefresh,
    auth: authController,
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
          confirmBeforeExit: true,
          confirmTimeoutMs: 10_000,
          forceExit: () => {
            process.exit(0);
          },
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
      inputCursorOffset={inputCursorOffset}
      inputCommandState={inputCommandState}
      shellSession={shellSession}
      status={status}
      resumePicker={resumePicker}
      sessionsPanel={sessionsPanel}
      modelPicker={modelPicker}
      providerPicker={providerPicker}
      pendingReviews={pendingReviews}
      approvalPanel={approvalPanel}
      authPanel={authPanel}
      authStatus={authStatus}
      activeSessionId={activeSessionId}
      currentModel={currentModel}
      currentProvider={currentProvider}
      usage={usage}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
