import type {
  ProviderProfile,
  ProviderProfileOverrideMap,
  ProviderRuntimeInfo,
  QueryTransport,
} from "../../core/query/transport";
import type { ChatItem } from "../../shared/types/chat";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;
type ProviderProfileSource = "manual" | "inferred" | "local" | "none";

type HandleProviderModelCommandParams = {
  query: string;
  transport: QueryTransport;
  currentProviderKeySource: string;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
  enqueueTask: (task: () => Promise<void> | void) => void;
  isRepeatedActionInteraction: (id: string) => boolean;
  updateCurrentProviderState: (provider: string) => void;
  updateCurrentModelState: (model: string) => void;
  syncAuthSelection?: (input?: {
    providerBaseUrl?: string;
    model?: string;
  }) => Promise<void> | void;
  resolveProviderKeySource: (provider: string) => string;
  listManualProviderProfileOverrides: () => ProviderProfileOverrideMap;
  resolveProviderProfile: (provider: string) => ProviderRuntimeInfo["vendor"];
  resolveProviderProfileSource: (
    provider: string,
    manualOverrides?: ProviderProfileOverrideMap
  ) => ProviderProfileSource;
  openProviderPicker: (options: {
    providers: string[];
    selectedIndex: number;
    currentKeySource: string;
    providerProfiles: Record<string, ProviderRuntimeInfo["vendor"]>;
    providerProfileSources: Record<string, ProviderProfileSource>;
  }) => void;
  openModelPicker: (options: {
    models: string[];
    selectedIndex: number;
  }) => void;
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

const PROVIDER_PROFILE_USAGE =
  "Usage: /provider profile <openai|gemini|anthropic|custom> [url] | /provider profile clear [url] | /provider profile list";

export const handleProviderModelCommand = ({
  query,
  transport,
  currentProviderKeySource,
  pushSystemMessage,
  clearInput,
  enqueueTask,
  isRepeatedActionInteraction,
  updateCurrentProviderState,
  updateCurrentModelState,
  syncAuthSelection,
  resolveProviderKeySource,
  listManualProviderProfileOverrides,
  resolveProviderProfile,
  resolveProviderProfileSource,
  openProviderPicker,
  openModelPicker,
}: HandleProviderModelCommandParams) => {
  if (query === "/provider") {
    enqueueTask(async () => {
      const providers = await transport.listProviders();
      updateCurrentProviderState(transport.getProvider());
      if (providers.length === 0) {
        pushSystemMessage(
          "No providers available. Set CYRENE_BASE_URL or switch with /provider <url|openai|gemini|anthropic>."
        );
        return;
      }
      const current = transport.getProvider();
      const selectedIndex = Math.max(0, providers.indexOf(current));
      const keySource = currentProviderKeySource || resolveProviderKeySource(current);
      const manualOverrides = listManualProviderProfileOverrides();
      const providerProfiles = Object.fromEntries(
        providers.map(provider => [provider, resolveProviderProfile(provider)])
      ) as Record<string, ProviderRuntimeInfo["vendor"]>;
      const providerProfileSources = Object.fromEntries(
        providers.map(provider => [
          provider,
          resolveProviderProfileSource(provider, manualOverrides),
        ])
      ) as Record<string, ProviderProfileSource>;
      openProviderPicker({
        providers,
        selectedIndex,
        currentKeySource: keySource,
        providerProfiles,
        providerProfileSources,
      });
    });
    clearInput();
    return true;
  }

  if (query.startsWith("/provider profile")) {
    enqueueTask(async () => {
      if (!transport.setProviderProfile) {
        pushSystemMessage(
          "Provider profile override is unavailable in this transport.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      if (query === "/provider profile list") {
        const overrides = transport.listProviderProfiles?.() ?? {};
        const lines = Object.entries(overrides)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([provider, profile]) => `- ${provider} => ${profile}`);
        pushSystemMessage(
          lines.length > 0
            ? ["Manual provider profile overrides:", ...lines].join("\n")
            : "No manual provider profile overrides."
        );
        return;
      }

      if (query === "/provider profile") {
        pushSystemMessage(PROVIDER_PROFILE_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }

      const rawArgs = query
        .slice("/provider profile".length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (rawArgs.length === 0) {
        pushSystemMessage(PROVIDER_PROFILE_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }

      const profileToken = rawArgs[0]?.toLowerCase();
      let normalizedProfile: ProviderProfile | null = null;
      if (profileToken === "clear") {
        normalizedProfile = "custom";
      } else if (
        profileToken === "openai" ||
        profileToken === "gemini" ||
        profileToken === "anthropic" ||
        profileToken === "custom"
      ) {
        normalizedProfile = profileToken;
      }
      if (!normalizedProfile) {
        pushSystemMessage(
          "Profile must be one of: openai, gemini, anthropic, custom (or clear).",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      const targetProvider =
        rawArgs.slice(1).join(" ").trim() || transport.getProvider();
      if (!targetProvider || targetProvider === "none") {
        pushSystemMessage(
          "No active provider. Use /provider <url> first, or pass [url] explicitly.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      if (
        isRepeatedActionInteraction(
          `command:provider-profile:${targetProvider}:${normalizedProfile}`
        )
      ) {
        return;
      }

      const result = await transport.setProviderProfile(
        targetProvider,
        normalizedProfile
      );
      updateCurrentProviderState(transport.getProvider());
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        await syncAuthSelection?.({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
      }
      if (result.ok) {
        pushSystemMessage(result.message, INFO_MESSAGE_OPTIONS);
      } else {
        pushSystemMessage(
          `[provider profile failed] ${result.message}`,
          ERROR_MESSAGE_OPTIONS
        );
      }
    });
    clearInput();
    return true;
  }

  if (query === "/provider refresh") {
    enqueueTask(async () => {
      const result = await transport.refreshModels();
      updateCurrentProviderState(transport.getProvider());
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        await syncAuthSelection?.({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
      }
      if (result.ok) {
        pushSystemMessage(
          `${result.message}\nProvider: ${transport.getProvider()}\nCurrent model: ${transport.getModel()}`
        );
      } else {
        pushSystemMessage(`[provider refresh failed] ${result.message}`);
      }
    });
    clearInput();
    return true;
  }

  if (query.startsWith("/provider ")) {
    const nextProvider = query.slice("/provider ".length).trim();
    enqueueTask(async () => {
      if (!nextProvider) {
        pushSystemMessage(
          "Usage: /provider <base_url|openai|gemini|anthropic> | /provider refresh | /provider profile ..."
        );
        return;
      }
      if (isRepeatedActionInteraction(`command:provider:${nextProvider}`)) {
        return;
      }
      const result = await transport.setProvider(nextProvider);
      updateCurrentProviderState(transport.getProvider());
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        await syncAuthSelection?.({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
      }
      if (result.ok) {
        pushSystemMessage(result.message);
      } else {
        pushSystemMessage(`[provider switch failed] ${result.message}`);
      }
    });
    clearInput();
    return true;
  }

  if (query === "/model") {
    enqueueTask(async () => {
      const models = await transport.listModels();
      updateCurrentModelState(transport.getModel());
      if (models.length === 0) {
        pushSystemMessage("No models available. Try /model refresh.");
        return;
      }
      const current = transport.getModel();
      openModelPicker({
        models,
        selectedIndex: Math.max(0, models.indexOf(current)),
      });
    });
    clearInput();
    return true;
  }

  if (query === "/model refresh") {
    enqueueTask(async () => {
      const result = await transport.refreshModels();
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        await syncAuthSelection?.({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
      }
      if (result.ok) {
        pushSystemMessage(
          `${result.message}\nCurrent model: ${transport.getModel()}`
        );
      } else {
        pushSystemMessage(`[model refresh failed] ${result.message}`);
      }
    });
    clearInput();
    return true;
  }

  if (query.startsWith("/model ")) {
    const nextModel = query.slice("/model ".length).trim();
    enqueueTask(async () => {
      if (!nextModel) {
        pushSystemMessage("Usage: /model <model_name>");
        return;
      }
      if (isRepeatedActionInteraction(`command:model:${nextModel}`)) {
        return;
      }
      const result = await transport.setModel(nextModel);
      updateCurrentModelState(transport.getModel());
      if (result.ok) {
        await syncAuthSelection?.({
          providerBaseUrl: transport.getProvider(),
          model: transport.getModel(),
        });
      }
      if (result.ok) {
        pushSystemMessage(result.message);
      } else {
        pushSystemMessage(`[model switch failed] ${result.message}`);
      }
    });
    clearInput();
    return true;
  }

  return false;
};
