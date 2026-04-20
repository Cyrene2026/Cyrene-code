import { createHttpQueryTransport, fetchProviderModelCatalog, normalizeProviderBaseUrl } from "../http/createHttpQueryTransport";
import { createLocalCoreTransport } from "../local/createLocalCoreTransport";
import type { McpToolDescriptor } from "../../core/mcp/runtimeTypes";
import { loadModelYaml, saveModelYaml } from "../config/modelCatalog";
import {
  isProviderType,
  resolveProviderTypeFamily,
} from "../../core/query/transport";
import {
  createUserScopedApiKeyStore,
  type ManagedAuthEnvName,
  type UserScopedApiKeyStore,
} from "./userScopedApiKeyStore";
import type {
  ProviderEndpointOverrideMap,
  ProviderFormatOverrideMap,
  ProviderModelCatalogModeMap,
  ProviderProfileOverrideMap,
  ProviderType,
  ProviderTypeOverrideMap,
  QueryTransport,
} from "../../core/query/transport";
import type { AuthLoginInput, AuthStatus, AuthValidationResult } from "./types";

type LoadedProviderMetadata = {
  providerBaseUrl?: string;
  currentModel?: string;
  providers: string[];
  providerProfiles: ProviderProfileOverrideMap;
  providerTypes: ProviderTypeOverrideMap;
  providerModelModes: ProviderModelCatalogModeMap;
  providerFormats: ProviderFormatOverrideMap;
  providerEndpoints: ProviderEndpointOverrideMap;
  providerNames: Record<string, string>;
};

type ResolvedAuthState = {
  status: AuthStatus;
  apiKey?: string;
  providerBaseUrl?: string;
  currentModel: string;
  selectedApiKeyEnvName?: ManagedAuthEnvName;
  persistedApiKey?: string;
  storedApiKeys: Partial<Record<ManagedAuthEnvName, string>>;
  hasExplicitProcessKey: boolean;
};

type AuthRuntimeOptions = {
  appRoot: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTemperature?: number;
  debugAnthropicRequestsCapture?: boolean;
  debugAnthropicRequestsDir?: string;
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
  getSavedApiKey: (providerBaseUrl: string) => Promise<string | undefined>;
  validateLoginInput: (input: AuthLoginInput) => Promise<AuthValidationResult>;
  saveLogin: (input: AuthLoginInput) => Promise<AuthRuntimeMutationResult>;
  logout: () => Promise<AuthRuntimeMutationResult>;
  syncSelection: (input: {
    providerBaseUrl?: string;
    model?: string;
  }) => Promise<AuthStatus>;
  buildTransport: (options?: {
    mcpTools?: McpToolDescriptor[];
  }) => Promise<QueryTransport>;
};

const trimNonEmpty = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const INTERNAL_WHITESPACE_PATTERN = /\s/;

const validateApiKeyShape = (rawValue: string | undefined | null) => {
  const trimmed = trimNonEmpty(rawValue);
  if (!trimmed) {
    return {
      ok: false as const,
      message: "API key is required.",
    };
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return {
      ok: false as const,
      message: "API key must not include surrounding quotes.",
    };
  }

  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return {
      ok: false as const,
      message: "API key contains control characters. Remove hidden newlines or other non-printable characters.",
    };
  }

  if (INTERNAL_WHITESPACE_PATTERN.test(trimmed)) {
    return {
      ok: false as const,
      message: "API key must not contain spaces or embedded line breaks.",
    };
  }

  return {
    ok: true as const,
    value: trimmed,
  };
};

const GENERIC_API_KEY_ENV_NAME = "CYRENE_API_KEY" as const;
const PROVIDER_API_KEY_ENV_BY_FAMILY = {
  openai: "CYRENE_OPENAI_API_KEY",
  gemini: "CYRENE_GEMINI_API_KEY",
  anthropic: "CYRENE_ANTHROPIC_API_KEY",
} as const satisfies Record<string, ManagedAuthEnvName>;
type ProviderFamily = keyof typeof PROVIDER_API_KEY_ENV_BY_FAMILY | "glm";
type ManagedAuthEnvValues = Partial<Record<ManagedAuthEnvName, string>>;

const inferProviderFamilyFromBaseUrl = (
  providerBaseUrl: string
): ProviderFamily => {
  const normalized = normalizeProviderBaseUrl(providerBaseUrl);
  const host = new URL(normalized).hostname.toLowerCase();
  return host.includes("anthropic.com")
    ? "anthropic"
    : host.includes("generativelanguage.googleapis.com")
      ? "gemini"
      : host.includes("bigmodel.cn") || host.includes("zhipuai.cn")
        ? "glm"
      : "openai";
};

