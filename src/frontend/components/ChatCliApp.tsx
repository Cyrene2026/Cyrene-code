import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp, useInput } from "ink";
import type { McpRuntime } from "../../core/mcp";
import type { SkillsRuntime } from "../../core/skills";
import type { QueryTransport } from "../../core/query/transport";
import type { SessionStore } from "../../core/session/store";
import { useChatApp } from "../../application/chat/useChatApp";
import { resolveComposerKeymap } from "../../application/chat/composerKeymap";
import { ChatScreen } from "./ChatScreen";
import { createExitHandler, type ExitSummarySnapshot } from "./exitSummary";
import { createAuthRuntime, type AuthRuntime } from "../../infra/auth/authRuntime";
import type { AuthStatus } from "../../infra/auth/types";
import { loadCyreneConfig } from "../../infra/config/loadCyreneConfig";
import { loadPromptPolicy } from "../../infra/config/loadPromptPolicy";
import { createMcpRuntime } from "../../core/mcp";
import { createSkillsRuntime } from "../../core/skills";
import { setConfiguredAppRoot } from "../../infra/config/appRoot";
import { resolve } from "node:path";

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
  mcpService: McpRuntime;
  skillsService?: SkillsRuntime;
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
  skillsService,
  appRoot,
}: ChatCliAppProps) => {
  const { exit } = useApp();
  const composerKeymap = useMemo(() => resolveComposerKeymap(process.env), []);
  const [runtimeAppRoot, setRuntimeAppRoot] = useState(appRoot);
  const [runtimeDefaultSystemPrompt, setRuntimeDefaultSystemPrompt] =
    useState(defaultSystemPrompt);
  const [runtimeProjectPrompt, setRuntimeProjectPrompt] = useState(projectPrompt);
  const [runtimePinMaxCount, setRuntimePinMaxCount] = useState(pinMaxCount);
  const [runtimeAutoSummaryRefresh, setRuntimeAutoSummaryRefresh] =
    useState(autoSummaryRefresh);
  const [runtimeQueryMaxToolSteps, setRuntimeQueryMaxToolSteps] =
    useState(queryMaxToolSteps);
  const [runtimeMcpService, setRuntimeMcpService] = useState<McpRuntime>(mcpService);
  const [runtimeSkillsService, setRuntimeSkillsService] =
    useState<SkillsRuntime | undefined>(skillsService);
  const [runtimeAuthRuntime, setRuntimeAuthRuntime] =
    useState<AuthRuntime>(authRuntime);
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
        const nextStatus = await runtimeAuthRuntime.getStatus();
        setAuthStatus(nextStatus);
        return nextStatus;
      },
      saveLogin: async (input: {
        providerBaseUrl: string;
        apiKey: string;
        model?: string;
      }) => {
        const result = await runtimeAuthRuntime.saveLogin(input);
        setRuntimeTransport(result.transport);
        setAuthStatus(result.status);
        return {
          ok: result.ok,
          message: result.message,
          status: result.status,
        };
      },
      logout: async () => {
        const result = await runtimeAuthRuntime.logout();
        setRuntimeTransport(result.transport);
        setAuthStatus(result.status);
        return {
          ok: result.ok,
          message: result.message,
          status: result.status,
        };
      },
    }),
    [authStatus, runtimeAuthRuntime]
  );
  const switchWorkspace = async (nextProjectRoot: string | null) => {
    if (!nextProjectRoot) {
      return;
    }

    const normalizedProjectRoot = resolve(nextProjectRoot);
    if (normalizedProjectRoot === runtimeAppRoot) {
      return;
    }

    const nextConfig = await loadCyreneConfig(normalizedProjectRoot);
    const nextPromptPolicy = await loadPromptPolicy(nextConfig, normalizedProjectRoot);
    const nextAuthRuntime = createAuthRuntime({
      appRoot: normalizedProjectRoot,
      requestTemperature: nextConfig.requestTemperature,
    });
    const [nextAuthStatus, nextTransport, nextMcpService, nextSkillsService] =
      await Promise.all([
        nextAuthRuntime.getStatus(),
        nextAuthRuntime.buildTransport(),
        createMcpRuntime(normalizedProjectRoot),
        createSkillsRuntime(normalizedProjectRoot),
      ]);

    process.chdir(normalizedProjectRoot);
    setConfiguredAppRoot(normalizedProjectRoot);

    setRuntimeAppRoot(normalizedProjectRoot);
    setRuntimeDefaultSystemPrompt(nextPromptPolicy.systemPrompt);
    setRuntimeProjectPrompt(nextPromptPolicy.projectPrompt);
    setRuntimePinMaxCount(nextConfig.pinMaxCount);
    setRuntimeAutoSummaryRefresh(nextConfig.autoSummaryRefresh);
    setRuntimeQueryMaxToolSteps(nextConfig.queryMaxToolSteps);
    setRuntimeAuthRuntime(nextAuthRuntime);
    setRuntimeTransport(nextTransport);
    setAuthStatus(nextAuthStatus);
    setRuntimeMcpService(nextMcpService);
    setRuntimeSkillsService(nextSkillsService);
  };
  const {
    items,
    liveAssistantText,
    recentLocalCommand,
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
    defaultSystemPrompt: runtimeDefaultSystemPrompt,
    projectPrompt: runtimeProjectPrompt,
    pinMaxCount: runtimePinMaxCount,
    queryMaxToolSteps: runtimeQueryMaxToolSteps,
    mcpService: runtimeMcpService,
    skillsService: runtimeSkillsService,
    autoSummaryRefresh: runtimeAutoSummaryRefresh,
    composerKeymap,
    onSessionProjectRootChange: switchWorkspace,
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
          runtimeMcpService.dispose();
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
    [exit, runtimeMcpService]
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
      runtimeMcpService.dispose();
    };
  }, [handleExit, runtimeMcpService]);

  return (
    <ChatScreen
      items={items}
      liveAssistantText={liveAssistantText}
      recentLocalCommand={recentLocalCommand}
      appRoot={runtimeAppRoot}
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
      composerKeymap={composerKeymap}
      activeSessionId={activeSessionId}
      currentModel={currentModel}
      currentProvider={currentProvider}
      usage={usage}
      onInputChange={setInput}
      onSubmit={submit}
    />
  );
};
