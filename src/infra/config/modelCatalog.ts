import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

const isPersistedProviderProfile = (
  value: string
): value is PersistedProviderProfile =>
  value === "openai" || value === "gemini" || value === "anthropic";

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
}> => {
  const content = await readModelFile(appRoot, context);
  const models: string[] = [];
  const providers: string[] = [];
  const providerProfiles: Record<string, PersistedProviderProfile> = {};
  let defaultModel: string | undefined;
  let lastUsedModel: string | undefined;
  let providerBaseUrl: string | undefined;
  let section: "root" | "models" | "providers" | "provider_profiles" = "root";
  let pendingProviderProfile:
    | {
        provider?: string;
        profile?: PersistedProviderProfile;
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
      }
      section = "models";
      continue;
    }
    if (line === "providers:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      }
      section = "providers";
      continue;
    }
    if (line === "provider_profiles:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      }
      section = "provider_profiles";
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
          pendingProviderProfile = isPersistedProviderProfile(profileCandidate)
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
          ...(isPersistedProviderProfile(profileCandidate)
            ? { profile: profileCandidate }
            : {}),
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
        Boolean(provider) && isPersistedProviderProfile(profile)
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
    "models:",
    ...unique.map(model => `  - ${model}`),
    "",
  ];

  await ensureModelDir(appRoot, context);
  await writeFile(getModelFile(appRoot, context), lines.join("\n"), "utf8");
};
