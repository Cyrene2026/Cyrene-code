import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProviderEndpointKind,
  ProviderModelCatalogMode,
  ProviderModelCatalogModeMap,
  ProviderEndpointOverrideMap,
  ProviderType,
  ProviderTypeOverrideMap,
  TransportFormat,
} from "../../core/query/transport";
import {
  isManualProviderProfile,
  isProviderEndpointKind,
  isProviderType,
  isTransportFormat,
} from "../../core/query/transport";
import {
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  resolveAppRoot,
} from "./appRoot";

type ModelCatalogContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const getModelFile = (
  appRoot = resolveAppRoot(),
  context?: ModelCatalogContext
) =>
  join(getCyreneConfigDir({ cwd: appRoot, env: context?.env }), "model.yaml");

const getLegacyModelFile = (appRoot = resolveAppRoot()) =>
  join(getLegacyProjectCyreneDir(appRoot), "model.yaml");

const readModelFile = async (
  appRoot = resolveAppRoot(),
  context?: ModelCatalogContext
) => {
  try {
    return await readFile(getModelFile(appRoot, context), "utf8");
  } catch {
    return await readFile(getLegacyModelFile(appRoot), "utf8");
  }
};

const ensureModelDir = async (
  appRoot = resolveAppRoot(),
  context?: ModelCatalogContext
) =>
  mkdir(getCyreneConfigDir({ cwd: appRoot, env: context?.env }), {
    recursive: true,
  });

