import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = {
  pinMaxCount: 6,
  queryMaxToolSteps: 19200,
  autoSummaryRefresh: true,
  requestTemperature: 0.2,
};

const PROVIDER_ALIASES = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  anthropic: "https://api.anthropic.com",
  claude: "https://api.anthropic.com",
};

const PROVIDER_DISPLAY_NAMES = {
  openai: "OpenAI",
  gemini: "Gemini",
  anthropic: "Anthropic",
  custom: "Custom",
};

const MANUAL_PROVIDER_PROFILES = new Set(["openai", "gemini", "anthropic"]);
const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE_PATH = /^\\\\[^\\]/;
const DEFAULT_INITIAL_MODEL = "gpt-4o-mini";
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const trimNonEmpty = value => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
};

const isWindowsStyleAbsolutePath = value =>
  WINDOWS_DRIVE_ABSOLUTE_PATH.test(value) || WINDOWS_UNC_ABSOLUTE_PATH.test(value);

const effectivePlatform = platform => platform ?? process.platform;

const pathApiForPlatform = platform =>
  effectivePlatform(platform) === "win32" ? win32 : posix;

const joinCyreneDir = (homeDir, platform) => {
  if (effectivePlatform(platform) === "win32") {
    const trimmed = homeDir.replace(/[\\/]+$/, "");
    const separator = trimmed.includes("/") ? "/" : "\\";
    return `${trimmed}${separator}.cyrene`;
  }
  return posix.join(homeDir, ".cyrene");
};

const resolveHomeFromEnv = (env, platform = process.platform) => {
  if (platform !== "win32") {
    const home = trimNonEmpty(env.HOME);
    if (home) {
      return home;
    }
  }

  const userProfile = trimNonEmpty(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }

  const home = trimNonEmpty(env.HOME);
  if (home) {
    return home;
  }

  const homeDrive = trimNonEmpty(env.HOMEDRIVE);
  const homePath = trimNonEmpty(env.HOMEPATH);
  if (homeDrive && homePath) {
    return `${homeDrive}${homePath}`;
  }

  return undefined;
};

const resolveUserHomeDir = ({ cwd, env, platform }) => {
  const fallbackCwd = cwd ?? process.cwd();
  const fallbackEnv = env ?? process.env;
  const envHome = resolveHomeFromEnv(fallbackEnv, platform);
  if (!envHome) {
    return homedir();
  }

  const pathApi = pathApiForPlatform(platform);
  if (isWindowsStyleAbsolutePath(envHome)) {
    return envHome;
  }
  if (isAbsolute(envHome)) {
    return pathApi.resolve(envHome);
  }
  return pathApi.resolve(fallbackCwd, envHome);
};

const parseRootArg = argv => {
  for (let index = 0; index < argv.length; index += 1) {
    const token = trimNonEmpty(argv[index]);
    if (!token) {
      continue;
    }
    if (token === "--root" || token === "-r") {
      return trimNonEmpty(argv[index + 1]);
    }
    if (token.startsWith("--root=")) {
      return trimNonEmpty(token.slice("--root=".length));
    }
  }
  return undefined;
};

const resolveAppRoot = ({ argv, cwd, env }) => {
  const resolvedCwd = cwd ?? process.cwd();
  const cliRoot = parseRootArg(argv ?? []);
  const envRoot = trimNonEmpty((env ?? process.env).CYRENE_ROOT);
  return resolve(resolvedCwd, cliRoot ?? envRoot ?? ".");
};

const getLegacyProjectCyreneDir = appRoot => join(appRoot, ".cyrene");

const getCyreneConfigDir = ({ cwd, env, platform }) => {
  const resolvedCwd = cwd ?? process.cwd();
  const resolvedEnv = env ?? process.env;
  const pathApi = pathApiForPlatform(platform);
  const explicitCyreneHome = trimNonEmpty(resolvedEnv.CYRENE_HOME);
  if (explicitCyreneHome) {
    if (isWindowsStyleAbsolutePath(explicitCyreneHome)) {
      return explicitCyreneHome;
    }
    if (isAbsolute(explicitCyreneHome)) {
      return pathApi.resolve(explicitCyreneHome);
    }
    return pathApi.resolve(resolvedCwd, explicitCyreneHome);
  }
  return joinCyreneDir(
    resolveUserHomeDir({ cwd: resolvedCwd, env: resolvedEnv, platform }),
    platform
  );
};

