import type { AuthStatus } from "../../infra/auth/types";
import type { QueryTransport } from "../../core/query/transport";
import type { ChatItem } from "../../shared/types/chat";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;

type AuthRuntimeLike = {
  getStatus: () => Promise<AuthStatus>;
  getSavedApiKey?: (providerBaseUrl: string) => Promise<string | undefined>;
  logout: () => Promise<{
    ok: boolean;
    message: string;
    status: AuthStatus;
  }>;
} | null | undefined;

type HandleAuthCommandParams = {
  query: string;
  authRuntime: AuthRuntimeLike;
  transport: QueryTransport;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
  enqueueTask: (task: () => Promise<void> | void) => void;
  openManualLoginPanel: () => void;
  formatAuthStatusMessage: (
    status: AuthStatus,
    options?: { hasRememberedKey?: boolean }
  ) => string;
  isUsableHttpProvider: (provider: string) => boolean;
};

const ERROR_MESSAGE_OPTIONS = {
  kind: "error",
  tone: "danger",
  color: "red",
} satisfies SystemMessageOptions;

const INFO_MESSAGE_OPTIONS = {
  kind: "system_hint",
  tone: "info",
  color: "cyan",
} satisfies SystemMessageOptions;

export const handleAuthCommand = ({
  query,
  authRuntime,
  transport,
  pushSystemMessage,
  clearInput,
  enqueueTask,
  openManualLoginPanel,
  formatAuthStatusMessage,
  isUsableHttpProvider,
}: HandleAuthCommandParams) => {
  if (query === "/login") {
    if (!authRuntime) {
      pushSystemMessage(
        "Auth runtime unavailable. HTTP onboarding is not enabled in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    openManualLoginPanel();
    clearInput();
    return true;
  }

  if (query === "/logout") {
    enqueueTask(async () => {
      if (!authRuntime) {
        pushSystemMessage(
          "Auth runtime unavailable. Nothing to log out.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }
      const result = await authRuntime.logout();
      pushSystemMessage(result.message, {
        kind: "system_hint",
        tone:
          result.status.credentialSource === "process_env" ? "warning" : "info",
        color:
          result.status.credentialSource === "process_env" ? "yellow" : "cyan",
      });
    });
    clearInput();
    return true;
  }

  if (query === "/auth") {
    enqueueTask(async () => {
      const nextStatus = authRuntime
        ? await authRuntime.getStatus()
        : ({
            mode: transport.getProvider() === "local-core" ? "local" : "http",
            credentialSource: "none",
            provider: transport.getProvider(),
            model: transport.getModel(),
            persistenceTarget: null,
            onboardingAvailable: false,
            httpReady: transport.getProvider() !== "local-core",
          } as AuthStatus);
      const hasRememberedKey =
        authRuntime?.getSavedApiKey && isUsableHttpProvider(nextStatus.provider)
          ? Boolean(await authRuntime.getSavedApiKey(nextStatus.provider))
          : false;
      pushSystemMessage(
        formatAuthStatusMessage(nextStatus, { hasRememberedKey }),
        INFO_MESSAGE_OPTIONS
      );
    });
    clearInput();
    return true;
  }

  return false;
};