const parseScalar = (value: string) =>
  value.replace(/^["']/, "").replace(/["']$/, "").trim();

type PersistedProviderProfile = "openai" | "gemini" | "anthropic";
type PersistedProviderType = ProviderType;
type PersistedTransportFormat = TransportFormat;
type PersistedProviderEndpointKind = ProviderEndpointKind;
type PersistedProviderModelCatalogMode = ProviderModelCatalogMode;

const isPersistedTransportFormat = (
  value: string
): value is PersistedTransportFormat =>
  isTransportFormat(value);

const isPersistedProviderEndpointKind = (
  value: string
): value is PersistedProviderEndpointKind =>
  isProviderEndpointKind(value);

const isPersistedProviderModelCatalogMode = (
  value: string
): value is PersistedProviderModelCatalogMode =>
  value === "api" || value === "manual";

const isPersistedProviderType = (
  value: string
): value is PersistedProviderType =>
  isProviderType(value);

export const loadModelYaml = async (
  appRoot = resolveAppRoot(),
  context?: ModelCatalogContext
): Promise<{
  models: string[];
  defaultModel?: string;
  lastUsedModel?: string;
  providerBaseUrl?: string;
  providers: string[];
  providerProfiles: Record<string, PersistedProviderProfile>;
  providerTypes?: ProviderTypeOverrideMap;
  providerModelModes?: ProviderModelCatalogModeMap;
  providerFormats?: Record<string, PersistedTransportFormat>;
  providerEndpoints?: ProviderEndpointOverrideMap;
  providerNames?: Record<string, string>;
}> => {
  const content = await readModelFile(appRoot, context);
  const models: string[] = [];
  const providers: string[] = [];
  const providerProfiles: Record<string, PersistedProviderProfile> = {};
  const providerTypes: ProviderTypeOverrideMap = {};
  const providerModelModes: ProviderModelCatalogModeMap = {};
  const providerFormats: Record<string, PersistedTransportFormat> = {};
  const providerEndpoints: ProviderEndpointOverrideMap = {};
  const providerNames: Record<string, string> = {};
  let defaultModel: string | undefined;
  let lastUsedModel: string | undefined;
  let providerBaseUrl: string | undefined;
  let section:
    | "root"
    | "models"
    | "providers"
    | "provider_profiles"
    | "provider_types"
    | "provider_model_modes"
    | "provider_formats"
    | "provider_endpoints"
    | "provider_names" = "root";
  let pendingProviderProfile:
    | {
        provider?: string;
        profile?: PersistedProviderProfile;
      }
    | null = null;
  let pendingProviderType:
    | {
        provider?: string;
        type?: PersistedProviderType;
      }
    | null = null;
  let pendingProviderFormat:
    | {
        provider?: string;
        format?: PersistedTransportFormat;
      }
    | null = null;
  let pendingProviderModelMode:
    | {
        provider?: string;
        mode?: PersistedProviderModelCatalogMode;
      }
    | null = null;
  let pendingProviderName:
    | {
        provider?: string;
        name?: string;
      }
    | null = null;
  let pendingProviderEndpoint:
    | {
        provider?: string;
        kind?: PersistedProviderEndpointKind;
        endpoint?: string;
      }
    | null = null;

  const flushPendingProviderProfile = () => {
    if (
      pendingProviderProfile?.provider &&
      pendingProviderProfile?.profile &&
      pendingProviderProfile.provider.trim()
    ) {
      providerProfiles[pendingProviderProfile.provider.trim()] =
        pendingProviderProfile.profile;
    }
    pendingProviderProfile = null;
  };

  const flushPendingProviderType = () => {
    if (
      pendingProviderType?.provider &&
      pendingProviderType?.type &&
      pendingProviderType.provider.trim()
    ) {
      providerTypes[pendingProviderType.provider.trim()] =
        pendingProviderType.type;
    }
    pendingProviderType = null;
  };

  const flushPendingProviderName = () => {
    if (
      pendingProviderName?.provider &&
      pendingProviderName?.name &&
      pendingProviderName.provider.trim() &&
      pendingProviderName.name.trim()
    ) {
      providerNames[pendingProviderName.provider.trim()] =
        pendingProviderName.name.trim();
    }
    pendingProviderName = null;
  };

  const flushPendingProviderModelMode = () => {
    if (
      pendingProviderModelMode?.provider &&
      pendingProviderModelMode?.mode &&
      pendingProviderModelMode.provider.trim()
    ) {
      providerModelModes[pendingProviderModelMode.provider.trim()] =
        pendingProviderModelMode.mode;
    }
    pendingProviderModelMode = null;
  };

  const flushPendingProviderFormat = () => {
    if (
      pendingProviderFormat?.provider &&
      pendingProviderFormat?.format &&
      pendingProviderFormat.provider.trim()
    ) {
      providerFormats[pendingProviderFormat.provider.trim()] =
        pendingProviderFormat.format;
    }
    pendingProviderFormat = null;
  };

  const flushPendingProviderEndpoint = () => {
    const provider = pendingProviderEndpoint?.provider?.trim();
    const endpoint = pendingProviderEndpoint?.endpoint?.trim();
    const kind = pendingProviderEndpoint?.kind ?? "responses";
    if (
      provider &&
      endpoint &&
      isPersistedProviderEndpointKind(kind)
    ) {
      providerEndpoints[provider] = {
        ...(providerEndpoints[provider] ?? {}),
        [kind]: endpoint,
      };
    }
    pendingProviderEndpoint = null;
  };

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("default_model:")) {
      defaultModel = parseScalar(line.slice("default_model:".length));
      continue;
    }
    if (line.startsWith("last_used_model:")) {
      lastUsedModel = parseScalar(line.slice("last_used_model:".length));
      continue;
    }
    if (line.startsWith("provider_base_url:")) {
      providerBaseUrl = parseScalar(line.slice("provider_base_url:".length));
      continue;
    }
    if (line === "models:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "models";
      continue;
    }
    if (line === "providers:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "providers";
      continue;
    }
    if (line === "provider_profiles:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_profiles";
      continue;
    }
    if (line === "provider_types:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_types";
      continue;
    }
    if (line === "provider_model_modes:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_model_modes";
      continue;
    }
    if (line === "provider_formats:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_formats";
      continue;
    }
    if (line === "provider_endpoints:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_endpoints";
      continue;
    }
    if (line === "provider_names:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_types") {
        flushPendingProviderType();
      } else if (section === "provider_model_modes") {
        flushPendingProviderModelMode();
      } else if (section === "provider_formats") {
        flushPendingProviderFormat();
      } else if (section === "provider_endpoints") {
        flushPendingProviderEndpoint();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_names";
      continue;
    }
    if (section === "provider_profiles") {
      if (line.startsWith("-")) {
        flushPendingProviderProfile();
        const rawEntry = line.slice(1).trim();
        if (!rawEntry) {
          pendingProviderProfile = {};
          continue;
        }
        if (rawEntry.startsWith("provider:")) {
          const provider = parseScalar(rawEntry.slice("provider:".length));
          pendingProviderProfile = provider ? { provider } : {};
          continue;
        }
        if (rawEntry.startsWith("profile:")) {
          const profileCandidate = parseScalar(
            rawEntry.slice("profile:".length)
          ).toLowerCase();
          pendingProviderProfile = isManualProviderProfile(profileCandidate)
            ? { profile: profileCandidate }
            : {};
          continue;
        }
        const provider = parseScalar(rawEntry);
        pendingProviderProfile = provider ? { provider } : {};
        continue;
      }
      if (line.startsWith("provider:")) {
        const provider = parseScalar(line.slice("provider:".length));
        pendingProviderProfile = {
          ...(pendingProviderProfile ?? {}),
          ...(provider ? { provider } : {}),
        };
        continue;
      }
      if (line.startsWith("profile:")) {
        const profileCandidate = parseScalar(
          line.slice("profile:".length)
        ).toLowerCase();
        pendingProviderProfile = {
          ...(pendingProviderProfile ?? {}),
          ...(isManualProviderProfile(profileCandidate)
            ? { profile: profileCandidate }
            : {}),
        };
        continue;
      }
    }
    if (section === "provider_types") {
      if (line.startsWith("-")) {
        flushPendingProviderType();
        const rawEntry = line.slice(1).trim();
        if (!rawEntry) {
          pendingProviderType = {};
          continue;
        }
        if (rawEntry.startsWith("provider:")) {
          const provider = parseScalar(rawEntry.slice("provider:".length));
          pendingProviderType = provider ? { provider } : {};
          continue;
        }
        if (rawEntry.startsWith("type:")) {
          const typeCandidate = parseScalar(
            rawEntry.slice("type:".length)
          ).toLowerCase();
          pendingProviderType = isPersistedProviderType(typeCandidate)
            ? { type: typeCandidate }
            : {};
          continue;
        }
        const provider = parseScalar(rawEntry);
        pendingProviderType = provider ? { provider } : {};
        continue;
      }
      if (line.startsWith("provider:")) {
        const provider = parseScalar(line.slice("provider:".length));
        pendingProviderType = {
          ...(pendingProviderType ?? {}),
          ...(provider ? { provider } : {}),
        };
        continue;
      }
      if (line.startsWith("type:")) {
        const typeCandidate = parseScalar(line.slice("type:".length)).toLowerCase();
        pendingProviderType = {
          ...(pendingProviderType ?? {}),
          ...(isPersistedProviderType(typeCandidate)
            ? { type: typeCandidate }
            : {}),
        };
        continue;
      }
    }
    if (section === "provider_model_modes") {
      if (line.startsWith("-")) {
        flushPendingProviderModelMode();
        const rawEntry = line.slice(1).trim();
        if (!rawEntry) {
          pendingProviderModelMode = {};
          continue;
        }
        if (rawEntry.startsWith("provider:")) {
          const provider = parseScalar(rawEntry.slice("provider:".length));
          pendingProviderModelMode = provider ? { provider } : {};
          continue;
        }
        if (rawEntry.startsWith("mode:")) {
          const modeCandidate = parseScalar(
            rawEntry.slice("mode:".length)
          ).toLowerCase();
          pendingProviderModelMode = isPersistedProviderModelCatalogMode(modeCandidate)
            ? { mode: modeCandidate }
            : {};
          continue;
        }
        const provider = parseScalar(rawEntry);
        pendingProviderModelMode = provider ? { provider } : {};
        continue;
      }
      if (line.startsWith("provider:")) {
        const provider = parseScalar(line.slice("provider:".length));
        pendingProviderModelMode = {
          ...(pendingProviderModelMode ?? {}),
          ...(provider ? { provider } : {}),
        };
        continue;
      }
      if (line.startsWith("mode:")) {
        const modeCandidate = parseScalar(line.slice("mode:".length)).toLowerCase();
        pendingProviderModelMode = {
          ...(pendingProviderModelMode ?? {}),
          ...(isPersistedProviderModelCatalogMode(modeCandidate)
            ? { mode: modeCandidate }
            : {}),
        };
        continue;
      }
    }
    if (section === "provider_formats") {
      if (line.startsWith("-")) {
        flushPendingProviderFormat();
        const rawEntry = line.slice(1).trim();
        if (!rawEntry) {
          pendingProviderFormat = {};
          continue;
        }
        if (rawEntry.startsWith("provider:")) {
          const provider = parseScalar(rawEntry.slice("provider:".length));
          pendingProviderFormat = provider ? { provider } : {};
          continue;
        }
        if (rawEntry.startsWith("format:")) {
          const formatCandidate = parseScalar(
            rawEntry.slice("format:".length)
          ).toLowerCase();
          pendingProviderFormat = isPersistedTransportFormat(formatCandidate)
            ? { format: formatCandidate }
            : {};
          continue;
        }
        const provider = parseScalar(rawEntry);
        pendingProviderFormat = provider ? { provider } : {};
        continue;
      }
      if (line.startsWith("provider:")) {
        const provider = parseScalar(line.slice("provider:".length));
        pendingProviderFormat = {
          ...(pendingProviderFormat ?? {}),
          ...(provider ? { provider } : {}),
        };
        continue;
      }
      if (line.startsWith("format:")) {
        const formatCandidate = parseScalar(
          line.slice("format:".length)
        ).toLowerCase();
        pendingProviderFormat = {
          ...(pendingProviderFormat ?? {}),
          ...(isPersistedTransportFormat(formatCandidate)
            ? { format: formatCandidate }
            : {}),
        };
        continue;
      }
    }
    if (section === "provider_endpoints") {
      if (line.startsWith("-")) {
        flushPendingProviderEndpoint();
        const rawEntry = line.slice(1).trim();
        if (!rawEntry) {
          pendingProviderEndpoint = {};
          continue;
        }
        if (rawEntry.startsWith("provider:")) {
          const provider = parseScalar(rawEntry.slice("provider:".length));
          pendingProviderEndpoint = provider ? { provider } : {};
          continue;
        }
        if (rawEntry.startsWith("endpoint:")) {
          const endpoint = parseScalar(rawEntry.slice("endpoint:".length));
          pendingProviderEndpoint = endpoint ? { endpoint } : {};
          continue;
        }
        if (rawEntry.startsWith("kind:")) {
          const kindCandidate = parseScalar(
            rawEntry.slice("kind:".length)
          ).toLowerCase();
          pendingProviderEndpoint = isPersistedProviderEndpointKind(kindCandidate)
            ? { kind: kindCandidate }
            : {};
          continue;
        }
        const provider = parseScalar(rawEntry);
        pendingProviderEndpoint = provider ? { provider } : {};
        continue;
      }
      if (line.startsWith("provider:")) {
        const provider = parseScalar(line.slice("provider:".length));
        pendingProviderEndpoint = {
          ...(pendingProviderEndpoint ?? {}),
          ...(provider ? { provider } : {}),
        };
        continue;
      }
      if (line.startsWith("endpoint:")) {
        const endpoint = parseScalar(line.slice("endpoint:".length));
        pendingProviderEndpoint = {
          ...(pendingProviderEndpoint ?? {}),
          ...(endpoint ? { endpoint } : {}),
        };
        continue;
      }
      if (line.startsWith("kind:")) {
        const kindCandidate = parseScalar(line.slice("kind:".length)).toLowerCase();
        pendingProviderEndpoint = {
          ...(pendingProviderEndpoint ?? {}),
          ...(isPersistedProviderEndpointKind(kindCandidate)
            ? { kind: kindCandidate }
            : {}),
        };
        continue;
      }
    }
    if (section === "provider_names") {
      if (line.startsWith("-")) {
        flushPendingProviderName();
        const rawEntry = line.slice(1).trim();
        if (!rawEntry) {
          pendingProviderName = {};
          continue;
        }
        if (rawEntry.startsWith("provider:")) {
          const provider = parseScalar(rawEntry.slice("provider:".length));
          pendingProviderName = provider ? { provider } : {};
          continue;
        }
        if (rawEntry.startsWith("name:")) {
          const name = parseScalar(rawEntry.slice("name:".length));
          pendingProviderName = name ? { name } : {};
          continue;
        }
        const provider = parseScalar(rawEntry);
        pendingProviderName = provider ? { provider } : {};
        continue;
      }
      if (line.startsWith("provider:")) {
        const provider = parseScalar(line.slice("provider:".length));
        pendingProviderName = {
          ...(pendingProviderName ?? {}),
          ...(provider ? { provider } : {}),
        };
        continue;
      }
      if (line.startsWith("name:")) {
        const name = parseScalar(line.slice("name:".length));
        pendingProviderName = {
          ...(pendingProviderName ?? {}),
          ...(name ? { name } : {}),
        };
        continue;
      }
    }
    if (line.startsWith("-") && section === "models") {
      const model = parseScalar(line.slice(1));
      if (model) {
        models.push(model);
      }
      continue;
    }
    if (line.startsWith("-") && section === "providers") {
      const provider = parseScalar(line.slice(1));
      if (provider) {
        providers.push(provider);
      }
    }
  }
  if (section === "provider_profiles") {
    flushPendingProviderProfile();
  } else if (section === "provider_types") {
    flushPendingProviderType();
  } else if (section === "provider_model_modes") {
    flushPendingProviderModelMode();
  } else if (section === "provider_formats") {
    flushPendingProviderFormat();
  } else if (section === "provider_endpoints") {
    flushPendingProviderEndpoint();
  } else if (section === "provider_names") {
    flushPendingProviderName();
  }

  if (models.length === 0) {
    throw new Error("model.yaml has no models");
  }

  return {
    models,
    defaultModel,
    lastUsedModel,
    providerBaseUrl,
    providers,
    providerProfiles,
    providerTypes,
    providerModelModes,
    providerFormats,
    providerEndpoints,
    providerNames,
  };
};

