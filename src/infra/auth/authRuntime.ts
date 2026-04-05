import { createHttpQueryTransport, fetchProviderModelCatalog, normalizeProviderBaseUrl } from "../http/createHttpQueryTransport";
import { createLocalCoreTransport } from "../local/createLocalCoreTransport";
import { loadModelYaml, saveModelYaml } from "../config/modelCatalog";
import { createUserScopedApiKeyStore, type UserScopedApiKeyStore } from "./userScopedApiKeyStore";
import type { QueryTransport } from "../../core/query/transport";
import type { AuthLoginInput, AuthStatus, AuthValidationResult } from "./types";

type LoadedProviderMetadata = {
  providerBaseUrl?: string;
  currentModel?: string;
  providers: string[];
};

type ResolvedAuthState = {
  status: AuthStatus;
  apiKey?: string;
  providerBaseUrl?: string;
  currentModel: string;
  persistedApiKey?: string;
  hasExplicitProcessKey: boolean;
};

type AuthRuntimeOptions = {
  appRoot: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTemperature?: number;
  apiKeyStore?: UserScopedApiKeyStore;
  createHttpTransport?: typeof createHttpQueryTransport;
  createLocalTransport?: typeof createLocalCoreTransport;
  loadModelYamlImpl?: typeof loadModelYaml;
  saveModelYamlImpl?: typeof saveModelYaml;
  fetchProviderModelCatalogImpl?: typeof fetchProviderModelCatalog;
};

export type AuthRuntimeMutationResult = {
  ok: boolean;
  message: string;
  status: AuthStatus;
  transport: QueryTransport;
};

export type AuthRuntime = {
  getStatus: () => Promise<AuthStatus>;
  validateLoginInput: (input: AuthLoginInput) => Promise<AuthValidationResult>;
  saveLogin: (input: AuthLoginInput) => Promise<AuthRuntimeMutationResult>;
  logout: () => Promise<AuthRuntimeMutationResult>;
  buildTransport: () => Promise<QueryTransport>;
};

const trimNonEmpty = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const formatPersistenceTarget = (status: AuthStatus) =>
  status.persistenceTarget
    ? `${status.persistenceTarget.label} (${status.persistenceTarget.path})`
    : "unavailable";

const buildStatus = (
  source: AuthStatus["credentialSource"],
  providerBaseUrl: string | undefined,
  currentModel: string,
  apiKey: string | undefined,
  persistenceTarget: AuthStatus["persistenceTarget"]
): AuthStatus => {
  const httpReady = Boolean(apiKey && providerBaseUrl);
  return {
    mode: httpReady ? "http" : "local",
    credentialSource: source,
    provider: providerBaseUrl ?? "none",
    model: currentModel || "gpt-4o-mini",
    persistenceTarget,
    onboardingAvailable: true,
    httpReady,
  };
};