const defaultPathExists = async path => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const defaultReadText = async path => readFile(path, "utf8");
const defaultWriteText = async (path, content) => writeFile(path, content, "utf8");
const defaultMkdirp = async path => mkdir(path, { recursive: true });

const parseScalar = value =>
  value.replace(/^["']/, "").replace(/["']$/, "").trim();

const parseConfigValue = raw => {
  const trimmed = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }
  const quoted = trimmed.match(/^"(.*)"$/) ?? trimmed.match(/^'(.*)'$/);
  if (quoted) {
    return quoted[1] ?? "";
  }
  return trimmed;
};

const readFirstExistingFile = async (paths, runtime) => {
  for (const path of paths) {
    try {
      return {
        path,
        content: await runtime.readText(path),
      };
    } catch {
      // Try the next location.
    }
  }
  return null;
};

const parseCyreneConfigContent = content => {
  if (!content?.trim()) {
    return {};
  }

  const map = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    map.set(key, parseConfigValue(value));
  }

  const parsed = {};
  const pinRaw = map.get("pin_max_count");
  if (typeof pinRaw === "number" && pinRaw > 0) {
    parsed.pinMaxCount = Math.floor(pinRaw);
  }

  const queryMaxToolStepsRaw = map.get("query_max_tool_steps");
  if (typeof queryMaxToolStepsRaw === "number" && queryMaxToolStepsRaw > 0) {
    parsed.queryMaxToolSteps = Math.floor(queryMaxToolStepsRaw);
  }

  const autoSummaryRefreshRaw = map.get("auto_summary_refresh");
  if (typeof autoSummaryRefreshRaw === "boolean") {
    parsed.autoSummaryRefresh = autoSummaryRefreshRaw;
  }

  const requestTemperatureRaw = map.get("request_temperature");
  if (
    typeof requestTemperatureRaw === "number" &&
    Number.isFinite(requestTemperatureRaw)
  ) {
    parsed.requestTemperature = Math.min(2, Math.max(0, requestTemperatureRaw));
  }

  const systemPromptRaw = map.get("system_prompt");
  if (
    typeof systemPromptRaw === "string" &&
    trimNonEmpty(systemPromptRaw)
  ) {
    parsed.systemPrompt = systemPromptRaw.trim();
  }

  return parsed;
};

const normalizeProviderAlias = value => {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    throw new Error("Provider cannot be empty.");
  }
  const alias = PROVIDER_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
};

const normalizeProviderBaseUrl = value => {
  const candidate = normalizeProviderAlias(value);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Provider must be a valid URL or one of: openai, gemini, anthropic."
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https.");
  }
  return parsed.toString().replace(/\/+$/, "");
};

const inferProviderProfile = provider => {
  const normalized = normalizeProviderBaseUrl(provider);
  const host = new URL(normalized).hostname.toLowerCase();
  if (host.includes("anthropic.com")) {
    return "anthropic";
  }
  if (host.includes("generativelanguage.googleapis.com")) {
    return "gemini";
  }
  return "openai";
};

const formatProviderDisplayName = (provider, name) => {
  const trimmedName = trimNonEmpty(name);
  if (trimmedName) {
    return trimmedName;
  }
  try {
    const profile = inferProviderProfile(provider);
    return PROVIDER_DISPLAY_NAMES[profile] ?? provider;
  } catch {
    return provider;
  }
};

const formatPreview = (value, maxLength = 96) => {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return "(none)";
  }
  const compact = trimmed.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
};

const formatRows = rows =>
  rows.map(([label, value]) => `${label.padEnd(20)} ${value}`).join("\n");

const writeStdout = (runtime, text = "") => {
  runtime.stdout.write(`${text}\n`);
};

const writeStderr = (runtime, text = "") => {
  runtime.stderr.write(`${text}\n`);
};