const resolveProviderFamily = (
  providerBaseUrl: string,
  providerProfiles?: ProviderProfileOverrideMap,
  providerTypes?: ProviderTypeOverrideMap
): ProviderFamily => {
  const normalized = normalizeProviderBaseUrl(providerBaseUrl);
  const explicitType = providerTypes?.[normalized];
  if (explicitType) {
    return resolveProviderTypeFamily(explicitType);
  }
  return providerProfiles?.[normalized] ?? inferProviderFamilyFromBaseUrl(normalized);
};

const resolveApiKeyEnvNameForFamily = (
  family: ProviderFamily
): ManagedAuthEnvName =>
  family === "glm"
    ? GENERIC_API_KEY_ENV_NAME
    : PROVIDER_API_KEY_ENV_BY_FAMILY[family];

const formatPersistenceTarget = (status: AuthStatus) =>
  status.persistenceTarget
    ? `${status.persistenceTarget.label} (${status.persistenceTarget.path})`
    : "unavailable";

const buildLaunchEnvShadowWarning = (options: {
  env: NodeJS.ProcessEnv;
  providerBaseUrl: string;
  model: string;
  apiKey: string;
  providerEnvName: ManagedAuthEnvName;
}) => {
  const warnings: string[] = [];

  const launchProvider = trimNonEmpty(options.env.CYRENE_BASE_URL);
  if (launchProvider && launchProvider !== options.providerBaseUrl) {
    warnings.push("CYRENE_BASE_URL");
  }

  const launchModel = trimNonEmpty(options.env.CYRENE_MODEL);
  if (launchModel && launchModel !== options.model) {
    warnings.push("CYRENE_MODEL");
  }

  const launchProviderKey = trimNonEmpty(options.env[options.providerEnvName]);
  if (launchProviderKey && launchProviderKey !== options.apiKey) {
    warnings.push(options.providerEnvName);
  }

  if (warnings.length === 0) {
    return "";
  }

  return ` Future launches from this same shell may still use ${warnings.join(", ")} from the current launch environment. Unset those vars or open a new terminal to use the saved login.`;
};

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

  let runtimeApiKeyOverrides: ManagedAuthEnvValues = {};
  let runtimeProviderBaseUrlOverride: string | undefined;
  let runtimeModelOverride: string | undefined;

  const readStoredApiKeys = async (): Promise<ManagedAuthEnvValues> => {
    if (apiKeyStore.readAll) {
      return Object.fromEntries(
        Object.entries(await apiKeyStore.readAll()).filter(
          (entry): entry is [ManagedAuthEnvName, string] => Boolean(trimNonEmpty(entry[1]))
        )
      ) as ManagedAuthEnvValues;
    }
    const genericApiKey = trimNonEmpty(await apiKeyStore.read());
    return genericApiKey ? { [GENERIC_API_KEY_ENV_NAME]: genericApiKey } : {};
  };

  const resolveEffectiveApiKeyValue = (
    envName: ManagedAuthEnvName,
    storedApiKeys: ManagedAuthEnvValues
  ) =>
    trimNonEmpty(runtimeApiKeyOverrides[envName]) ??
    trimNonEmpty(effectiveEnv[envName]) ??
    trimNonEmpty(storedApiKeys[envName]);

  const resolveRememberedApiKeyForProvider = (
    providerBaseUrl: string | undefined,
    storedApiKeys: ManagedAuthEnvValues,
    providerProfiles?: ProviderProfileOverrideMap,
    providerTypes?: ProviderTypeOverrideMap
  ) => {
    const family = providerBaseUrl
      ? resolveProviderFamily(providerBaseUrl, providerProfiles, providerTypes)
      : "openai";
    const familyEnvName = resolveApiKeyEnvNameForFamily(family);
    const familySpecificKey = trimNonEmpty(storedApiKeys[familyEnvName]);
    if (familySpecificKey) {
      return {
        apiKey: familySpecificKey,
        envName: familyEnvName,
        source: "user_env",
      } as const;
    }

    const genericKey = trimNonEmpty(storedApiKeys[GENERIC_API_KEY_ENV_NAME]);
    if (!genericKey) {
      return null;
    }
    return {
      apiKey: genericKey,
      envName: GENERIC_API_KEY_ENV_NAME,
      source: "user_env",
    } as const;
  };

  const resolveEffectiveApiKeyForProvider = (
    providerBaseUrl: string | undefined,
    storedApiKeys: ManagedAuthEnvValues,
    providerProfiles?: ProviderProfileOverrideMap,
    providerTypes?: ProviderTypeOverrideMap
  ) => {
    const family = providerBaseUrl
      ? resolveProviderFamily(providerBaseUrl, providerProfiles, providerTypes)
      : "openai";
    const familyEnvName = resolveApiKeyEnvNameForFamily(family);
    const familySpecificKey = resolveEffectiveApiKeyValue(familyEnvName, storedApiKeys);
    if (familySpecificKey) {
      const launchValue = trimNonEmpty(effectiveEnv[familyEnvName]);
      const storedValue = trimNonEmpty(storedApiKeys[familyEnvName]);
      const source =
        runtimeApiKeyOverrides[familyEnvName] ||
        (launchValue && storedValue && launchValue === storedValue)
          ? "user_env"
          : launchValue
            ? "process_env"
            : "user_env";
      return {
        apiKey: familySpecificKey,
        envName: familyEnvName,
        source,
      } as const;
    }

    const genericKey = resolveEffectiveApiKeyValue(
      GENERIC_API_KEY_ENV_NAME,
      storedApiKeys
    );
    if (!genericKey) {
      return null;
    }
    const launchValue = trimNonEmpty(effectiveEnv[GENERIC_API_KEY_ENV_NAME]);
    const storedValue = trimNonEmpty(storedApiKeys[GENERIC_API_KEY_ENV_NAME]);
    const source =
      runtimeApiKeyOverrides[GENERIC_API_KEY_ENV_NAME] ||
      (launchValue && storedValue && launchValue === storedValue)
        ? "user_env"
        : launchValue
          ? "process_env"
          : "user_env";
    return {
      apiKey: genericKey,
      envName: GENERIC_API_KEY_ENV_NAME,
      source,
    } as const;
  };

  const loadProviderMetadata = async (): Promise<LoadedProviderMetadata> => {
    try {
      const loaded = await loadModelYamlImpl(options.appRoot, {
        cwd: options.cwd,
        env: effectiveEnv,
      });
      const normalizedProvider = trimNonEmpty(loaded.providerBaseUrl);
      const normalizedProviderProfiles = Object.fromEntries(
        Object.entries(loaded.providerProfiles ?? {})
          .map(([provider, profile]) => {
            try {
              const normalized = normalizeProviderBaseUrl(provider);
              return [normalized, profile] as const;
            } catch {
              return null;
            }
          })
          .filter(
            (
              entry
            ): entry is [string, ProviderProfileOverrideMap[string]] =>
              Boolean(entry)
          )
      ) as ProviderProfileOverrideMap;
      const normalizedProviderTypes = Object.fromEntries(
        Object.entries(loaded.providerTypes ?? {})
          .map(([provider, type]) => {
            try {
              const normalized = normalizeProviderBaseUrl(provider);
              return normalized && type && isProviderType(type)
                ? ([normalized, type] as const)
                : null;
            } catch {
              return null;
            }
          })
          .filter(
            (entry): entry is [string, ProviderTypeOverrideMap[string]] =>
              Boolean(entry)
          )
      ) as ProviderTypeOverrideMap;
      return {
        providerBaseUrl: normalizedProvider
          ? normalizeProviderBaseUrl(normalizedProvider)
          : undefined,
        currentModel:
          trimNonEmpty(
            loaded.lastUsedModel ?? loaded.defaultModel ?? loaded.models[0]
          ) ?? "gpt-4o-mini",
        providers: Array.from(
          new Set(
            [
              ...loaded.providers,
              ...Object.keys(normalizedProviderProfiles),
              ...Object.keys(normalizedProviderTypes),
              trimNonEmpty(loaded.providerBaseUrl),
            ].filter(Boolean)
          )
        ) as string[],
        providerProfiles: normalizedProviderProfiles,
        providerTypes: normalizedProviderTypes,
        providerModelModes: Object.fromEntries(
          Object.entries(loaded.providerModelModes ?? {})
            .map(([provider, mode]) => {
              try {
                const normalized = normalizeProviderBaseUrl(provider);
                return normalized && (mode === "api" || mode === "manual")
                  ? ([normalized, mode] as const)
                  : null;
              } catch {
                return null;
              }
            })
            .filter((entry): entry is [string, ProviderModelCatalogModeMap[string]] => Boolean(entry))
        ) as ProviderModelCatalogModeMap,
        providerFormats: Object.fromEntries(
          Object.entries(loaded.providerFormats ?? {})
            .map(([provider, format]) => {
              try {
                const normalized = normalizeProviderBaseUrl(provider);
                return normalized && format
                  ? ([normalized, format] as const)
                  : null;
              } catch {
                return null;
              }
            })
            .filter(
              (entry): entry is [string, ProviderFormatOverrideMap[string]] =>
                Boolean(entry)
            )
        ) as ProviderFormatOverrideMap,
        providerEndpoints: Object.fromEntries(
          Object.entries(loaded.providerEndpoints ?? {})
            .map(([provider, endpoints]) => {
              try {
                const normalized = normalizeProviderBaseUrl(provider);
                if (!normalized) {
                  return null;
                }
                const normalizedEndpoints = Object.fromEntries(
                  Object.entries(endpoints ?? {})
                    .map(([kind, endpoint]) => {
                      const trimmedEndpoint = trimNonEmpty(endpoint);
                      return trimmedEndpoint ? ([kind, trimmedEndpoint] as const) : null;
                    })
                    .filter((entry): entry is [string, string] => Boolean(entry))
                );
                return Object.keys(normalizedEndpoints).length > 0
                  ? ([normalized, normalizedEndpoints] as const)
                  : null;
              } catch {
                return null;
              }
            })
            .filter((entry): entry is [string, ProviderEndpointOverrideMap[string]] => Boolean(entry))
        ) as ProviderEndpointOverrideMap,
        providerNames: Object.fromEntries(
          Object.entries(loaded.providerNames ?? {})
            .map(([provider, name]) => {
              try {
                const normalized = normalizeProviderBaseUrl(provider);
                const trimmedName = trimNonEmpty(name);
                return normalized && trimmedName
                  ? ([normalized, trimmedName] as const)
                  : null;
              } catch {
                return null;
              }
            })
            .filter((entry): entry is [string, string] => Boolean(entry))
        ),
      };
    } catch {
      return {
        providerBaseUrl: undefined,
        currentModel: trimNonEmpty(effectiveEnv.CYRENE_MODEL) ?? "gpt-4o-mini",
        providers: [],
        providerProfiles: {},
        providerTypes: {},
        providerModelModes: {},
        providerFormats: {},
        providerEndpoints: {},
        providerNames: {},
      };
    }
  };

  const resolveEffectiveAuth = async (): Promise<ResolvedAuthState> => {
    const persistenceTarget = await apiKeyStore.getTarget();
    const metadata = await loadProviderMetadata();
    const storedApiKeys = await readStoredApiKeys();
    const processProviderBaseUrl =
      runtimeProviderBaseUrlOverride ?? trimNonEmpty(effectiveEnv.CYRENE_BASE_URL);
    const processModel =
      runtimeModelOverride ?? trimNonEmpty(effectiveEnv.CYRENE_MODEL);
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
    let selectedApiKeyEnvName: ManagedAuthEnvName | undefined;
    const resolvedApiKey = resolveEffectiveApiKeyForProvider(
      providerBaseUrl,
      storedApiKeys,
      metadata.providerProfiles,
      metadata.providerTypes
    );
    if (resolvedApiKey?.apiKey) {
      apiKey = resolvedApiKey.apiKey;
      credentialSource = resolvedApiKey.source;
      selectedApiKeyEnvName = resolvedApiKey.envName;
      hasExplicitProcessKey = credentialSource === "process_env";
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
      selectedApiKeyEnvName,
      persistedApiKey:
        selectedApiKeyEnvName && storedApiKeys[selectedApiKeyEnvName]
          ? storedApiKeys[selectedApiKeyEnvName]
          : storedApiKeys[GENERIC_API_KEY_ENV_NAME],
      storedApiKeys,
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

    const mergedEnv: NodeJS.ProcessEnv = {
      ...effectiveEnv,
      CYRENE_API_KEY: resolveEffectiveApiKeyValue(
        GENERIC_API_KEY_ENV_NAME,
        resolved.storedApiKeys
      ),
      CYRENE_OPENAI_API_KEY: resolveEffectiveApiKeyValue(
        "CYRENE_OPENAI_API_KEY",
        resolved.storedApiKeys
      ),
      CYRENE_GEMINI_API_KEY: resolveEffectiveApiKeyValue(
        "CYRENE_GEMINI_API_KEY",
        resolved.storedApiKeys
      ),
      CYRENE_ANTHROPIC_API_KEY: resolveEffectiveApiKeyValue(
        "CYRENE_ANTHROPIC_API_KEY",
        resolved.storedApiKeys
      ),
      CYRENE_BASE_URL:
        runtimeProviderBaseUrlOverride ??
        trimNonEmpty(effectiveEnv.CYRENE_BASE_URL) ??
        resolved.providerBaseUrl,
      CYRENE_MODEL:
        runtimeModelOverride ??
        trimNonEmpty(effectiveEnv.CYRENE_MODEL) ??
        resolved.currentModel,
    };

    return {
      resolved,
      env: mergedEnv,
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
      normalizedProviderBaseUrl = normalizeProviderBaseUrl(rawProviderBaseUrl);
      const parsed = new URL(normalizedProviderBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Provider base URL must use http or https.");
      }
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

    const apiKeyValidation = validateApiKeyShape(input.apiKey);
    if (!apiKeyValidation.ok) {
      return {
        ok: false,
        message: apiKeyValidation.message,
        persistenceTarget,
      };
    }
    const apiKey = apiKeyValidation.value;
    const providerType =
      typeof input.providerType === "string" && input.providerType.trim()
        ? input.providerType.trim().toLowerCase()
        : undefined;
    if (providerType && !isProviderType(providerType)) {
      return {
        ok: false,
        message:
          "Provider type must be one of: openai-compatible, openai-responses, gemini, anthropic.",
        persistenceTarget,
      };
    }

    const preferredModel = trimNonEmpty(input.model);
    try {
      const [resolved, metadata] = await Promise.all([
        resolveEffectiveAuth(),
        loadProviderMetadata(),
      ]);
      const catalog = await fetchProviderModelCatalogImpl({
        baseUrl: normalizedProviderBaseUrl,
        apiKey,
        preferredModel,
        currentModel: preferredModel ?? resolved.currentModel ?? "gpt-4o-mini",
        familyOverride: resolveProviderFamily(
          normalizedProviderBaseUrl,
          metadata.providerProfiles,
          providerType && isProviderType(providerType)
            ? {
                ...metadata.providerTypes,
                [normalizedProviderBaseUrl]: providerType,
              }
            : metadata.providerTypes
        ),
      });
      return {
        ok: true,
        message:
          catalog.catalogMode === "manual"
            ? `Validated provider. /models is unavailable; using manual model mode. Initial model: ${catalog.selectedModel}`
            : `Validated provider. Loaded ${catalog.models.length} model(s). Initial model: ${catalog.selectedModel}`,
        persistenceTarget,
        normalizedProviderBaseUrl: catalog.providerBaseUrl,
        normalizedApiKey: apiKey,
        selectedModel: catalog.selectedModel,
        availableModels: catalog.models,
        providerModelMode: catalog.catalogMode,
        providerType: providerType as ProviderType | undefined,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        persistenceTarget,
      };
    }
  };

  const buildTransport = async (buildOptions?: {
    mcpTools?: McpToolDescriptor[];
  }) => {
    const { resolved, env } = await buildEffectiveEnv();
    if (resolved.status.mode !== "http") {
      return createLocalTransport();
    }
    return createHttpTransport({
      appRoot: options.appRoot,
      cwd: options.cwd,
      env,
      requestTemperature,
      mcpTools: buildOptions?.mcpTools,
      debugAnthropicRequests: {
        capture: options.debugAnthropicRequestsCapture,
        directory: options.debugAnthropicRequestsDir,
      },
    });
  };

  const syncSelection = async (input: {
    providerBaseUrl?: string;
    model?: string;
  }) => {
    const nextProviderBaseUrl = trimNonEmpty(input.providerBaseUrl);
    if (
      !nextProviderBaseUrl ||
      nextProviderBaseUrl === "none" ||
      nextProviderBaseUrl === "local-core"
    ) {
      runtimeProviderBaseUrlOverride = undefined;
    } else {
      try {
        runtimeProviderBaseUrlOverride = normalizeProviderBaseUrl(nextProviderBaseUrl);
      } catch {
        runtimeProviderBaseUrlOverride = nextProviderBaseUrl;
      }
    }

    const nextModel = trimNonEmpty(input.model);
    if (nextModel) {
      runtimeModelOverride = nextModel;
    }

    return await getStatus();
  };

  const getSavedApiKey = async (providerBaseUrl: string) => {
    const normalizedProviderBaseUrl = trimNonEmpty(providerBaseUrl);
    if (!normalizedProviderBaseUrl) {
      return undefined;
    }
    let normalized: string;
    try {
      normalized = normalizeProviderBaseUrl(normalizedProviderBaseUrl);
    } catch {
      return undefined;
    }
    const [storedApiKeys, metadata] = await Promise.all([
      readStoredApiKeys(),
      loadProviderMetadata(),
    ]);
    return resolveRememberedApiKeyForProvider(
      normalized,
      storedApiKeys,
      metadata.providerProfiles,
      metadata.providerTypes
    )?.apiKey;
  };

  const saveLogin = async (
    input: AuthLoginInput
  ): Promise<AuthRuntimeMutationResult> => {
    const before = await resolveEffectiveAuth();
    const validation = await validateLoginInput(input);

    if (
      !validation.ok ||
      !validation.normalizedProviderBaseUrl ||
      !validation.normalizedApiKey ||
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
    const providerFamily = resolveProviderFamily(
      validation.normalizedProviderBaseUrl,
      existingMetadata.providerProfiles,
      validation.providerType
        ? {
            ...existingMetadata.providerTypes,
            [validation.normalizedProviderBaseUrl]: validation.providerType,
          }
        : existingMetadata.providerTypes
    );
    const providerEnvName = resolveApiKeyEnvNameForFamily(providerFamily);
    const nextProviders = Array.from(
      new Set(
        [
          ...existingMetadata.providers,
          validation.normalizedProviderBaseUrl,
        ].filter(Boolean)
      )
    );
    const nextProviderProfiles = { ...existingMetadata.providerProfiles };
    const nextProviderFormats = { ...existingMetadata.providerFormats };
    if (validation.providerType) {
      delete nextProviderProfiles[validation.normalizedProviderBaseUrl];
      delete nextProviderFormats[validation.normalizedProviderBaseUrl];
    }
    await saveModelYamlImpl(
      validation.availableModels,
      validation.selectedModel,
      {
        lastUsedModel: validation.selectedModel,
        providerBaseUrl: validation.normalizedProviderBaseUrl,
        providers: nextProviders,
        providerProfiles: nextProviderProfiles,
        providerTypes: validation.providerType
          ? {
              ...existingMetadata.providerTypes,
              [validation.normalizedProviderBaseUrl]: validation.providerType,
            }
          : existingMetadata.providerTypes,
        providerModelModes: {
          ...existingMetadata.providerModelModes,
          [validation.normalizedProviderBaseUrl]:
            validation.providerModelMode ?? "api",
        },
        providerFormats: nextProviderFormats,
        providerEndpoints: existingMetadata.providerEndpoints,
        providerNames: existingMetadata.providerNames,
      },
      options.appRoot,
      {
        cwd: options.cwd,
        env: effectiveEnv,
      }
    );
    await apiKeyStore.save(validation.normalizedApiKey, providerEnvName);
    runtimeApiKeyOverrides = {
      ...runtimeApiKeyOverrides,
      [providerEnvName]: validation.normalizedApiKey,
    };
    runtimeProviderBaseUrlOverride = validation.normalizedProviderBaseUrl;
    runtimeModelOverride = validation.selectedModel;

    const transport = await buildTransport();
    const status = await getStatus();
    const shadowWarning = buildLaunchEnvShadowWarning({
      env: effectiveEnv,
      providerBaseUrl: validation.normalizedProviderBaseUrl,
      model: validation.selectedModel,
      apiKey: validation.normalizedApiKey,
      providerEnvName,
    });
    const message = (before.hasExplicitProcessKey
      ? `Saved login to ${formatPersistenceTarget(status)}. Switched the current run to the newly saved credential.`
      : `Saved login to ${formatPersistenceTarget(status)}. Switched to HTTP mode.`) + shadowWarning;
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
    runtimeApiKeyOverrides = {};
    runtimeProviderBaseUrlOverride = undefined;
    runtimeModelOverride = undefined;

    const transport = await buildTransport();
    const status = await getStatus();
    const message = before.hasExplicitProcessKey
      ? "Removed the managed user-scoped API key. Reverted to the explicit CYRENE_API_KEY from this launch environment."
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
    getSavedApiKey,
    validateLoginInput,
    saveLogin,
    logout,
    syncSelection,
    buildTransport,
  };
};