export const saveModelYaml = async (
  models: string[],
  defaultModel: string,
  options?: {
    lastUsedModel?: string;
    providerBaseUrl?: string;
    providers?: string[];
    providerProfiles?: Record<string, PersistedProviderProfile>;
    providerTypes?: ProviderTypeOverrideMap;
    providerModelModes?: ProviderModelCatalogModeMap;
    providerFormats?: Record<string, PersistedTransportFormat>;
    providerEndpoints?: ProviderEndpointOverrideMap;
    providerNames?: Record<string, string>;
  },
  appRoot = resolveAppRoot(),
  context?: ModelCatalogContext
): Promise<void> => {
  const unique = Array.from(new Set(models.map(model => model.trim()))).filter(
    Boolean
  );
  const uniqueProviders = Array.from(
    new Set((options?.providers ?? []).map(provider => provider.trim()))
  ).filter(Boolean);
  const providerProfileEntries = Object.entries(options?.providerProfiles ?? {})
    .map(([provider, profile]) => [provider.trim(), profile] as const)
    .filter(
      ([provider, profile]) =>
        Boolean(provider) && isManualProviderProfile(profile)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const providerTypeEntries = Object.entries(options?.providerTypes ?? {})
    .map(([provider, type]) => [provider.trim(), type] as const)
    .filter(
      ([provider, type]) =>
        Boolean(provider) && isPersistedProviderType(type)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const providerModelModeEntries = Object.entries(options?.providerModelModes ?? {})
    .map(([provider, mode]) => [provider.trim(), mode] as const)
    .filter(
      ([provider, mode]) =>
        Boolean(provider) && isPersistedProviderModelCatalogMode(mode)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const providerNameEntries = Object.entries(options?.providerNames ?? {})
    .map(([provider, name]) => [provider.trim(), name.trim()] as const)
    .filter(([provider, name]) => Boolean(provider) && Boolean(name))
    .sort(([left], [right]) => left.localeCompare(right));
  const providerEndpointEntries = Object.entries(options?.providerEndpoints ?? {})
    .flatMap(([provider, entry]) =>
      Object.entries(entry ?? {}).map(([kind, endpoint]) => [
        provider.trim(),
        kind,
        endpoint?.trim() ?? "",
      ] as const)
    )
    .filter(
      (
        entry
      ): entry is [string, PersistedProviderEndpointKind, string] =>
        Boolean(entry[0]) &&
        Boolean(entry[2]) &&
        isPersistedProviderEndpointKind(entry[1])
    )
    .sort(([leftProvider, leftKind], [rightProvider, rightKind]) =>
      leftProvider === rightProvider
        ? leftKind.localeCompare(rightKind)
        : leftProvider.localeCompare(rightProvider)
    );
  const providerFormatEntries = Object.entries(options?.providerFormats ?? {})
    .map(([provider, format]) => [provider.trim(), format] as const)
    .filter(
      ([provider, format]) =>
        Boolean(provider) && isPersistedTransportFormat(format)
    )
    .sort(([left], [right]) => left.localeCompare(right));
  if (unique.length === 0) {
    throw new Error("Cannot save empty model list");
  }

  const normalizedDefault = unique.includes(defaultModel)
    ? defaultModel
    : unique[0];
  const normalizedLastUsed =
    options?.lastUsedModel && unique.includes(options.lastUsedModel)
      ? options.lastUsedModel
      : normalizedDefault;

  const lines = [
    "# Auto-generated by /model refresh",
    `default_model: ${normalizedDefault}`,
    `last_used_model: ${normalizedLastUsed}`,
    ...(options?.providerBaseUrl
      ? [`provider_base_url: ${options.providerBaseUrl}`]
      : []),
    ...(uniqueProviders.length > 0
      ? ["providers:", ...uniqueProviders.map(provider => `  - ${provider}`)]
      : []),
    ...(providerProfileEntries.length > 0
      ? [
          "provider_profiles:",
          ...providerProfileEntries.flatMap(([provider, profile]) => [
            `  - provider: ${provider}`,
            `    profile: ${profile}`,
          ]),
        ]
      : []),
    ...(providerTypeEntries.length > 0
      ? [
          "provider_types:",
          ...providerTypeEntries.flatMap(([provider, type]) => [
            `  - provider: ${provider}`,
            `    type: ${type}`,
          ]),
        ]
      : []),
    ...(providerModelModeEntries.length > 0
      ? [
          "provider_model_modes:",
          ...providerModelModeEntries.flatMap(([provider, mode]) => [
            `  - provider: ${provider}`,
            `    mode: ${mode}`,
          ]),
        ]
      : []),
    ...(providerFormatEntries.length > 0
      ? [
          "provider_formats:",
          ...providerFormatEntries.flatMap(([provider, format]) => [
            `  - provider: ${provider}`,
            `    format: ${format}`,
          ]),
        ]
      : []),
    ...(providerEndpointEntries.length > 0
      ? [
          "provider_endpoints:",
          ...providerEndpointEntries.flatMap(([provider, kind, endpoint]) => [
            `  - provider: ${provider}`,
            `    kind: ${kind}`,
            `    endpoint: ${endpoint}`,
          ]),
        ]
      : []),
    ...(providerNameEntries.length > 0
      ? [
          "provider_names:",
          ...providerNameEntries.flatMap(([provider, name]) => [
            `  - provider: ${provider}`,
            `    name: ${name}`,
          ]),
        ]
      : []),
    "models:",
    ...unique.map(model => `  - ${model}`),
    "",
  ];

  await ensureModelDir(appRoot, context);
  await writeFile(getModelFile(appRoot, context), lines.join("\n"), "utf8");
};