const readPackageVersion = async runtime => {
  try {
    const content = await runtime.readText(join(runtime.packageRoot, "package.json"));
    const parsed = JSON.parse(content);
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const getConfigPaths = runtime => {
  const appRoot = resolveAppRoot(runtime);
  const configHome = getCyreneConfigDir({
    cwd: appRoot,
    env: runtime.env,
    platform: runtime.platform,
  });
  const legacyHome = getLegacyProjectCyreneDir(appRoot);
  return {
    appRoot,
    configHome,
    legacyHome,
    configFile: join(configHome, "config.yaml"),
    legacyConfigFile: join(legacyHome, "config.yaml"),
    modelFile: join(configHome, "model.yaml"),
    legacyModelFile: join(legacyHome, "model.yaml"),
    globalPromptFile: join(configHome, ".cyrene.md"),
    legacyPromptFile: join(legacyHome, ".cyrene.md"),
    sessionDir: join(configHome, "session"),
  };
};

const loadCyreneConfig = async runtime => {
  const paths = getConfigPaths(runtime);
  const globalConfig = await readFirstExistingFile([paths.configFile], runtime);
  const projectConfig = await readFirstExistingFile([paths.legacyConfigFile], runtime);

  return {
    path: projectConfig?.path ?? globalConfig?.path ?? null,
    config: {
      ...DEFAULT_CONFIG,
      ...parseCyreneConfigContent(globalConfig?.content ?? ""),
      ...parseCyreneConfigContent(projectConfig?.content ?? ""),
    },
  };
};

const loadPromptPolicy = async (configResult, runtime) => {
  const paths = getConfigPaths(runtime);
  const loadedProjectPrompt = await readFirstExistingFile(
    [paths.legacyPromptFile, paths.globalPromptFile],
    runtime
  );
  const envPrompt = trimNonEmpty(runtime.env.CYRENE_SYSTEM_PROMPT);
  const configPrompt = trimNonEmpty(configResult.config.systemPrompt);

  return {
    systemPrompt:
      configPrompt ??
      envPrompt ??
      "You are Cyrene CLI assistant. Be concise, accurate, and execution-focused.",
    systemPromptSource: configPrompt
      ? "config.yaml"
      : envPrompt
        ? "CYRENE_SYSTEM_PROMPT"
        : "default",
    projectPrompt: trimNonEmpty(loadedProjectPrompt?.content)?.trim() ?? "",
    projectPromptPath: loadedProjectPrompt?.path ?? null,
  };
};

const loadModelCatalog = async runtime => {
  const paths = getConfigPaths(runtime);
  const loaded = await readFirstExistingFile(
    [paths.modelFile, paths.legacyModelFile],
    runtime
  );
  if (!loaded) {
    return {
      path: null,
      editablePath: paths.modelFile,
      catalog: null,
    };
  }

  const models = [];
  const providers = [];
  const providerProfiles = {};
  const providerNames = {};
  let defaultModel;
  let lastUsedModel;
  let providerBaseUrl;
  let section = "root";
  let pendingProviderProfile = null;
  let pendingProviderName = null;

  const flushPendingProviderProfile = () => {
    if (
      pendingProviderProfile?.provider &&
      pendingProviderProfile?.profile &&
      trimNonEmpty(pendingProviderProfile.provider)
    ) {
      providerProfiles[pendingProviderProfile.provider.trim()] =
        pendingProviderProfile.profile;
    }
    pendingProviderProfile = null;
  };

  const flushPendingProviderName = () => {
    if (
      pendingProviderName?.provider &&
      pendingProviderName?.name &&
      trimNonEmpty(pendingProviderName.provider) &&
      trimNonEmpty(pendingProviderName.name)
    ) {
      providerNames[pendingProviderName.provider.trim()] =
        pendingProviderName.name.trim();
    }
    pendingProviderName = null;
  };

  for (const raw of loaded.content.split(/\r?\n/)) {
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
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "models";
      continue;
    }
    if (line === "providers:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "providers";
      continue;
    }
    if (line === "provider_profiles:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
      } else if (section === "provider_names") {
        flushPendingProviderName();
      }
      section = "provider_profiles";
      continue;
    }
    if (line === "provider_names:") {
      if (section === "provider_profiles") {
        flushPendingProviderProfile();
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
          const profile = parseScalar(rawEntry.slice("profile:".length)).toLowerCase();
          pendingProviderProfile = MANUAL_PROVIDER_PROFILES.has(profile)
            ? { profile }
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
        const profile = parseScalar(line.slice("profile:".length)).toLowerCase();
        pendingProviderProfile = {
          ...(pendingProviderProfile ?? {}),
          ...(MANUAL_PROVIDER_PROFILES.has(profile) ? { profile } : {}),
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
  } else if (section === "provider_names") {
    flushPendingProviderName();
  }

  if (models.length === 0) {
    throw new Error(`model catalog has no models: ${loaded.path}`);
  }

  return {
    path: loaded.path,
    editablePath: paths.modelFile,
    catalog: {
      models,
      defaultModel,
      lastUsedModel,
      providerBaseUrl,
      providers,
      providerProfiles,
      providerNames,
    },
  };
};

const saveModelCatalog = async (catalog, runtime) => {
  const paths = getConfigPaths(runtime);
  const uniqueModels = Array.from(
    new Set((catalog.models ?? []).map(model => model.trim()))
  ).filter(Boolean);
  if (uniqueModels.length === 0) {
    throw new Error("Cannot save empty model list.");
  }

  const uniqueProviders = Array.from(
    new Set((catalog.providers ?? []).map(provider => provider.trim()))
  ).filter(Boolean);
  const providerProfileEntries = Object.entries(catalog.providerProfiles ?? {})
    .map(([provider, profile]) => [provider.trim(), profile] )
    .filter(([provider, profile]) => Boolean(provider) && MANUAL_PROVIDER_PROFILES.has(profile))
    .sort(([left], [right]) => left.localeCompare(right));
  const providerNameEntries = Object.entries(catalog.providerNames ?? {})
    .map(([provider, name]) => [provider.trim(), name.trim()])
    .filter(([provider, name]) => Boolean(provider) && Boolean(name))
    .sort(([left], [right]) => left.localeCompare(right));
  const normalizedDefault = uniqueModels.includes(catalog.defaultModel)
    ? catalog.defaultModel
    : uniqueModels[0];
  const normalizedLastUsed =
    catalog.lastUsedModel && uniqueModels.includes(catalog.lastUsedModel)
      ? catalog.lastUsedModel
      : normalizedDefault;

  const lines = [
    "# Managed by Cyrene CLI",
    `default_model: ${normalizedDefault}`,
    `last_used_model: ${normalizedLastUsed}`,
    ...(trimNonEmpty(catalog.providerBaseUrl)
      ? [`provider_base_url: ${catalog.providerBaseUrl}`]
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
    ...uniqueModels.map(model => `  - ${model}`),
    "",
  ];

  await runtime.mkdirp(dirname(paths.modelFile));
  await runtime.writeText(paths.modelFile, lines.join("\n"));
  return paths.modelFile;
};

const seedCatalogForProviderMutation = (providerBaseUrl, runtime) => ({
  models: [trimNonEmpty(runtime.env.CYRENE_MODEL) ?? DEFAULT_INITIAL_MODEL],
  defaultModel: trimNonEmpty(runtime.env.CYRENE_MODEL) ?? DEFAULT_INITIAL_MODEL,
  lastUsedModel: trimNonEmpty(runtime.env.CYRENE_MODEL) ?? DEFAULT_INITIAL_MODEL,
  providerBaseUrl:
    trimNonEmpty(runtime.env.CYRENE_BASE_URL) ?? providerBaseUrl,
  providers: [providerBaseUrl],
  providerProfiles: {},
  providerNames: {},
});

const buildPathsSnapshot = async runtime => {
  const paths = getConfigPaths(runtime);
  return {
    appRoot: paths.appRoot,
    configHome: paths.configHome,
    legacyHome: paths.legacyHome,
    configFile: paths.configFile,
    configFileExists: await runtime.pathExists(paths.configFile),
    legacyConfigFile: paths.legacyConfigFile,
    legacyConfigFileExists: await runtime.pathExists(paths.legacyConfigFile),
    modelFile: paths.modelFile,
    modelFileExists: await runtime.pathExists(paths.modelFile),
    legacyModelFile: paths.legacyModelFile,
    legacyModelFileExists: await runtime.pathExists(paths.legacyModelFile),
    globalPromptFile: paths.globalPromptFile,
    globalPromptFileExists: await runtime.pathExists(paths.globalPromptFile),
    legacyPromptFile: paths.legacyPromptFile,
    legacyPromptFileExists: await runtime.pathExists(paths.legacyPromptFile),
    sessionDir: paths.sessionDir,
    sessionDirExists: await runtime.pathExists(paths.sessionDir),
  };
};

const buildConfigSnapshot = async runtime => {
  const paths = await buildPathsSnapshot(runtime);
  const configResult = await loadCyreneConfig(runtime);
  const promptPolicy = await loadPromptPolicy(configResult, runtime);
  const modelCatalogResult = await loadModelCatalog(runtime);
  const runtimeProvider = trimNonEmpty(runtime.env.CYRENE_BASE_URL)
    ? normalizeProviderBaseUrl(runtime.env.CYRENE_BASE_URL)
    : trimNonEmpty(modelCatalogResult.catalog?.providerBaseUrl) ?? null;
  const runtimeModel =
    trimNonEmpty(runtime.env.CYRENE_MODEL) ??
    trimNonEmpty(modelCatalogResult.catalog?.lastUsedModel) ??
    trimNonEmpty(modelCatalogResult.catalog?.defaultModel) ??
    null;

  return {
    paths,
    configFile: configResult.path,
    config: configResult.config,
    promptPolicy: {
      systemPrompt: promptPolicy.systemPrompt,
      systemPromptSource: promptPolicy.systemPromptSource,
      projectPromptPath: promptPolicy.projectPromptPath,
      projectPromptLength: promptPolicy.projectPrompt.length,
    },
    runtimeSelection: {
      provider: runtimeProvider,
      providerSource: trimNonEmpty(runtime.env.CYRENE_BASE_URL)
        ? "CYRENE_BASE_URL"
        : modelCatalogResult.catalog?.providerBaseUrl
          ? "model.yaml"
          : "none",
      model: runtimeModel,
      modelSource: trimNonEmpty(runtime.env.CYRENE_MODEL)
        ? "CYRENE_MODEL"
        : modelCatalogResult.catalog?.lastUsedModel || modelCatalogResult.catalog?.defaultModel
          ? "model.yaml"
          : "none",
    },
    modelCatalogPath: modelCatalogResult.path,
  };
};

const buildProviderSnapshot = async runtime => {
  const modelCatalogResult = await loadModelCatalog(runtime);
  const catalog = modelCatalogResult.catalog;
  const runtimeProvider = trimNonEmpty(runtime.env.CYRENE_BASE_URL)
    ? normalizeProviderBaseUrl(runtime.env.CYRENE_BASE_URL)
    : trimNonEmpty(catalog?.providerBaseUrl) ?? null;
  const runtimeModel =
    trimNonEmpty(runtime.env.CYRENE_MODEL) ??
    trimNonEmpty(catalog?.lastUsedModel) ??
    trimNonEmpty(catalog?.defaultModel) ??
    null;

  const providerUniverse = Array.from(
    new Set(
      [
        ...(catalog?.providers ?? []),
        trimNonEmpty(catalog?.providerBaseUrl),
        runtimeProvider,
      ].filter(Boolean)
    )
  )
    .map(provider => normalizeProviderBaseUrl(provider))
    .sort((left, right) => left.localeCompare(right));

  const providers = providerUniverse.map(provider => {
    const manualProfile = catalog?.providerProfiles?.[provider];
    const inferredProfile = inferProviderProfile(provider);
    return {
      provider,
      name: trimNonEmpty(catalog?.providerNames?.[provider]) ?? null,
      displayName: formatProviderDisplayName(provider, catalog?.providerNames?.[provider]),
      profile: manualProfile ?? inferredProfile,
      profileSource: manualProfile ? "manual" : "inferred",
      current: runtimeProvider === provider,
    };
  });

  return {
    modelCatalogPath: modelCatalogResult.path,
    editableModelCatalogPath: modelCatalogResult.editablePath,
    runtimeProvider,
    runtimeProviderSource: trimNonEmpty(runtime.env.CYRENE_BASE_URL)
      ? "CYRENE_BASE_URL"
      : catalog?.providerBaseUrl
        ? "model.yaml"
        : "none",
    runtimeModel,
    runtimeModelSource: trimNonEmpty(runtime.env.CYRENE_MODEL)
      ? "CYRENE_MODEL"
      : catalog?.lastUsedModel || catalog?.defaultModel
        ? "model.yaml"
        : "none",
    providers,
    providerCount: providers.length,
  };
};

const buildHelpText = version => [
  `Cyrene CLI ${version}`,
  "",
  "Usage:",
  "  cyrene [--root <path>]",
  "  cyrene paths [--json] [--root <path>]",
  "  cyrene config [show] [--json] [--root <path>]",
  "  cyrene provider list [--json] [--root <path>]",
  "  cyrene provider name set <provider> <display_name> [--root <path>]",
  "  cyrene provider name clear <provider> [--root <path>]",
  "  cyrene provider profile set <provider> <openai|gemini|anthropic> [--root <path>]",
  "  cyrene provider profile clear <provider> [--root <path>]",
  "  cyrene version",
  "",
  "Flags:",
  "  --root, -r   override workspace root",
  "  --json       print machine-readable JSON",
  "  --help, -h   show this help",
  "  --version    show the CLI version",
  "",
  "Notes:",
  "  `cyrene` without a subcommand launches the Bubble Tea TUI.",
  "  `provider` also accepts `providers` as an alias.",
].join("\n");

const buildRuntime = options => ({
  argv: options?.argv ?? [],
  cwd: options?.cwd ?? process.cwd(),
  env: options?.env ?? process.env,
  platform: options?.platform ?? process.platform,
  stdout: options?.stdout ?? process.stdout,
  stderr: options?.stderr ?? process.stderr,
  pathExists: options?.pathExists ?? defaultPathExists,
  readText: options?.readText ?? defaultReadText,
  writeText: options?.writeText ?? defaultWriteText,
  mkdirp: options?.mkdirp ?? defaultMkdirp,
  packageRoot: options?.packageRoot ?? PACKAGE_ROOT,
});

export const parseCyreneCliArgs = argv => {
  let json = false;
  let help = false;
  let version = false;
  const commandArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      version = true;
      continue;
    }
    if (token === "--root" || token === "-r") {
      index += 1;
      continue;
    }
    if (typeof token === "string" && token.startsWith("--root=")) {
      continue;
    }
    commandArgs.push(token);
  }

  return {
    json,
    help,
    version,
    commandArgs,
  };
};

const printJson = (runtime, value) => {
  writeStdout(runtime, JSON.stringify(value, null, 2));
};

const printPaths = async runtime => {
  const snapshot = await buildPathsSnapshot(runtime);
  if (parseCyreneCliArgs(runtime.argv).json) {
    printJson(runtime, snapshot);
    return 0;
  }

  writeStdout(
    runtime,
    formatRows([
      ["app_root", snapshot.appRoot],
      ["config_home", snapshot.configHome],
      ["legacy_home", snapshot.legacyHome],
      [
        "config_yaml",
        `${snapshot.configFile}${snapshot.configFileExists ? "" : " (missing)"}`,
      ],
      [
        "legacy_config_yaml",
        `${snapshot.legacyConfigFile}${snapshot.legacyConfigFileExists ? "" : " (missing)"}`,
      ],
      [
        "model_yaml",
        `${snapshot.modelFile}${snapshot.modelFileExists ? "" : " (missing)"}`,
      ],
      [
        "legacy_model_yaml",
        `${snapshot.legacyModelFile}${snapshot.legacyModelFileExists ? "" : " (missing)"}`,
      ],
      [
        "global_prompt",
        `${snapshot.globalPromptFile}${snapshot.globalPromptFileExists ? "" : " (missing)"}`,
      ],
      [
        "legacy_prompt",
        `${snapshot.legacyPromptFile}${snapshot.legacyPromptFileExists ? "" : " (missing)"}`,
      ],
      [
        "session_dir",
        `${snapshot.sessionDir}${snapshot.sessionDirExists ? "" : " (missing)"}`,
      ],
    ])
  );
  return 0;
};

const printConfig = async runtime => {
  const snapshot = await buildConfigSnapshot(runtime);
  if (parseCyreneCliArgs(runtime.argv).json) {
    printJson(runtime, snapshot);
    return 0;
  }

  writeStdout(runtime, "effective config");
  writeStdout(
    runtime,
    formatRows([
      ["app_root", snapshot.paths.appRoot],
      ["config_file", snapshot.configFile ?? "(default values)"],
      ["pin_max_count", String(snapshot.config.pinMaxCount)],
      ["query_max_steps", String(snapshot.config.queryMaxToolSteps)],
      ["auto_summary", String(snapshot.config.autoSummaryRefresh)],
      ["temperature", String(snapshot.config.requestTemperature)],
      ["system_prompt", snapshot.promptPolicy.systemPromptSource],
      ["system_preview", formatPreview(snapshot.promptPolicy.systemPrompt)],
      [
        "project_prompt",
        snapshot.promptPolicy.projectPromptPath
          ? `${snapshot.promptPolicy.projectPromptPath} (${snapshot.promptPolicy.projectPromptLength} chars)`
          : "(none)",
      ],
      [
        "runtime_provider",
        snapshot.runtimeSelection.provider
          ? `${snapshot.runtimeSelection.provider} (${snapshot.runtimeSelection.providerSource})`
          : "(none)",
      ],
      [
        "runtime_model",
        snapshot.runtimeSelection.model
          ? `${snapshot.runtimeSelection.model} (${snapshot.runtimeSelection.modelSource})`
          : "(none)",
      ],
      ["model_catalog", snapshot.modelCatalogPath ?? "(missing)"],
    ])
  );
  return 0;
};

const printProviders = async runtime => {
  const snapshot = await buildProviderSnapshot(runtime);
  if (parseCyreneCliArgs(runtime.argv).json) {
    printJson(runtime, snapshot);
    return 0;
  }

  writeStdout(runtime, "provider catalog");
  writeStdout(
    runtime,
    formatRows([
      [
        "runtime_provider",
        snapshot.runtimeProvider
          ? `${snapshot.runtimeProvider} (${snapshot.runtimeProviderSource})`
          : "(none)",
      ],
      [
        "runtime_model",
        snapshot.runtimeModel
          ? `${snapshot.runtimeModel} (${snapshot.runtimeModelSource})`
          : "(none)",
      ],
      ["model_catalog", snapshot.modelCatalogPath ?? "(missing)"],
      ["provider_count", String(snapshot.providerCount)],
    ])
  );

  if (snapshot.providers.length === 0) {
    writeStdout(runtime, "");
    writeStdout(runtime, "(no persisted providers)");
    return 0;
  }

  writeStdout(runtime, "");
  for (const provider of snapshot.providers) {
    writeStdout(
      runtime,
      formatRows([
        [
          provider.current ? "provider *" : "provider",
          `${provider.displayName}  |  ${provider.provider}`,
        ],
        ["name", provider.name ?? "(none)"],
        ["profile", `${provider.profile} (${provider.profileSource})`],
      ])
    );
    writeStdout(runtime, "");
  }

  return 0;
};

const mutateProviderMetadata = async (runtime, mutation) => {
  const modelCatalogResult = await loadModelCatalog(runtime);
  const nextCatalog = modelCatalogResult.catalog
    ? {
        models: [...modelCatalogResult.catalog.models],
        defaultModel: modelCatalogResult.catalog.defaultModel,
        lastUsedModel: modelCatalogResult.catalog.lastUsedModel,
        providerBaseUrl: modelCatalogResult.catalog.providerBaseUrl,
        providers: [...modelCatalogResult.catalog.providers],
        providerProfiles: { ...modelCatalogResult.catalog.providerProfiles },
        providerNames: { ...modelCatalogResult.catalog.providerNames },
      }
    : seedCatalogForProviderMutation(mutation.provider, runtime);

  const providerSet = new Set(nextCatalog.providers);
  providerSet.add(mutation.provider);
  nextCatalog.providers = Array.from(providerSet).sort((left, right) =>
    left.localeCompare(right)
  );

  mutation.apply(nextCatalog);
  if (!trimNonEmpty(nextCatalog.providerBaseUrl)) {
    nextCatalog.providerBaseUrl = mutation.provider;
  }

  const savedPath = await saveModelCatalog(nextCatalog, runtime);
  return {
    createdCatalog: !modelCatalogResult.catalog,
    savedPath,
  };
};

const runProviderCommand = async (runtime, args) => {
  if (args.length === 0 || args[0] === "list") {
    return printProviders(runtime);
  }

  const section = args[0];
  if (section === "name") {
    const action = args[1];
    if (action === "set") {
      const rawProvider = args[2];
      const displayName = args.slice(3).join(" ").trim();
      if (!trimNonEmpty(rawProvider) || !trimNonEmpty(displayName)) {
        writeStderr(
          runtime,
          "Usage: cyrene provider name set <provider> <display_name>"
        );
        return 1;
      }
      const provider = normalizeProviderBaseUrl(rawProvider);
      const result = await mutateProviderMetadata(runtime, {
        provider,
        apply: catalog => {
          catalog.providerNames[provider] = displayName;
        },
      });
      writeStdout(
        runtime,
        formatRows([
          ["status", "provider name saved"],
          ["provider", provider],
          ["name", displayName],
          ["model_catalog", result.savedPath],
          ["created_catalog", String(result.createdCatalog)],
        ])
      );
      return 0;
    }
    if (action === "clear") {
      const rawProvider = args[2];
      if (!trimNonEmpty(rawProvider)) {
        writeStderr(runtime, "Usage: cyrene provider name clear <provider>");
        return 1;
      }
      const provider = normalizeProviderBaseUrl(rawProvider);
      const modelCatalogResult = await loadModelCatalog(runtime);
      if (!modelCatalogResult.catalog) {
        writeStderr(runtime, "No model catalog found. Nothing to clear.");
        return 1;
      }
      const result = await mutateProviderMetadata(runtime, {
        provider,
        apply: catalog => {
          delete catalog.providerNames[provider];
        },
      });
      writeStdout(
        runtime,
        formatRows([
          ["status", "provider name cleared"],
          ["provider", provider],
          ["model_catalog", result.savedPath],
        ])
      );
      return 0;
    }
  }

  if (section === "profile") {
    const action = args[1];
    if (action === "set") {
      const rawProvider = args[2];
      const profile = args[3]?.toLowerCase();
      if (!trimNonEmpty(rawProvider) || !MANUAL_PROVIDER_PROFILES.has(profile)) {
        writeStderr(
          runtime,
          "Usage: cyrene provider profile set <provider> <openai|gemini|anthropic>"
        );
        return 1;
      }
      const provider = normalizeProviderBaseUrl(rawProvider);
      const result = await mutateProviderMetadata(runtime, {
        provider,
        apply: catalog => {
          catalog.providerProfiles[provider] = profile;
        },
      });
      writeStdout(
        runtime,
        formatRows([
          ["status", "provider profile saved"],
          ["provider", provider],
          ["profile", profile],
          ["model_catalog", result.savedPath],
          ["created_catalog", String(result.createdCatalog)],
        ])
      );
      return 0;
    }
    if (action === "clear") {
      const rawProvider = args[2];
      if (!trimNonEmpty(rawProvider)) {
        writeStderr(runtime, "Usage: cyrene provider profile clear <provider>");
        return 1;
      }
      const provider = normalizeProviderBaseUrl(rawProvider);
      const modelCatalogResult = await loadModelCatalog(runtime);
      if (!modelCatalogResult.catalog) {
        writeStderr(runtime, "No model catalog found. Nothing to clear.");
        return 1;
      }
      const result = await mutateProviderMetadata(runtime, {
        provider,
        apply: catalog => {
          delete catalog.providerProfiles[provider];
        },
      });
      writeStdout(
        runtime,
        formatRows([
          ["status", "provider profile cleared"],
          ["provider", provider],
          ["model_catalog", result.savedPath],
        ])
      );
      return 0;
    }
  }

  writeStderr(
    runtime,
    "Usage: cyrene provider list | provider name set|clear | provider profile set|clear"
  );
  return 1;
};

export const handleCyreneCli = async (argv, options) => {
  const runtime = buildRuntime({
    ...options,
    argv,
  });
  const parsed = parseCyreneCliArgs(argv);
  const version = await readPackageVersion(runtime);

  if (parsed.help) {
    writeStdout(runtime, buildHelpText(version));
    return {
      kind: "handled",
      exitCode: 0,
    };
  }

  if (parsed.version && parsed.commandArgs.length === 0) {
    writeStdout(runtime, version);
    return {
      kind: "handled",
      exitCode: 0,
    };
  }

  if (parsed.commandArgs.length === 0) {
    return {
      kind: "launch",
      args: argv,
    };
  }

  const [command, ...rest] = parsed.commandArgs;

  try {
    switch (command) {
      case "help":
        writeStdout(runtime, buildHelpText(version));
        return { kind: "handled", exitCode: 0 };
      case "version":
        writeStdout(runtime, version);
        return { kind: "handled", exitCode: 0 };
      case "paths":
        return { kind: "handled", exitCode: await printPaths(runtime) };
      case "config":
        if (rest.length === 0 || rest[0] === "show") {
          return { kind: "handled", exitCode: await printConfig(runtime) };
        }
        writeStderr(runtime, "Usage: cyrene config [show] [--json]");
        return { kind: "handled", exitCode: 1 };
      case "provider":
      case "providers":
        return { kind: "handled", exitCode: await runProviderCommand(runtime, rest) };
      default:
        writeStderr(runtime, `Unknown command: ${command}`);
        writeStderr(runtime, "");
        writeStderr(runtime, buildHelpText(version));
        return { kind: "handled", exitCode: 1 };
    }
  } catch (error) {
    writeStderr(
      runtime,
      error instanceof Error ? error.message : String(error)
    );
    return {
      kind: "handled",
      exitCode: 1,
    };
  }
};