export const createAuthRuntime = (
  options: AuthRuntimeOptions
): AuthRuntime => {
  const effectiveEnv = options.env ?? process.env;
  const requestTemperature =
    typeof options.requestTemperature === "number" &&
    Number.isFinite(options.requestTemperature)
      ? Math.min(2, Math.max(0, options.requestTemperature))
      : 0.2;
  const apiKeyStore =
    options.apiKeyStore ??
    createUserScopedApiKeyStore({
      env: effectiveEnv,
    });
  const createHttpTransport =
    options.createHttpTransport ?? createHttpQueryTransport;
  const createLocalTransport =
    options.createLocalTransport ?? createLocalCoreTransport;
  const loadModelYamlImpl = options.loadModelYamlImpl ?? loadModelYaml;
  const saveModelYamlImpl = options.saveModelYamlImpl ?? saveModelYaml;
  const fetchProviderModelCatalogImpl =
    options.fetchProviderModelCatalogImpl ?? fetchProviderModelCatalog;

  let ownsProcessApiKey = false;

  const loadProviderMetadata = async (): Promise<LoadedProviderMetadata> => {
    try {
      const loaded = await loadModelYamlImpl(options.appRoot, {
        cwd: options.cwd,
        env: effectiveEnv,
      });
      return {
        providerBaseUrl: normalizeProviderBaseUrl(
          trimNonEmpty(loaded.providerBaseUrl) ?? ""
        ),
        currentModel:
          trimNonEmpty(
            loaded.lastUsedModel ?? loaded.defaultModel ?? loaded.models[0]
          ) ?? "gpt-4o-mini",
        providers: Array.from(
          new Set(
            [
              ...loaded.providers,
              trimNonEmpty(loaded.providerBaseUrl),
            ].filter(Boolean)
          )
        ) as string[],
      };
    } catch {
      return {
        providerBaseUrl: undefined,
        currentModel: trimNonEmpty(effectiveEnv.CYRENE_MODEL) ?? "gpt-4o-mini",
        providers: [],
      };
    }
  };

  const resolveEffectiveAuth = async (): Promise<ResolvedAuthState> => {
    const persistenceTarget = await apiKeyStore.getTarget();
    const metadata = await loadProviderMetadata();
    const processApiKey = trimNonEmpty(effectiveEnv.CYRENE_API_KEY);
    const persistedApiKey = trimNonEmpty(await apiKeyStore.read());
    const processProviderBaseUrl = trimNonEmpty(effectiveEnv.CYRENE_BASE_URL);
    const processModel = trimNonEmpty(effectiveEnv.CYRENE_MODEL);
    const providerBaseUrl =
      processProviderBaseUrl ??
      trimNonEmpty(metadata.providerBaseUrl);
    const currentModel =
      processModel ??
      trimNonEmpty(metadata.currentModel) ??
      "gpt-4o-mini";

    let credentialSource: AuthStatus["credentialSource"] = "none";
    let apiKey: string | undefined;
    let hasExplicitProcessKey = false;

    if (processApiKey) {
      if (persistedApiKey && processApiKey === persistedApiKey) {
        credentialSource = "user_env";
      } else {
        credentialSource = "process_env";
        hasExplicitProcessKey = true;
      }
      apiKey = processApiKey;
    } else if (persistedApiKey) {
      credentialSource = "user_env";
      apiKey = persistedApiKey;
    }

    return {
      status: buildStatus(
        credentialSource,
        providerBaseUrl,
        currentModel,
        apiKey,
        persistenceTarget
      ),
      apiKey,
      providerBaseUrl,
      currentModel,
      persistedApiKey,
      hasExplicitProcessKey,
    };
  };

  const buildEffectiveEnv = async () => {
    const resolved = await resolveEffectiveAuth();
    if (resolved.status.mode !== "http" || !resolved.apiKey) {
      return {
        resolved,
        env: effectiveEnv,
      };
    }

    return {
      resolved,
      env: {
        ...effectiveEnv,
        CYRENE_API_KEY: resolved.apiKey,
        CYRENE_BASE_URL:
          resolved.providerBaseUrl ?? effectiveEnv.CYRENE_BASE_URL,
        CYRENE_MODEL: resolved.currentModel,
      } satisfies NodeJS.ProcessEnv,
    };
  };

  const getStatus = async () => {
    const resolved = await resolveEffectiveAuth();
    return resolved.status;
  };

  const validateLoginInput = async (
    input: AuthLoginInput
  ): Promise<AuthValidationResult> => {
    const persistenceTarget = await apiKeyStore.getTarget();
    const rawProviderBaseUrl = trimNonEmpty(input.providerBaseUrl);
    if (!rawProviderBaseUrl) {
      return {
        ok: false,
        message: "Provider base URL is required.",
        persistenceTarget,
      };
    }

    let normalizedProviderBaseUrl = rawProviderBaseUrl;
    try {
      const parsed = new URL(rawProviderBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Provider base URL must use http or https.");
      }
      normalizedProviderBaseUrl = normalizeProviderBaseUrl(parsed.toString());
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Provider base URL is invalid.",
        persistenceTarget,
      };
    }

    const apiKey = trimNonEmpty(input.apiKey);
    if (!apiKey) {
      return {
        ok: false,
        message: "API key is required.",
        persistenceTarget,
      };
    }

    const preferredModel = trimNonEmpty(input.model);
    try {
      const resolved = await resolveEffectiveAuth();
      const catalog = await fetchProviderModelCatalogImpl({
        baseUrl: normalizedProviderBaseUrl,
        apiKey,
        preferredModel,
        currentModel: preferredModel ?? resolved.currentModel ?? "gpt-4o-mini",
      });
      return {
        ok: true,
        message: `Validated provider. Loaded ${catalog.models.length} model(s). Initial model: ${catalog.selectedModel}`,
        persistenceTarget,
        normalizedProviderBaseUrl: catalog.providerBaseUrl,
        selectedModel: catalog.selectedModel,
        availableModels: catalog.models,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        persistenceTarget,
      };
    }
  };

  const buildTransport = async () => {
    const { resolved, env } = await buildEffectiveEnv();
    if (resolved.status.mode !== "http") {
      return createLocalTransport();
    }
    return createHttpTransport({
      appRoot: options.appRoot,
      cwd: options.cwd,
      env,
      requestTemperature,
    });
  };

  const saveLogin = async (
    input: AuthLoginInput
  ): Promise<AuthRuntimeMutationResult> => {
    const before = await resolveEffectiveAuth();
    const validation = await validateLoginInput(input);

    if (
      !validation.ok ||
      !validation.normalizedProviderBaseUrl ||
      !validation.selectedModel ||
      !validation.availableModels
    ) {
      return {
        ok: false,
        message: validation.message,
        status: before.status,
        transport: await buildTransport(),
      };
    }

    const existingMetadata = await loadProviderMetadata();
    const nextProviders = Array.from(
      new Set(
        [
          ...existingMetadata.providers,
          validation.normalizedProviderBaseUrl,
        ].filter(Boolean)
      )
    );
    await saveModelYamlImpl(
      validation.availableModels,
      validation.selectedModel,
      {
        lastUsedModel: validation.selectedModel,
        providerBaseUrl: validation.normalizedProviderBaseUrl,
        providers: nextProviders,
      },
      options.appRoot,
      {
        cwd: options.cwd,
        env: effectiveEnv,
      }
    );
    await apiKeyStore.save(input.apiKey);

    if (!before.hasExplicitProcessKey) {
      effectiveEnv.CYRENE_API_KEY = input.apiKey;
      ownsProcessApiKey = true;
    }

    const transport = await buildTransport();
    const status = await getStatus();
    const message = before.hasExplicitProcessKey
      ? `Saved login to ${formatPersistenceTarget(status)}. An explicit CYRENE_API_KEY from this launch environment is still active for this run.`
      : `Saved login to ${formatPersistenceTarget(status)}. Switched to HTTP mode.`;
    return {
      ok: true,
      message,
      status,
      transport,
    };
  };

  const logout = async (): Promise<AuthRuntimeMutationResult> => {
    const before = await resolveEffectiveAuth();
    await apiKeyStore.clear();
    if (ownsProcessApiKey) {
      delete effectiveEnv.CYRENE_API_KEY;
      ownsProcessApiKey = false;
    }

    const transport = await buildTransport();
    const status = await getStatus();
    const message = before.hasExplicitProcessKey
      ? "Removed the managed user-scoped API key. An explicit CYRENE_API_KEY from this launch environment is still active for this run."
      : status.mode === "local"
        ? "Removed the managed user-scoped API key. Switched to local core."
        : "Removed the managed user-scoped API key.";

    return {
      ok: true,
      message,
      status,
      transport,
    };
  };

  return {
    getStatus,
    validateLoginInput,
    saveLogin,
    logout,
    buildTransport,
  };
};
