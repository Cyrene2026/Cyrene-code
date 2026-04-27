import {
  isProviderEndpointKind,
  isProviderProfile,
  isProviderType,
  type ProviderEndpointKind,
  type ProviderProfile,
  type ProviderType,
  type ProviderProfileOverrideMap,
  type ProviderRuntimeInfo,
  type QueryTransport,
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
const PROVIDER_TYPE_USAGE =
  "Usage: /provider type <openai-compatible|openai-responses|gemini|anthropic> [url] | /provider type clear [url] | /provider type list";
const PROVIDER_ENDPOINT_USAGE =
  "Usage: /provider endpoint <responses|chat_completions|models|anthropic_messages|gemini_generate_content> <path|url> [provider] | /provider endpoint clear <kind> [provider] | /provider endpoint list";
const PROVIDER_NAME_USAGE =
  "Usage: /provider name <display_name> | /provider name clear [url] | /provider name list";
const MODEL_CUSTOM_USAGE = "Usage: /model custom <model_id>";

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
      } else if (profileToken && isProviderProfile(profileToken)) {
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

  if (query.startsWith("/provider type")) {
    enqueueTask(async () => {
      if (!transport.setProviderType) {
        pushSystemMessage(
          "Provider type override is unavailable in this transport.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      if (query === "/provider type list") {
        const overrides = transport.listProviderTypes?.() ?? {};
        const lines = Object.entries(overrides)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([provider, type]) => `- ${provider} => ${type}`);
        pushSystemMessage(
          lines.length > 0
            ? ["Manual provider type overrides:", ...lines].join("\n")
            : "No manual provider type overrides."
        );
        return;
      }

      if (query === "/provider type") {
        pushSystemMessage(PROVIDER_TYPE_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }

      const rawArgs = query
        .slice("/provider type".length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (rawArgs.length === 0) {
        pushSystemMessage(PROVIDER_TYPE_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }

      const typeToken = rawArgs[0]?.toLowerCase();
      const normalizedType =
        typeToken === "clear"
          ? null
          : typeToken && isProviderType(typeToken)
            ? typeToken
            : undefined;
      if (typeof normalizedType === "undefined") {
        pushSystemMessage(
          "Provider type must be one of: openai-compatible, openai-responses, gemini, anthropic (or clear).",
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
          `command:provider-type:${targetProvider}:${normalizedType ?? "clear"}`
        )
      ) {
        return;
      }

      const result = await transport.setProviderType(
        targetProvider,
        normalizedType
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
          `[provider type failed] ${result.message}`,
          ERROR_MESSAGE_OPTIONS
        );
      }
    });
    clearInput();
    return true;
  }

  if (query.startsWith("/provider name")) {
    enqueueTask(async () => {
      if (query === "/provider name list") {
        const overrides = transport.listProviderNames?.() ?? {};
        const lines = Object.entries(overrides)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([provider, name]) => `- ${provider} => ${name}`);
        pushSystemMessage(
          lines.length > 0
            ? ["Custom provider names:", ...lines].join("\n")
            : "No custom provider names."
        );
        return;
      }

      if (query === "/provider name") {
        pushSystemMessage(PROVIDER_NAME_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }

      if (query.startsWith("/provider name clear")) {
        if (!transport.setProviderName) {
          pushSystemMessage(
            "Provider naming is unavailable in this transport.",
            ERROR_MESSAGE_OPTIONS
          );
          return;
        }
        const targetProvider =
          query.slice("/provider name clear".length).trim() ||
          transport.getProvider();
        if (!targetProvider || targetProvider === "none") {
          pushSystemMessage(
            "No active provider. Use /provider <url> first, or pass [url] explicitly.",
            ERROR_MESSAGE_OPTIONS
          );
          return;
        }
        const result = await transport.setProviderName(targetProvider, null);
        pushSystemMessage(
          result.ok ? result.message : `[provider name failed] ${result.message}`,
          result.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      if (!transport.setProviderName) {
        pushSystemMessage(
          "Provider naming is unavailable in this transport.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }
      const displayName = query.slice("/provider name".length).trim();
      if (!displayName) {
        pushSystemMessage(PROVIDER_NAME_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }
      const targetProvider = transport.getProvider();
      if (!targetProvider || targetProvider === "none") {
        pushSystemMessage(
          "No active provider. Use /provider <url> first.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }
      const result = await transport.setProviderName(targetProvider, displayName);
      pushSystemMessage(
        result.ok ? result.message : `[provider name failed] ${result.message}`,
        result.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
      );
    });
    clearInput();
    return true;
  }

  if (query.startsWith("/provider endpoint")) {
    enqueueTask(async () => {
      if (!transport.setProviderEndpoint) {
        pushSystemMessage(
          "Provider endpoint override is unavailable in this transport.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      if (query === "/provider endpoint list") {
        const overrides = transport.listProviderEndpoints?.() ?? {};
        const lines = Object.entries(overrides)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([provider, endpoints]) =>
            Object.entries(endpoints ?? {})
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([kind, endpoint]) => `- ${provider} [${kind}] => ${endpoint}`)
          );
        pushSystemMessage(
          lines.length > 0
            ? ["Manual provider endpoint overrides:", ...lines].join("\n")
            : "No manual provider endpoint overrides."
        );
        return;
      }

      if (query === "/provider endpoint") {
        pushSystemMessage(PROVIDER_ENDPOINT_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }

      if (query.startsWith("/provider endpoint clear")) {
        const args = query
          .slice("/provider endpoint clear".length)
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const endpointKind = args[0]?.trim().toLowerCase();
        if (!endpointKind || !isProviderEndpointKind(endpointKind)) {
          pushSystemMessage(PROVIDER_ENDPOINT_USAGE, ERROR_MESSAGE_OPTIONS);
          return;
        }
        const targetProvider = args.slice(1).join(" ").trim() || transport.getProvider();
        if (!targetProvider || targetProvider === "none") {
          pushSystemMessage(
            "No active provider. Use /provider <url> first, or pass [provider] explicitly.",
            ERROR_MESSAGE_OPTIONS
          );
          return;
        }
        const result = await transport.setProviderEndpoint(
          targetProvider,
          endpointKind,
          null
        );
        pushSystemMessage(
          result.ok
            ? result.message
            : `[provider endpoint failed] ${result.message}`,
          result.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      const args = query.slice("/provider endpoint".length).trim().split(/\s+/).filter(Boolean);
      if (args.length < 2) {
        pushSystemMessage(PROVIDER_ENDPOINT_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }
      const endpointKind = args[0]?.trim().toLowerCase();
      const endpoint = args[1]?.trim();
      const targetProvider = args.slice(2).join(" ").trim() || transport.getProvider();
      if (!endpointKind || !isProviderEndpointKind(endpointKind) || !endpoint) {
        pushSystemMessage(PROVIDER_ENDPOINT_USAGE, ERROR_MESSAGE_OPTIONS);
        return;
      }
      if (!targetProvider || targetProvider === "none") {
        pushSystemMessage(
          "No active provider. Use /provider <url> first, or pass [provider] explicitly.",
          ERROR_MESSAGE_OPTIONS
        );
        return;
      }

      const result = await transport.setProviderEndpoint(
        targetProvider,
        endpointKind,
        endpoint
      );
      pushSystemMessage(
        result.ok
          ? result.message
          : `[provider endpoint failed] ${result.message}`,
        result.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
      );
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
          "Usage: /provider <base_url|openai|gemini|anthropic> | /provider refresh | /provider type ... | /provider profile ..."
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

  if (query === "/model custom" || query.startsWith("/model custom ")) {
    const nextModel = query.slice("/model custom".length).trim();
    enqueueTask(async () => {
      if (!nextModel) {
        pushSystemMessage(MODEL_CUSTOM_USAGE);
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
