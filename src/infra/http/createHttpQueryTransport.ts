import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  inferProviderType,
  isManualProviderProfile,
  isProviderEndpointKind,
  isTransportFormat,
  isProviderType,
  normalizeProviderBaseUrl,
  parseProviderBaseUrl,
  repairCommonSchemeTypos,
  resolveProviderFamily,
  resolveProviderTypeFamily,
  resolveProviderTypeFormat,
  safeNormalizeProviderBaseUrl,
  supportsImageAttachmentsForFormat,
  type ProviderEndpointKind,
  type ProviderEndpointOverrideEntry,
  type ProviderEndpointOverrideMap,
  type ProviderEndpointSetResult,
  type ProviderFormatOverrideMap,
  type ProviderModelCatalogMode,
  type ProviderModelCatalogModeMap,
  type ProviderNameOverrideMap,
  type ProviderFormatSetResult,
  type ProviderProfile,
  type ProviderProfileOverrideMap,
  type ProviderFamily,
  type ManualProviderProfile,
  type ProviderType,
  type ProviderTypeOverrideMap,
  type ProviderTypeSetResult,
  type QueryTransport,
  type QueryTransportStreamOptions,
  type QueryInput,
  type QueryAttachment,
  normalizeQueryInput,
  type TransportFormat,
} from "../../core/query/transport";
import type { TokenUsage } from "../../core/query/tokenUsage";
import type { McpToolDescriptor } from "../../core/mcp/runtimeTypes";
import { buildTransportToolAliasName } from "../../core/mcp/McpManager";
import { loadModelYaml, saveModelYaml } from "../config/modelCatalog";
import { resolveAmbientAppRoot, resolveUserHomeDir } from "../config/appRoot";

export { normalizeProviderBaseUrl };

const envSchema = z.object({
  CYRENE_BASE_URL: z.string().min(1).optional(),
  CYRENE_API_KEY: z.string().min(1).optional(),
  CYRENE_OPENAI_API_KEY: z.string().min(1).optional(),
  CYRENE_GEMINI_API_KEY: z.string().min(1).optional(),
  CYRENE_ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CYRENE_MODEL: z.string().min(1).optional(),
});

type EncodedImageAttachment = QueryAttachment & {
  absolutePath: string;
  data: string;
  dataUrl: string;
};

const IMAGE_ATTACHMENT_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const resolveAttachmentAbsolutePath = (attachment: QueryAttachment, appRoot: string) =>
  isAbsolute(attachment.path)
    ? resolve(attachment.path)
    : resolve(appRoot, attachment.path);

const resolveAttachmentMimeType = (attachment: QueryAttachment) => {
  const extension = extname(attachment.path).toLowerCase();
  const resolved = IMAGE_ATTACHMENT_MIME_TYPES[extension];
  if (!resolved) {
    throw new Error(
      `Unsupported image attachment type for ${attachment.path}. Supported extensions: .png, .jpg, .jpeg, .webp, .gif.`
    );
  }
  return resolved;
};

const encodeImageAttachments = async (
  attachments: QueryAttachment[],
  appRoot: string
): Promise<EncodedImageAttachment[]> =>
  await Promise.all(
    attachments.map(async attachment => {
      const absolutePath = resolveAttachmentAbsolutePath(attachment, appRoot);
      const mimeType = resolveAttachmentMimeType(attachment);
      const content = await readFile(absolutePath);
      if (content.length > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(
          `Image attachment too large: ${attachment.path}. Max size is ${MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)} MB.`
        );
      }
      const data = content.toString("base64");
      return {
        ...attachment,
        name: attachment.name?.trim() || basename(absolutePath),
        mimeType,
        absolutePath,
        data,
        dataUrl: `data:${mimeType};base64,${data}`,
      };
    })
  );

const parseSseEventData = (rawEvent: string): string[] => {
  const lines = rawEvent.split("\n");
  return lines
    .filter(line => line.startsWith("data:"))
    .map(line => line.replace(/^data:\s?/, ""));
};

type OpenAiUsageState = {
  cachedTokens?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const toNonnegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;

const extractOpenAiCachedTokens = (
  usageRecord: Record<string, unknown>
): number | undefined => {
  for (const detailsKey of [
    "prompt_tokens_details",
    "input_tokens_details",
  ]) {
    const detailsRecord = asRecord(usageRecord[detailsKey]);
    const cachedTokens = toNonnegativeInt(detailsRecord?.cached_tokens);
    if (typeof cachedTokens === "number") {
      return cachedTokens;
    }
  }

  for (const cachedKey of [
    "cached_tokens",
    "prompt_cached_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "prompt_cache_hit_tokens",
  ]) {
    const cachedTokens = toNonnegativeInt(usageRecord[cachedKey]);
    if (typeof cachedTokens === "number") {
      return cachedTokens;
    }
  }

  return undefined;
};

const resolveOpenAiCachedTokens = (
  usageRecord: Record<string, unknown>,
  state?: OpenAiUsageState
): number | undefined => {
  const cachedTokens = extractOpenAiCachedTokens(usageRecord);
  if (typeof cachedTokens === "number") {
    if (state) {
      state.cachedTokens = Math.max(state.cachedTokens ?? 0, cachedTokens);
      return state.cachedTokens;
    }
    return cachedTokens;
  }
  return state?.cachedTokens;
};

const extractUsage = (
  payload: unknown,
  state?: OpenAiUsageState
): TokenUsage | null => {
  if (!payload || typeof payload !== "object" || !("usage" in payload)) {
    return null;
  }

  const usageRecord = asRecord((payload as { usage?: unknown }).usage);
  if (!usageRecord) {
    return null;
  }

  const promptTokens = toNonnegativeInt(usageRecord.prompt_tokens);
  const completionTokens = toNonnegativeInt(usageRecord.completion_tokens);
  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number"
  ) {
    return null;
  }

  const totalTokens =
    toNonnegativeInt(usageRecord.total_tokens) ?? promptTokens + completionTokens;
  const cachedTokens = resolveOpenAiCachedTokens(usageRecord, state);
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    totalTokens,
  };
};

const buildUsageSignature = (usage: TokenUsage) =>
  `${usage.promptTokens}:${usage.cachedTokens ?? 0}:${usage.completionTokens}:${usage.totalTokens}`;

const extractUsageEvent = (payload: unknown, state?: OpenAiUsageState) => {
  const usage = extractUsage(payload, state);
  if (!usage) {
    return null;
  }

  return {
    usage,
    event: JSON.stringify({
      type: "usage",
      promptTokens: usage.promptTokens,
      ...(typeof usage.cachedTokens === "number"
        ? { cachedTokens: usage.cachedTokens }
        : {}),
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    }),
  };
};

type OpenAiPromptCacheRetention = "in_memory" | "24h";

type OpenAiPromptCacheConfig = {
  key: string;
  retention?: OpenAiPromptCacheRetention;
};

type OpenAiPromptCacheCapability = {
  supportsKey: boolean;
  supportsRetention: boolean;
};

type OpenAiPromptCacheCapabilityStore = Map<string, OpenAiPromptCacheCapability>;

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const OPENAI_PROMPT_CACHE_SCOPE_HASH_LENGTH = 12;
const OPENAI_PROMPT_CACHE_SCOPE_VERSION = "v2";

const normalizeOpenAiPromptCacheKey = (value: string) =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);

const hashOpenAiPromptCacheScope = (parts: unknown[]) =>
  createHash("sha256")
    .update(JSON.stringify([OPENAI_PROMPT_CACHE_SCOPE_VERSION, ...parts]))
    .digest("hex")
    .slice(0, OPENAI_PROMPT_CACHE_SCOPE_HASH_LENGTH);

const buildOpenAiPromptCacheScopeHash = (options: {
  appRoot?: string;
  format?: TransportFormat;
  mcpTools?: McpToolDescriptor[];
  systemPrompt?: string;
}) =>
  hashOpenAiPromptCacheScope([
    options.appRoot ? resolve(options.appRoot) : "",
    options.format ?? "",
    options.systemPrompt ?? "",
    (options.mcpTools ?? []).map(tool => [
      tool.serverId,
      tool.name,
      tool.id,
      tool.description ?? "",
    ]),
  ]);

const buildDefaultOpenAiPromptCacheKey = (
  provider: string,
  model: string,
  scopeHash?: string
) => {
  const normalizedProvider = normalizeOpenAiPromptCacheKey(
    provider
      .replace(/^https?:\/\//i, "")
      .replace(/\/v\d+(?:beta)?\/?$/i, "")
      .replace(/[/?#].*$/, "")
  );
  const normalizedModel = normalizeOpenAiPromptCacheKey(model);
  const baseKey = normalizeOpenAiPromptCacheKey(
    ["cyrene", normalizedProvider, normalizedModel].filter(Boolean).join("-")
  );
  const normalizedScopeHash = normalizeOpenAiPromptCacheKey(scopeHash ?? "");
  if (!normalizedScopeHash) {
    return baseKey;
  }
  const prefixMaxLength = Math.max(
    1,
    OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - normalizedScopeHash.length - 1
  );
  const prefix = (baseKey || "cyrene")
    .slice(0, prefixMaxLength)
    .replace(/-+$/g, "");
  return normalizeOpenAiPromptCacheKey(`${prefix}-${normalizedScopeHash}`);
};

const parseOpenAiPromptCacheRetention = (
  value: string | undefined
): OpenAiPromptCacheRetention | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "default" || normalized === "auto") {
    return undefined;
  }
  if (
    normalized === "24h" ||
    normalized === "24hr" ||
    normalized === "24-hour" ||
    normalized === "24-hours"
  ) {
    return "24h";
  }
  if (
    normalized === "memory" ||
    normalized === "in-memory" ||
    normalized === "in_memory"
  ) {
    return "in_memory";
  }
  return undefined;
};

const resolveOpenAiPromptCacheConfig = (options: {
  env?: NodeJS.ProcessEnv;
  provider: string;
  model: string;
  family?: ProviderFamily;
  format?: TransportFormat;
  appRoot?: string;
  mcpTools?: McpToolDescriptor[];
  systemPrompt?: string;
  capability?: OpenAiPromptCacheCapability;
}): OpenAiPromptCacheConfig | null => {
  if (options.family === "gemini") {
    return null;
  }
  if (
    resolveDeepSeekCompatibilityMode({
      provider: options.provider,
      model: options.model,
      env: options.env,
    })
  ) {
    return null;
  }
  if (options.env?.CYRENE_OPENAI_PROMPT_CACHE === "0") {
    return null;
  }
  if (options.capability?.supportsKey === false) {
    return null;
  }
  const explicitKey = options.env?.CYRENE_OPENAI_PROMPT_CACHE_KEY;
  const scopeHash = explicitKey?.trim()
    ? undefined
    : buildOpenAiPromptCacheScopeHash({
        appRoot: options.appRoot,
        format: options.format,
        mcpTools: options.mcpTools,
        systemPrompt: options.systemPrompt,
      });
  const key = normalizeOpenAiPromptCacheKey(
    explicitKey?.trim() ||
      buildDefaultOpenAiPromptCacheKey(options.provider, options.model, scopeHash)
  );
  if (!key) {
    return null;
  }
  const retention =
    options.capability?.supportsRetention === false
      ? undefined
      : parseOpenAiPromptCacheRetention(
          options.env?.CYRENE_OPENAI_PROMPT_CACHE_RETENTION
        );
  return {
    key,
    ...(retention ? { retention } : {}),
  };
};

const buildOpenAiPromptCacheFields = (config: OpenAiPromptCacheConfig) => ({
  prompt_cache_key: config.key,
  ...(config.retention ? { prompt_cache_retention: config.retention } : {}),
});

const parseBooleanEnvOverride = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
};

const isDeepSeekProvider = (provider: string | undefined) => {
  if (!provider) {
    return false;
  }
  try {
    return new URL(provider).hostname.toLowerCase().split(".").includes("deepseek");
  } catch {
    return provider.toLowerCase().split(/[^a-z0-9]+/u).includes("deepseek");
  }
};

const isDeepSeekModel = (model: string | undefined) =>
  Boolean(model?.toLowerCase().split(/[^a-z0-9]+/u).includes("deepseek"));

const resolveDeepSeekCompatibilityMode = (options: {
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
}) => {
  const explicit =
    parseBooleanEnvOverride(options.env?.CYRENE_DEEPSEEK_COMPATIBILITY) ??
    parseBooleanEnvOverride(options.env?.CYRENE_DEEPSEEK_COMPAT);
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return isDeepSeekProvider(options.provider) || isDeepSeekModel(options.model);
};

const shouldPreferPromptBeforeTools = (options: {
  provider: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}) => resolveDeepSeekCompatibilityMode(options);

const shouldPreferToolsBeforePrompt = (options: {
  cacheConfig?: OpenAiPromptCacheConfig | null;
}) => Boolean(options.cacheConfig);

const MAX_HTTP_FAILURE_DETAIL_LENGTH = 1200;

const truncateHttpFailureDetail = (value: string) =>
  value.length > MAX_HTTP_FAILURE_DETAIL_LENGTH
    ? `${value.slice(0, MAX_HTTP_FAILURE_DETAIL_LENGTH)}...`
    : value;

const extractHttpFailureDetail = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    error?: unknown;
    message?: unknown;
    detail?: unknown;
  };

  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record.detail === "string" && record.detail.trim()) {
    return record.detail.trim();
  }

  if (record.error && typeof record.error === "object") {
    const errorRecord = record.error as {
      message?: unknown;
      detail?: unknown;
      code?: unknown;
      type?: unknown;
    };
    if (
      typeof errorRecord.message === "string" &&
      errorRecord.message.trim()
    ) {
      return errorRecord.message.trim();
    }
    if (typeof errorRecord.detail === "string" && errorRecord.detail.trim()) {
      return errorRecord.detail.trim();
    }

    const compactError = JSON.stringify(record.error);
    if (compactError && compactError !== "{}") {
      return compactError;
    }
  }

  const compactPayload = JSON.stringify(payload);
  if (compactPayload && compactPayload !== "{}") {
    return compactPayload;
  }
  return null;
};

const readHttpFailureDetail = async (response: Response) => {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return null;
    }

    try {
      const payload = JSON.parse(text) as unknown;
      const detail = extractHttpFailureDetail(payload);
      if (detail) {
        return truncateHttpFailureDetail(detail);
      }
    } catch {
      // Fall back to the raw response body when it is not JSON.
    }

    return truncateHttpFailureDetail(text);
  } catch {
    return null;
  }
};

const formatHttpFailure = async (
  label: "Stream error" | "Model fetch failed",
  response: Response,
  requestUrl: string
) => {
  const resolvedUrl = response.url?.trim() || requestUrl;
  const detail = await readHttpFailureDetail(response);
  return detail
    ? `${label}: ${response.status} ${response.statusText} | url ${resolvedUrl} | detail ${detail}`
    : `${label}: ${response.status} ${response.statusText} | url ${resolvedUrl}`;
};

const isUnsupportedTemperatureFailureDetail = (detail: string | null) => {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("temperature") &&
    (normalized.includes("unsupported parameter") ||
      normalized.includes("unknown parameter") ||
      normalized.includes("does not support") ||
      normalized.includes("not support"))
  );
};

const isUnsupportedParameterFailure = (normalizedDetail: string) =>
  normalizedDetail.includes("unsupported parameter") ||
  normalizedDetail.includes("unknown parameter") ||
  normalizedDetail.includes("unrecognized") ||
  normalizedDetail.includes("does not support") ||
  normalizedDetail.includes("not support");

const isUnsupportedPromptCacheKeyFailureDetail = (detail: string | null) => {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("prompt_cache_key") &&
    isUnsupportedParameterFailure(normalized)
  );
};

const isUnsupportedPromptCacheRetentionFailureDetail = (
  detail: string | null
) => {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("prompt_cache_retention") &&
    isUnsupportedParameterFailure(normalized)
  );
};

const isUnsupportedPromptCacheFailureDetail = (detail: string | null) =>
  isUnsupportedPromptCacheKeyFailureDetail(detail) ||
  isUnsupportedPromptCacheRetentionFailureDetail(detail);

const nextOpenAiPromptCacheConfigAfterFailure = (
  config: OpenAiPromptCacheConfig | null,
  detail: string | null
): OpenAiPromptCacheConfig | null => {
  if (!config) {
    return null;
  }
  if (
    config.retention &&
    isUnsupportedPromptCacheRetentionFailureDetail(detail)
  ) {
    return { key: config.key };
  }
  if (isUnsupportedPromptCacheKeyFailureDetail(detail)) {
    return null;
  }
  return config;
};

const buildOpenAiPromptCacheCapabilityKey = (options: {
  provider: string;
  model: string;
  format: TransportFormat;
}) =>
  [
    resolveProviderBaseUrl(options.provider) ?? options.provider.trim(),
    options.model.trim(),
    options.format,
  ].join("\u0000");

const getOpenAiPromptCacheCapability = (
  store: OpenAiPromptCacheCapabilityStore | undefined,
  options: {
    provider: string;
    model: string;
    format: TransportFormat;
  }
): OpenAiPromptCacheCapability => ({
  supportsKey: true,
  supportsRetention: true,
  ...(store?.get(buildOpenAiPromptCacheCapabilityKey(options)) ?? {}),
});

const rememberOpenAiPromptCacheFailure = (
  store: OpenAiPromptCacheCapabilityStore | undefined,
  options: {
    provider: string;
    model: string;
    format: TransportFormat;
  },
  detail: string | null
) => {
  if (!store || !isUnsupportedPromptCacheFailureDetail(detail)) {
    return;
  }
  const key = buildOpenAiPromptCacheCapabilityKey(options);
  const previous = getOpenAiPromptCacheCapability(store, options);
  store.set(key, {
    supportsKey: isUnsupportedPromptCacheKeyFailureDetail(detail)
      ? false
      : previous.supportsKey,
    supportsRetention:
      isUnsupportedPromptCacheKeyFailureDetail(detail) ||
      isUnsupportedPromptCacheRetentionFailureDetail(detail)
        ? false
        : previous.supportsRetention,
  });
};

type OpenAiRequestCaptureRecord = {
  createdAt: string;
  captureId: string;
  format: "openai_chat" | "openai_responses";
  provider: string;
  model: string;
  requestUrl: string;
  summary: {
    requestBodyLength: number;
    prefixLength: number;
    promptCacheKey: string | null;
    promptBeforeTools: boolean;
    keyOrder: string[];
    previous?: {
      path: string;
      commonPrefixLength: number;
      firstDiffIndex: number | null;
      leftContext: string;
      rightContext: string;
    };
    messagePrefix?: OpenAiMessagePrefixDiagnostic;
    latestCache?: {
      cachedTokens?: number;
      promptCacheHitTokens?: number;
      promptCacheMissTokens?: number;
    };
  };
  requestBody: unknown;
  requestBodyPrefix: string;
  responseUsageEvents?: OpenAiCapturedUsageEvent[];
};

type OpenAiCapturePrevious = {
  path: string;
  body: string;
  parsedBody: unknown;
};

type OpenAiCapturedUsageEvent = {
  capturedAt: string;
  usage: unknown;
  normalized?: TokenUsage;
};

type OpenAiMessagePrefixDiagnostic = {
  currentMessageCount: number;
  previousMessageCount?: number;
  identicalMessageCount?: number;
  firstDifferentMessageIndex?: number | null;
  firstDifferentMessageRole?: string | null;
  firstDifferentPreviousRole?: string | null;
  firstDifferentContentCommonPrefixLength?: number | null;
  firstDifferentContentLeftContext?: string;
  firstDifferentContentRightContext?: string;
};

const openAiCapturePreviousByKey = new Map<string, OpenAiCapturePrevious>();

const shouldCaptureOpenAiRequests = (env?: NodeJS.ProcessEnv) =>
  isTruthyEnvFlag(env?.CYRENE_CAPTURE_OPENAI_REQUESTS) ||
  isTruthyEnvFlag(env?.CYRENE_DEBUG_HTTP_REQUESTS);

const resolveOpenAiSnapshotDir = (options?: {
  appRoot?: string;
  env?: NodeJS.ProcessEnv;
}) => {
  const configuredDir =
    options?.env?.CYRENE_CAPTURE_OPENAI_REQUESTS_DIR?.trim() ||
    options?.env?.CYRENE_DEBUG_HTTP_REQUESTS_DIR?.trim();
  if (configuredDir) {
    if (isAbsolute(configuredDir)) {
      return resolve(configuredDir);
    }
    return resolve(options?.appRoot ?? process.cwd(), configuredDir);
  }
  return join(
    resolveUserHomeDir({ env: options?.env }),
    ".cyrene",
    "debug",
    "openai-requests"
  );
};

const findFirstDiffIndex = (left: string, right: string) => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left.charCodeAt(index) !== right.charCodeAt(index)) {
      return index;
    }
  }
  return left.length === right.length ? null : length;
};

const sliceDiffContext = (value: string, index: number | null, radius = 180) => {
  if (index === null) {
    return "";
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + radius);
  return value.slice(start, end);
};

const collectTopLevelKeyOrder = (bodyText: string) => {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : [];
  } catch {
    return [];
  }
};

const extractPromptCacheKeyFromBody = (bodyText: string) => {
  try {
    const parsed = JSON.parse(bodyText) as { prompt_cache_key?: unknown };
    return typeof parsed.prompt_cache_key === "string"
      ? parsed.prompt_cache_key
      : null;
  } catch {
    return null;
  }
};

const extractOpenAiSnapshotMessages = (body: unknown): unknown[] => {
  const bodyRecord = asRecord(body);
  if (!bodyRecord) {
    return [];
  }
  if (Array.isArray(bodyRecord.messages)) {
    return bodyRecord.messages;
  }
  if (Array.isArray(bodyRecord.input)) {
    return bodyRecord.input;
  }
  return [];
};

const extractOpenAiSnapshotMessageRole = (message: unknown) => {
  const messageRecord = asRecord(message);
  const role = messageRecord?.role;
  return typeof role === "string" ? role : null;
};

const stringifyOpenAiSnapshotMessageContent = (message: unknown) => {
  const messageRecord = asRecord(message);
  if (!messageRecord) {
    return "";
  }
  const content = messageRecord.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return JSON.stringify(content);
  }
  return typeof content === "undefined" ? "" : JSON.stringify(content);
};

const sectionStartsWithAny = (text: string, markers: readonly string[]) =>
  markers.some(marker => text.startsWith(marker.trim()));

const splitTextIntoDoubleNewlineSections = (text: string) =>
  text
    .trim()
    .split(/\n\n+/)
    .map(section => section.trim())
    .filter(Boolean);

const buildOpenAiMessagePrefixDiagnostic = (
  currentBody: unknown,
  previousBody?: unknown
): OpenAiMessagePrefixDiagnostic | undefined => {
  const currentMessages = extractOpenAiSnapshotMessages(currentBody);
  if (currentMessages.length === 0) {
    return undefined;
  }
  const previousMessages = previousBody
    ? extractOpenAiSnapshotMessages(previousBody)
    : [];
  if (previousMessages.length === 0) {
    return {
      currentMessageCount: currentMessages.length,
    };
  }

  let identicalMessageCount = 0;
  const comparableLength = Math.min(currentMessages.length, previousMessages.length);
  while (
    identicalMessageCount < comparableLength &&
    JSON.stringify(currentMessages[identicalMessageCount]) ===
      JSON.stringify(previousMessages[identicalMessageCount])
  ) {
    identicalMessageCount += 1;
  }

  const firstDifferentMessageIndex =
    identicalMessageCount === comparableLength &&
    currentMessages.length === previousMessages.length
      ? null
      : identicalMessageCount;
  const currentDifferent =
    typeof firstDifferentMessageIndex === "number"
      ? currentMessages[firstDifferentMessageIndex]
      : undefined;
  const previousDifferent =
    typeof firstDifferentMessageIndex === "number"
      ? previousMessages[firstDifferentMessageIndex]
      : undefined;
  const currentContent = stringifyOpenAiSnapshotMessageContent(currentDifferent);
  const previousContent = stringifyOpenAiSnapshotMessageContent(previousDifferent);
  const firstDifferentContentDiffIndex =
    typeof firstDifferentMessageIndex === "number"
      ? findFirstDiffIndex(previousContent, currentContent)
      : null;

  return {
    currentMessageCount: currentMessages.length,
    previousMessageCount: previousMessages.length,
    identicalMessageCount,
    firstDifferentMessageIndex,
    firstDifferentMessageRole: extractOpenAiSnapshotMessageRole(currentDifferent),
    firstDifferentPreviousRole: extractOpenAiSnapshotMessageRole(previousDifferent),
    firstDifferentContentCommonPrefixLength:
      firstDifferentContentDiffIndex ?? Math.min(previousContent.length, currentContent.length),
    firstDifferentContentLeftContext: sliceDiffContext(
      previousContent,
      firstDifferentContentDiffIndex
    ),
    firstDifferentContentRightContext: sliceDiffContext(
      currentContent,
      firstDifferentContentDiffIndex
    ),
  };
};

const writeOpenAiRequestSnapshot = async (options: {
  appRoot?: string;
  env?: NodeJS.ProcessEnv;
  captureId: string;
  format: "openai_chat" | "openai_responses";
  provider: string;
  model: string;
  requestUrl: string;
  bodyText: string;
  promptBeforeTools: boolean;
}) => {
  if (!shouldCaptureOpenAiRequests(options.env)) {
    return null;
  }
  const snapshotDir = resolveOpenAiSnapshotDir({
    appRoot: options.appRoot,
    env: options.env,
  });
  const createdAt = new Date().toISOString();
  const promptCacheKey = extractPromptCacheKeyFromBody(options.bodyText);
  const cacheIdentity = [
    options.format,
    options.provider,
    options.model,
    promptCacheKey ?? "no-cache-key",
  ].join("\u0000");
  const previous = openAiCapturePreviousByKey.get(cacheIdentity);
  const firstDiffIndex = previous
    ? findFirstDiffIndex(previous.body, options.bodyText)
    : null;
  const snapshotPath = join(
    snapshotDir,
    `${createdAt.replaceAll(":", "-")}-${options.captureId}-${options.format}.json`
  );
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(options.bodyText) as unknown;
  } catch {
    parsedBody = options.bodyText;
  }
  const messagePrefix = buildOpenAiMessagePrefixDiagnostic(
    parsedBody,
    previous?.parsedBody
  );
  const record: OpenAiRequestCaptureRecord = {
    createdAt,
    captureId: options.captureId,
    format: options.format,
    provider: options.provider,
    model: options.model,
    requestUrl: options.requestUrl,
    summary: {
      requestBodyLength: options.bodyText.length,
      prefixLength: Math.min(4096, options.bodyText.length),
      promptCacheKey,
      promptBeforeTools: options.promptBeforeTools,
      keyOrder: collectTopLevelKeyOrder(options.bodyText),
      ...(messagePrefix ? { messagePrefix } : {}),
      ...(previous
        ? {
            previous: {
              path: previous.path,
              commonPrefixLength:
                firstDiffIndex ?? Math.min(previous.body.length, options.bodyText.length),
              firstDiffIndex,
              leftContext: sliceDiffContext(previous.body, firstDiffIndex),
              rightContext: sliceDiffContext(options.bodyText, firstDiffIndex),
            },
          }
        : {}),
    },
    requestBody: parsedBody,
    requestBodyPrefix: options.bodyText.slice(0, 4096),
  };
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  openAiCapturePreviousByKey.set(cacheIdentity, {
    path: snapshotPath,
    body: options.bodyText,
    parsedBody,
  });
  return snapshotPath;
};

const appendOpenAiSnapshotUsage = async (options: {
  env?: NodeJS.ProcessEnv;
  snapshotPath: string | null;
  usage: unknown;
  normalized?: TokenUsage;
}) => {
  if (!options.snapshotPath || !shouldCaptureOpenAiRequests(options.env)) {
    return;
  }
  try {
    const parsed = JSON.parse(
      await readFile(options.snapshotPath, "utf8")
    ) as OpenAiRequestCaptureRecord & {
      summary?: OpenAiRequestCaptureRecord["summary"] & {
        latestUsage?: unknown;
      };
    };
    const event: OpenAiCapturedUsageEvent = {
      capturedAt: new Date().toISOString(),
      usage: options.usage,
      ...(options.normalized ? { normalized: options.normalized } : {}),
    };
    const usageRecord = asRecord(options.usage);
    const promptCacheHitTokens =
      typeof usageRecord?.prompt_cache_hit_tokens === "number"
        ? Math.max(0, Math.floor(usageRecord.prompt_cache_hit_tokens))
        : undefined;
    const promptCacheMissTokens =
      typeof usageRecord?.prompt_cache_miss_tokens === "number"
        ? Math.max(0, Math.floor(usageRecord.prompt_cache_miss_tokens))
        : undefined;
    parsed.responseUsageEvents = [
      ...(parsed.responseUsageEvents ?? []),
      event,
    ];
    parsed.summary = {
      ...parsed.summary,
      latestUsage: event,
      latestCache: {
        ...(typeof options.normalized?.cachedTokens === "number"
          ? { cachedTokens: options.normalized.cachedTokens }
          : {}),
        ...(typeof promptCacheHitTokens === "number"
          ? { promptCacheHitTokens }
          : {}),
        ...(typeof promptCacheMissTokens === "number"
          ? { promptCacheMissTokens }
          : {}),
      },
    };
    await writeFile(
      options.snapshotPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // Debug capture should never affect the provider stream.
  }
};

export const FILE_TOOL = {
  type: "function",
  function: {
    name: "file",
    description:
      "Operate workspace paths, content, git, semantic/LSP, and shell actions with one action-based JSON payload. Intuitive aliases like ls/cat/mkdir/rm/cp/mv are accepted. Write, move, copy, delete, and command actions require review.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "read_file",
            "read_files",
            "read_range",
            "read_json",
            "read_yaml",
            "list_dir",
            "create_dir",
            "create_file",
            "write_file",
            "edit_file",
            "apply_patch",
            "delete_file",
            "read",
            "cat",
            "ls",
            "stat",
            "json",
            "yaml",
            "mkdir",
            "touch",
            "write",
            "edit",
            "patch",
            "delete",
            "remove",
            "rm",
            "copy",
            "cp",
            "move",
            "mv",
            "rename",
            "grep",
            "stat_path",
            "stat_paths",
            "outline_file",
            "find",
            "glob",
            "find_files",
            "symbol",
            "symbols_find",
            "find_symbol",
            "references",
            "refs",
            "find_references",
            "search",
            "search_text",
            "search_context",
            "grep_context",
            "search_text_context",
            "copy_path",
            "move_path",
            "git_status",
            "git_diff",
            "git_log",
            "git_show",
            "git_blame",
            "ts_hover",
            "ts_definition",
            "ts_references",
            "ts_diagnostics",
            "ts_prepare_rename",
            "lsp_hover",
            "lsp_definition",
            "lsp_implementation",
            "lsp_type_definition",
            "lsp_references",
            "lsp_workspace_symbols",
            "lsp_document_symbols",
            "lsp_diagnostics",
            "lsp_prepare_rename",
            "lsp_rename",
            "lsp_code_actions",
            "lsp_format_document",
            "run_command",
            "run_shell",
            "open_shell",
            "write_shell",
            "read_shell",
            "shell_status",
            "interrupt_shell",
            "close_shell",
          ],
        },
        path: {
          type: "string",
          description:
            "Workspace-relative path. Optional for find/search/symbol/reference tools; omit it to search the whole workspace.",
        },
        content: { type: "string" },
        paths: {
          type: "array",
          description:
            "Additional workspace-relative paths for read_files or stat_paths. Put the first target in path and the rest in paths.",
          items: { type: "string" },
        },
        startLine: {
          type: "integer",
          description: "1-based inclusive start line for read_range or git_blame.",
          minimum: 1,
        },
        endLine: {
          type: "integer",
          description: "1-based inclusive end line for read_range or git_blame.",
          minimum: 1,
        },
        line: {
          type: "integer",
          description:
            "1-based line for ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, lsp_references, lsp_rename, or lsp_code_actions.",
          minimum: 1,
        },
        column: {
          type: "integer",
          description:
            "1-based column for ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, lsp_references, lsp_rename, or lsp_code_actions.",
          minimum: 1,
        },
        newName: {
          type: "string",
          description: "Replacement identifier for ts_prepare_rename, lsp_prepare_rename, or lsp_rename.",
        },
        serverId: {
          type: "string",
          description:
            "Optional explicit LSP server id for lsp_* actions when more than one configured LSP server matches the path.",
        },
        title: {
          type: "string",
          description:
            "Exact code action title for lsp_code_actions apply mode. Omit to list available actions.",
        },
        kind: {
          type: "string",
          description:
            "Optional code action kind filter for lsp_code_actions, such as quickfix or refactor.extract.",
        },
        jsonPath: {
          type: "string",
          description: "Optional dot path for read_json, such as scripts.test or compilerOptions.paths.",
        },
        yamlPath: {
          type: "string",
          description: "Optional dot path for read_yaml, such as services.api.image or deployments.0.name.",
        },
        find: { type: "string" },
        replace: { type: "string" },
        pattern: {
          type: "string",
          description: "Glob pattern for find_files. Omit when unused.",
        },
        symbol: {
          type: "string",
          description: "Symbol name for find_symbol or find_references, such as FileMcpService or SessionRepository.",
        },
        query: {
          type: "string",
          description:
            "Search string for search_text/search_text_context, or symbol query for lsp_workspace_symbols. Omit when unused.",
        },
        before: {
          type: "integer",
          description: "Context lines before each hit for search_text_context.",
          minimum: 0,
        },
        after: {
          type: "integer",
          description: "Context lines after each hit for search_text_context.",
          minimum: 0,
        },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
        tabSize: {
          type: "integer",
          minimum: 1,
          description: "Optional tab size for lsp_format_document.",
        },
        insertSpaces: {
          type: "boolean",
          description: "Optional spacing mode for lsp_format_document.",
        },
        caseSensitive: { type: "boolean" },
        findInComments: {
          type: "boolean",
          description: "Whether ts_prepare_rename should include comment matches.",
        },
        findInStrings: {
          type: "boolean",
          description: "Whether ts_prepare_rename should include string literal matches.",
        },
        destination: { type: "string" },
        revision: {
          type: "string",
          description: "Commit-ish for git_show, such as HEAD~1 or a commit hash.",
        },
        command: { type: "string" },
        input: {
          type: "string",
          description:
            "Shell input for write_shell. Prefer one command, but safe reviewed multiline paste blocks are also allowed there. Omit when unused.",
        },
        args: {
          type: "array",
          description:
            "Program arguments for run_command only. Omit args for all other actions.",
          items: { type: "string" },
        },
        cwd: { type: "string" },
      },
      required: ["action", "path"],
    },
  },
} as const;
export const TOOL_USAGE_SYSTEM_PROMPT = [
  "You are operating inside a workspace with function tools.",
  "The `file` function is always available for filesystem and shell work.",
  "When a domain-specific MCP tool is available for the task, prefer that tool instead of forcing the task through `file`.",
  "Tool-call protocol is strict: when a tool call is needed, output exactly one valid function tool call and nothing else.",
  "Do not output XML tags, pseudo-tags, markdown code fences, wrapper text, mixed tool syntaxes, or partially formed tool calls.",
  "Do not emit placeholders such as `<path>`, `your/path`, `example`, `...`, empty strings, or guessed arguments.",
  "Do not guess missing required arguments. If you do not know a required path or symbol yet, call a narrower discovery tool first.",
  "Use exact exposed tool names and provide arguments that match the tool schema.",
  "If a previous tool call was rejected, correct the exact schema error and retry with one corrected tool call only.",
  "Intuitive aliases are first-class when they fit naturally: `read`/`cat` -> read_file, `ls` -> list_dir, `stat` -> stat_path, `json` -> read_json, `yaml` -> read_yaml, `mkdir` -> create_dir, `touch` -> create_file, `write` -> write_file, `edit` -> edit_file, `patch` -> apply_patch, `find`/`glob` -> find_files, `search`/`grep` -> search_text, `search_context`/`grep_context` -> search_text_context, `symbol`/`symbols_find` -> find_symbol, `references`/`refs` -> find_references, `delete`/`remove`/`rm` -> delete_file, `copy`/`cp` -> copy_path, `move`/`mv`/`rename` -> move_path.",
  "Function arguments must be valid JSON and include required fields:",
  "{ action, path, content?, paths?, startLine?, endLine?, line?, column?, newName?, serverId?, title?, kind?, tabSize?, insertSpaces?, jsonPath?, yamlPath?, find?, replace?, pattern?, symbol?, query?, before?, after?, maxResults?, caseSensitive?, findInComments?, findInStrings?, destination?, revision?, command?, input?, args?, cwd? }.",
  "Never call the `file` tool with empty arguments, placeholder values, guessed fields you do not need, or unrelated extra fields.",
  "Available `file` actions are grouped by intent:",
  "Inspect: read_file/read_files/read_range/read_json/read_yaml/list_dir/stat_path/stat_paths/outline_file plus aliases cat/ls/stat.",
  "Search: find/find_files/glob, search/search_text/grep, search_context/search_text_context/grep_context, symbol/find_symbol/symbols_find, references/find_references/refs.",
  "Mutate paths/content: create_dir/create_file/write_file/edit_file/apply_patch/delete_file/copy_path/move_path plus aliases mkdir/touch/write/edit/patch/delete/remove/rm/copy/cp/move/mv/rename.",
  "Git: git_status/git_diff/git_log/git_show/git_blame.",
  "Semantic: ts_hover/ts_definition/ts_references/ts_diagnostics/ts_prepare_rename and lsp_hover/lsp_definition/lsp_implementation/lsp_type_definition/lsp_references/lsp_workspace_symbols/lsp_document_symbols/lsp_diagnostics/lsp_prepare_rename/lsp_rename/lsp_code_actions/lsp_format_document.",
  "Shell: run_command/run_shell/open_shell/write_shell/read_shell/shell_status/interrupt_shell/close_shell.",
  "Choose the narrowest action that answers the question. Prefer precise search or metadata actions over broad exploratory reads.",
  "Single-action discipline:",
  "- One tool call must express exactly one action. Do not mix read/search/edit/shell intents in the same payload.",
  "- If the next step requires a tool, do not output a natural-language plan instead of the tool call.",
  "- If you already have enough information to answer or act, stop calling tools and continue the task.",
  "Tool selection rules:",
  "- Use read_files when you already know multiple exact file paths and need to inspect them together.",
  "- Use read_range when you need a specific line window from one file instead of reading the whole file.",
  "- Use read_json for JSON configuration files when you want parsed structured output instead of raw text.",
  "- Use read_yaml for YAML configuration files when you want parsed structured output instead of raw text.",
  "- Use stat_path to confirm whether a path exists and whether it is a file or directory.",
  "- Use stat_paths when you need existence or metadata for several exact paths in one call.",
  "- Use outline_file before full reads on large source files to find the important symbols first.",
  "- If you know the filename or path pattern, use find/find_files.",
  "- If you remember text content but not the file, use search/search_text.",
  "- If you need surrounding lines around each text hit, use search_context/search_text_context.",
  "- If you know an identifier and want its definition or declaration, use symbol/find_symbol.",
  "- If you know an identifier and want its usages, use references/find_references.",
  "- Treat lsp_* as the canonical semantic-navigation tool family. When a matching lsp_server is unavailable for a TypeScript/JavaScript file, the filesystem service may satisfy the request through the bundled tsserver backend instead of failing.",
  "- Treat ts_* as TypeScript/JavaScript compatibility aliases for that semantic backend. Prefer the canonical lsp_* shape when you do not specifically need the TS-only alias.",
  "- Use ts_hover for TypeScript/JavaScript quick info at an exact file position.",
  "- Use ts_definition for TypeScript/JavaScript definition lookup at an exact file position.",
  "- Use ts_references for semantic TypeScript/JavaScript references at an exact file position.",
  "- Prefer lsp_diagnostics for TypeScript/JavaScript diagnostics when a matching LSP server is configured; use ts_diagnostics as the fallback when LSP diagnostics are unavailable or clearly not configured.",
  "- Use ts_diagnostics for TypeScript/JavaScript diagnostics on one file when you specifically need the tsserver fallback path.",
  "- Use ts_prepare_rename to preview a semantic TypeScript/JavaScript rename before any file mutation.",
  "- Use lsp_hover for generic language-server hover info when TS-specific tools do not apply.",
  "- Use lsp_definition for generic language-server definition lookup.",
  "- Use lsp_implementation for generic language-server implementation lookup.",
  "- Use lsp_type_definition for generic language-server type-definition lookup.",
  "- Use lsp_references for generic language-server references.",
  "- Use lsp_workspace_symbols for generic language-server workspace symbol search.",
  "- Use lsp_document_symbols for generic language-server document symbols or outline.",
  "- Use lsp_diagnostics for generic language-server diagnostics on one file, including TypeScript/JavaScript workspaces that already have a matching LSP server.",
  "- Use lsp_prepare_rename to preview a generic language-server rename before any file mutation.",
  "- Use lsp_rename to apply a reviewed generic language-server rename.",
  "- Use lsp_code_actions to list available generic language-server code actions, or provide `title` to apply one reviewed edit-based action.",
  "- Use lsp_format_document to apply reviewed generic language-server formatting edits.",
  "- Use search/search_text for content discovery inside files.",
  "- Use search_context/search_text_context when surrounding lines around each match matter.",
  "- Use git_status to inspect the repository worktree without going through a reviewed shell command.",
  "- Use git_diff to inspect unstaged and staged diff output for the repo or a path inside it.",
  "- Use git_log to inspect recent commits for the repo or a scoped path.",
  "- Use git_show to inspect one revision in detail. Provide `revision` explicitly.",
  "- Use git_blame to inspect who last changed specific lines in a tracked file.",
  "- For find/find_files, search/search_text, search_context/search_text_context, symbol/find_symbol, and references/find_references, omit `path` to search the whole workspace.",
  "- Omit every optional field you do not need. Do not send empty strings, empty arrays, or placeholder values.",
  "- Use read_file only when you actually need the file contents.",
  "- When the task explicitly asks for code changes and the target path is already known, prefer one targeted read or direct write/edit instead of extra confirmation-style exploration.",
  "- For read_files, set `path` to the first file and `paths` to any additional files.",
  "- For read_file, provide `path` only. Do not send `paths`.",
  "- For stat_paths, set `path` to the first target and `paths` to any additional targets.",
  "- For stat_path, provide `path` only. Do not send `paths`.",
  "- For read_range, provide 1-based inclusive `startLine` and `endLine`.",
  "- For read_json, provide `jsonPath` only when you want one nested field instead of the whole document.",
  "- For read_yaml, provide `yamlPath` only when you want one nested field instead of the whole document.",
  "- For symbol/find_symbol, provide the exact symbol name in `symbol`.",
  "- For references/find_references, provide the exact symbol name in `symbol`.",
  "- For ts_hover, ts_definition, ts_references, lsp_hover, lsp_definition, lsp_implementation, lsp_type_definition, and lsp_references, provide exact 1-based `line` and `column`.",
  "- For ts_diagnostics, provide a TS/JS file path and optional `maxResults` when you need fewer entries.",
  "- For ts_prepare_rename, provide exact 1-based `line`, `column`, and a non-empty `newName`.",
  "- For lsp_workspace_symbols, provide a non-empty `query`, a relevant `path` such as `.` or a matching file, and optional `serverId` when multiple configured LSP servers exist.",
  "- For lsp_document_symbols and lsp_diagnostics, provide a file path and optional `serverId` when multiple configured LSP servers could match.",
  "- For lsp_prepare_rename, provide exact 1-based `line`, `column`, a non-empty `newName`, and optional `serverId`.",
  "- For lsp_rename, provide exact 1-based `line`, `column`, a non-empty `newName`, and optional `serverId`.",
  "- For lsp_code_actions, provide exact 1-based `line` and `column`, optional `kind`, and optional `title` only when you want to apply one matching action.",
  "- For lsp_format_document, provide a file path and optional `serverId`, `tabSize`, or `insertSpaces`.",
  "- For search_text_context, use `before` and `after` only when you need surrounding context lines.",
  "- For git_log, use `maxResults` to limit how many commits you need.",
  "- For git_show, use `revision` and an optional scoped `path`.",
  "- For git_blame, provide a file path and optional `startLine` / `endLine` for a narrow range.",
  "- Use list_dir only when the directory listing itself is required.",
  "- Prefer `write`/write_file as the default file-write action for normal create-or-overwrite behavior.",
  "- Use create_file or touch only when you specifically need new-only semantics and want the call to fail if the file already exists.",
  "- Use edit or edit_file for one targeted replacement.",
  "- Use patch or apply_patch for targeted patches on one file using `find` and `replace`.",
  "- For write_file, provide `content` with the full desired file body.",
  "- For edit_file and apply_patch, provide both `find` and `replace`.",
  "- Use delete/remove/rm for path removal. It can remove either a file or a directory path.",
  "- Use copy/cp or copy_path for path duplication. It works for files and directories.",
  "- Use move/mv/rename or move_path for path relocation or renaming. It works for files and directories.",
  "- Use copy_path or move_path instead of trying to emulate them with read/write/delete steps.",
  "- Use run_command only for direct program execution such as `node --version`.",
  "- `args` is only for run_command. Do not put search terms for find_files or search_text into args.",
  "- Use run_shell only when true shell semantics are required. For shell actions, set path to a relevant workspace path such as '.'.",
  "- Use open_shell and write_shell when shell state must persist across steps, such as `source .venv/bin/activate`, `. .venv/bin/activate`, `.\\\\.venv\\\\Scripts\\\\Activate.ps1`, or `cd subdir`.",
  "- open_shell opens a persistent shell directly after local validation succeeds. It does not go through the approval panel.",
  "- When a persistent shell may already exist, call shell_status before opening another one.",
  "- Use write_shell only after open_shell has created an active shell session.",
  "- Low-risk write_shell inputs such as workspace-local `cd`, venv activation, allowlisted read-only probes, `python --version`, `pip list`, or `git status` may execute immediately.",
  "- Medium-risk write_shell inputs still require review, and high-risk write_shell inputs are blocked.",
  "- Use read_shell to fetch unread output from a running or recently completed persistent shell command.",
  "- Use interrupt_shell to send Ctrl+C to the active persistent shell when a command is still running.",
  "- Use close_shell to terminate the active persistent shell session when it is no longer needed.",
  "- Do not put shell syntax such as pipes, redirection, chaining, or subshells into run_command.",
  "- run_shell currently supports only a safe single-command subset. Do not use pipes, redirection, chaining, background execution, or subshell syntax.",
  "- run_shell does not accept multiline shell input. If the user pasted multiple shell lines, use open_shell plus write_shell instead.",
  "- write_shell supports a safe reviewed subset. Multiline paste blocks are allowed there, but pipes, redirection, chaining, subshells, and background execution are still forbidden.",
  "Directory-state rules:",
  "- If list_dir already returned a confirmed directory state for the same path, treat that result as authoritative until a mutation happens.",
  "- Do not call list_dir again just to re-check the same path.",
  "- After list_dir confirms that a target directory exists, is empty, or contains the needed files, immediately move to the next concrete action.",
  "- If the user asked to create files and you already confirmed the target directory, start creating files instead of listing again.",
  "Read-file rules:",
  "- If read_file returns `(empty file)`, treat that as a confirmed result rather than retrying the same read.",
  "- Do not repeat read_file for the same path unless a write or edit actually changed that file.",
  "- After successful create_file, write_file, edit_file, or apply_patch, treat that result as a confirmed mutation. Do not immediately call read_file on the same path just to confirm the write unless the user explicitly asked to inspect or verify it.",
  "Invalid payload examples to avoid:",
  "- Do not send read_files with a single-file intent.",
  "- Do not send read_file together with `paths`.",
  "- Do not send read_files without a first target in `path`.",
  "- Do not send wrapper text before or after the tool call.",
  "Response-language rules:",
  "- Match the user's language for all progress and final responses (for Chinese users, keep Chinese).",
  "- Do not mix languages in the same response unless the user explicitly asks for bilingual output.",
  "Progress narration rules:",
  "- Keep pre-tool narration concise (one short sentence max) or skip it when the next tool action is obvious.",
  "- Avoid repetitive phrases that restate the same plan across consecutive turns.",
  "Planning rules:",
  "- Before each tool call, decide what new fact you need.",
  "- After each tool result, choose the next concrete step toward finishing the original task.",
  "- Stop exploring once you have enough information to act.",
].join(" ");

export const ANTHROPIC_TOOL_USAGE_SYSTEM_PROMPT = [
  "You are operating inside a workspace with native function tools.",
  "The `file` function handles filesystem, search, semantic/LSP, git, patch, and shell actions. Use domain-specific MCP tools when they fit better than `file`.",
  "When a tool is needed, emit exactly one valid tool call and no surrounding prose, XML, markdown fences, wrapper text, or partial JSON.",
  "Use the exact exposed tool name and the schema-defined fields only. Do not send placeholders, empty strings, empty arrays, guessed paths, or unrelated optional fields.",
  "Intuitive aliases are allowed when clearer: read/cat, ls, stat, json, yaml, mkdir, touch, write, edit, patch, find/glob, search/grep, search_context/grep_context, symbol, references/refs, delete/remove/rm, copy/cp, and move/mv/rename map to the corresponding file actions.",
  "Choose the narrowest action: prefer stat/find/search/symbol/outline/range reads before broad file reads; use read_files/stat_paths for multiple known paths; use search_context/search_text_context only when surrounding lines matter.",
  "For workspace-wide find/find_files/search/search_text/search_context/search_text_context/symbol/find_symbol/references/find_references, omit `path` unless you need to narrow the scope.",
  "For read_file/stat_path provide only `path`; for read_files/stat_paths put the first path in `path` and the rest in `paths`.",
  "For read_range/git_blame use 1-based inclusive `startLine` and `endLine`.",
  "For TS/LSP hover, definition, references, rename, and code actions, provide exact 1-based `line` and `column`; use optional `serverId` only when multiple LSP servers may match.",
  "Prefer write/write_file for normal create-or-overwrite file writes; use create_file/touch only for fail-if-exists semantics. For write_file provide full `content`; for edit_file/apply_patch provide both `find` and `replace`; after a confirmed write/edit/patch, continue instead of rereading just to confirm unless explicitly asked.",
  "Use git_status/git_diff/git_log/git_show/git_blame instead of shell when those answer the question.",
  "Use run_command for direct program execution with optional `args`; do not put shell syntax, pipes, redirects, chains, subshells, or multiline input into run_command.",
  "Use open_shell/write_shell/read_shell/shell_status/interrupt_shell/close_shell only when persistent shell state is required.",
  "If a previous tool call was rejected, correct the exact schema error and retry with one corrected call only.",
  "Match the user's language in progress and final responses. Keep pre-tool narration minimal and stop calling tools once you have enough information to answer or act.",
].join(" ");

const DEFAULT_DYNAMIC_TOOL_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

type TransportMcpTool = McpToolDescriptor & {
  transportName: string;
  originalName: string;
  namespacedName: string;
  renamedForTransport: boolean;
};

type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

type OpenAIResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
};

const FILE_ACTION_NAMES = new Set<string>([
  "read_file",
  "read_files",
  "read_range",
  "read_json",
  "read_yaml",
  "list_dir",
  "create_dir",
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "stat_path",
  "stat_paths",
  "outline_file",
  "find_files",
  "find_symbol",
  "find_references",
  "search_text",
  "search_text_context",
  "copy_path",
  "move_path",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
  "ts_hover",
  "ts_definition",
  "ts_references",
  "ts_diagnostics",
  "ts_prepare_rename",
  "lsp_hover",
  "lsp_definition",
  "lsp_implementation",
  "lsp_type_definition",
  "lsp_references",
  "lsp_workspace_symbols",
  "lsp_document_symbols",
  "lsp_diagnostics",
  "lsp_prepare_rename",
  "lsp_rename",
  "lsp_code_actions",
  "lsp_format_document",
  "run_command",
  "run_shell",
  "open_shell",
  "write_shell",
  "read_shell",
  "shell_status",
  "interrupt_shell",
  "close_shell",
]);

const normalizeDynamicToolSchema = (inputSchema: unknown) =>
  inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
    ? inputSchema
    : DEFAULT_DYNAMIC_TOOL_PARAMETERS;

const normalizeToolNameKey = (value: string) => value.trim().toLowerCase();

const buildTransportMcpTools = (mcpTools: McpToolDescriptor[]): TransportMcpTool[] => {
  const visibleTools = mcpTools.filter(tool => tool.enabled && tool.exposure !== "hidden");
  const nameCounts = new Map<string, number>();
  for (const tool of visibleTools) {
    const normalized = normalizeToolNameKey(tool.name);
    if (!normalized) {
      continue;
    }
    nameCounts.set(normalized, (nameCounts.get(normalized) ?? 0) + 1);
  }

  const seenTransportNames = new Set<string>([FILE_TOOL.function.name]);
  return visibleTools.flatMap(tool => {
    const originalName = tool.name.trim();
    const serverId = tool.serverId.trim();
    if (!originalName || !serverId) {
      return [];
    }

    const normalizedName = normalizeToolNameKey(originalName);
    const renamedForTransport =
      FILE_ACTION_NAMES.has(normalizedName) || (nameCounts.get(normalizedName) ?? 0) > 1;
    let transportName = renamedForTransport
      ? buildTransportToolAliasName(serverId, originalName)
      : originalName;
    if (seenTransportNames.has(transportName)) {
      transportName = buildTransportToolAliasName(serverId, originalName);
    }
    if (seenTransportNames.has(transportName)) {
      return [];
    }
    seenTransportNames.add(transportName);

    return [
      {
        ...tool,
        transportName,
        originalName,
        namespacedName: `${serverId}.${originalName}`,
        renamedForTransport: renamedForTransport || transportName !== originalName,
      },
    ];
  });
};

const buildDynamicFunctionTools = (
  mcpTools: McpToolDescriptor[]
): OpenAIFunctionTool[] => {
  const tools: OpenAIFunctionTool[] = [
    {
      type: "function",
      function: {
        name: FILE_TOOL.function.name,
        description: FILE_TOOL.function.description,
        parameters: FILE_TOOL.function.parameters,
      },
    },
  ];

  for (const tool of buildTransportMcpTools(mcpTools)) {
    tools.push({
      type: "function" as const,
      function: {
        name: tool.transportName,
        description: tool.description ?? tool.label,
        parameters: normalizeDynamicToolSchema(tool.inputSchema),
      },
    });
  }

  return tools;
};

const buildOpenAIResponsesTools = (
  mcpTools: McpToolDescriptor[]
): OpenAIResponsesFunctionTool[] =>
  buildDynamicFunctionTools(mcpTools).map(tool => ({
    type: tool.type,
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters,
  }));

const buildGeminiFunctionTools = (mcpTools: McpToolDescriptor[]) => ({
  functionDeclarations: buildDynamicFunctionTools(mcpTools).map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters:
      sanitizeGeminiSchema(tool.function.parameters) ?? {
        type: "object",
      },
  })),
});

type AnthropicCacheTTL = "1h";
type AnthropicCacheScope = "global";

type AnthropicCacheControl = {
  type: "ephemeral";
  ttl?: AnthropicCacheTTL;
  scope?: AnthropicCacheScope;
};

type AnthropicPromptCacheSessionState = {
  cacheControlLatched: boolean;
  latchedCacheTtl?: AnthropicCacheTTL;
  latchedCacheScope?: AnthropicCacheScope;
  latchedBetaHeaders: string[];
};

type AnthropicPromptProjection = {
  systemBlocks: AnthropicSystemProjectionBlock[];
  userText: string;
};

type AnthropicSystemProjectionBlock = {
  text: string;
  cacheable: boolean;
};

type OpenAiPromptProjection = {
  systemPrompt: string;
  userText: string;
};

type OpenAiContinuationPromptParts = {
  stableUserPrefix: string;
  dynamicUserText: string;
};

type AnthropicToolDefinition = {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: AnthropicCacheControl;
};

const createAnthropicPromptCacheSessionState = (): AnthropicPromptCacheSessionState => ({
  cacheControlLatched: false,
  latchedBetaHeaders: [],
});

const resolveAnthropicCacheControlFromEnv = (env?: NodeJS.ProcessEnv) => {
  const ttlValue = env?.CYRENE_ANTHROPIC_CACHE_TTL?.trim().toLowerCase();
  const scopeValue = env?.CYRENE_ANTHROPIC_CACHE_SCOPE?.trim().toLowerCase();
  return {
    ttl: ttlValue === "1h" ? ("1h" as const) : undefined,
    scope: scopeValue === "global" ? ("global" as const) : undefined,
  };
};

const parseAnthropicBetaHeaders = (value: string | undefined) =>
  Array.from(
    new Set(
      (value ?? "")
        .split(",")
        .map(header => header.trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));

const latchAnthropicCacheControl = (
  state: AnthropicPromptCacheSessionState,
  env?: NodeJS.ProcessEnv
) => {
  if (state.cacheControlLatched) {
    return;
  }
  state.cacheControlLatched = true;
  const resolved = resolveAnthropicCacheControlFromEnv(env);
  state.latchedCacheTtl = resolved.ttl;
  state.latchedCacheScope = resolved.scope;
};

const getAnthropicCacheControl = (
  state: AnthropicPromptCacheSessionState,
  env?: NodeJS.ProcessEnv
): AnthropicCacheControl => {
  latchAnthropicCacheControl(state, env);
  return {
    type: "ephemeral",
    ...(state.latchedCacheTtl ? { ttl: state.latchedCacheTtl } : {}),
    ...(state.latchedCacheScope ? { scope: state.latchedCacheScope } : {}),
  };
};

const getAnthropicBetaHeaders = (
  state: AnthropicPromptCacheSessionState,
  env?: NodeJS.ProcessEnv
) => {
  const resolved = parseAnthropicBetaHeaders(env?.CYRENE_ANTHROPIC_BETA_HEADERS);
  if (resolved.length > 0) {
    state.latchedBetaHeaders = Array.from(
      new Set([...state.latchedBetaHeaders, ...resolved])
    ).sort((left, right) => left.localeCompare(right));
  }
  return [...state.latchedBetaHeaders];
};

const buildAnthropicTools = (
  mcpTools: McpToolDescriptor[],
  cacheControl: AnthropicCacheControl
) => {
  const tools: AnthropicToolDefinition[] = buildDynamicFunctionTools(mcpTools).map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));

  const lastTool = tools.at(-1);
  if (lastTool) {
    tools[tools.length - 1] = {
      ...lastTool,
      cache_control: cacheControl,
    };
  }

  return tools;
};

const ANTHROPIC_TASK_STATE_MARKER = "TASK STATE CONTEXT:\n";
const ANTHROPIC_CURRENT_USER_QUERY_MARKER = "Current user query (act on this now):\n";
const ANTHROPIC_SELECTED_EXTENSIONS_MARKER =
  "SELECTED EXTENSIONS (request-scoped summary):\n";
const ANTHROPIC_EXECUTION_PLAN_PROTOCOL_MARKER = "EXECUTION PLAN PROTOCOL:";
const ANTHROPIC_TOOL_RESULTS_MARKER = "\n\nTool results:\n";
const ANTHROPIC_TOOL_RESULTS_SUFFIX =
  "\n\nIf more tool usage is needed, call tools again. Otherwise provide final answer.";
const ANTHROPIC_DYNAMIC_CONTINUATION_MARKERS = [
  "\n\nRecent confirmed file mutations:\n",
  "\n\nMulti-file progress ledger:\n",
  "\n\nSearch memory:\n",
  "\n\nFile read ledger:\n",
  "\n\nExecution state:\n",
  "\n\nHeuristic nudges:\n",
] as const;
const ANTHROPIC_NORMALIZED_OMITTED_TOOL_RESULTS_PREFIX =
  "[tool results truncated] older results omitted to stay within the prompt budget.";
const OPENAI_CONTINUATION_STABLE_PREFIX_TARGET_CHARS = 4096;
const OPENAI_CONTINUATION_DYNAMIC_CONTEXT_PLACEHOLDER =
  "Dynamic context:\n(raw tool results and runtime facts appear after this stable cache prefix.)";
const OPENAI_CONTINUATION_STABLE_PREFIX_ANCHOR_LINE =
  "Stable cache anchor: dynamic context begins below.\n";
const DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX_TARGET_CHARS = 4096;
const DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX = [
  "Dynamic continuation context:",
  "",
  "Stable runtime fact index:",
  "- Search memory details appear below in the Search memory section.",
  "- File read ledger details appear below in the File read ledger section.",
  "- Execution state and heuristic nudges appear below when present.",
  "- Tool result payloads appear after runtime facts.",
].join("\n");
const DEEPSEEK_DYNAMIC_CONTEXT_STABLE_ANCHOR_LINE =
  "Stable dynamic context anchor: runtime details begin below.\n";

type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
};

type AnthropicImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

const isAnthropicTextBlock = (
  block: AnthropicTextBlock | AnthropicImageBlock
): block is AnthropicTextBlock => block.type === "text";

type AnthropicSystemBlock = AnthropicTextBlock;

const buildAnthropicSystemBlocks = (
  systemProjection: Pick<AnthropicPromptProjection, "systemBlocks">,
  cacheControl: AnthropicCacheControl
): AnthropicSystemBlock[] => {
  const blocks = systemProjection.systemBlocks
    .map(block => ({
      ...block,
      text: block.text.trim(),
    }))
    .filter(block => block.text);
  if (blocks.length === 0) {
    return [];
  }
  return blocks.map(block => ({
    type: "text",
    text: block.text,
    ...(block.cacheable ? { cache_control: cacheControl } : {}),
  }));
};

type AnthropicMessagesRequestBody = {
  model: string;
  stream: true;
  max_tokens: number;
  temperature: number;
  system: AnthropicSystemBlock[];
  tools: AnthropicToolDefinition[];
  tool_choice: { type: string };
  messages: Array<{
    role: "user";
    content: Array<AnthropicTextBlock | AnthropicImageBlock>;
  }>;
};

type AnthropicRequestSnapshotRecord = {
  createdAt: string;
  captureId: string;
  provider: string;
  model: string;
  requestUrl: string;
  requestHeaders?: Record<string, string>;
  summary: {
    systemBlockCount: number;
    toolCount: number;
    messageCount: number;
    userContentBlockCount: number;
    cacheBreakpointPaths: string[];
    resolvedCacheControl: AnthropicCacheControl | null;
    resolvedBetaHeaders: string[];
    systemSplitSummary: {
      cachedSystemTextLength: number;
      uncachedSystemTailTextLength: number;
    };
    previous?: AnthropicPreviousRequestDiagnostic;
    latestUsage?: AnthropicLatestUsageDiagnostic;
  };
  requestBody: AnthropicMessagesRequestBody;
  response?: {
    status: number;
    headers: Record<string, string>;
  };
  usageEvents?: Array<{
    eventType: string;
    usage: unknown;
  }>;
};

type AnthropicRequestCaptureOptions = {
  capture?: boolean;
  directory?: string;
};

type AnthropicPreviousRequestDiagnostic = {
  path: string;
  cacheBreakpointPaths: string[];
  identicalUserContentBlockCount: number;
  previousUserContentBlockCount: number;
  currentUserContentBlockCount: number;
  firstDifferentUserContentBlockIndex: number | null;
  firstDifferentCurrentBlockCacheControl?: boolean;
  firstDifferentPreviousBlockCacheControl?: boolean;
  firstDifferentContentCommonPrefixLength: number;
  firstDifferentContentLeftContext: string;
  firstDifferentContentRightContext: string;
};

type AnthropicLatestUsageDiagnostic = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type AnthropicCapturePrevious = {
  path: string;
  requestBody: AnthropicMessagesRequestBody;
  cacheBreakpointPaths: string[];
};

const anthropicCapturePreviousByKey = new Map<string, AnthropicCapturePrevious>();

const isTruthyEnvFlag = (value: string | undefined) =>
  /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");

const shouldCaptureAnthropicRequests = (env?: NodeJS.ProcessEnv) =>
  isTruthyEnvFlag(env?.CYRENE_CAPTURE_ANTHROPIC_REQUESTS) ||
  isTruthyEnvFlag(env?.CYRENE_DEBUG_HTTP_REQUESTS);

const collectAnthropicCacheBreakpointPaths = (
  requestBody: AnthropicMessagesRequestBody
) => {
  const paths: string[] = [];
  requestBody.tools.forEach((tool, toolIndex) => {
    if (tool.cache_control) {
      paths.push(`tools[${toolIndex}]`);
    }
  });
  requestBody.system.forEach((block, blockIndex) => {
    if (block.cache_control) {
      paths.push(`system[${blockIndex}]`);
    }
  });
  requestBody.messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (isAnthropicTextBlock(block) && block.cache_control) {
        paths.push(`messages[${messageIndex}].content[${blockIndex}]`);
      }
    });
  });
  return paths;
};

const stringifyAnthropicUserContentBlock = (
  block: AnthropicTextBlock | AnthropicImageBlock | undefined
) => {
  if (!block) {
    return "";
  }
  return isAnthropicTextBlock(block) ? block.text : JSON.stringify(block);
};

const hasAnthropicTextCacheControl = (
  block: AnthropicTextBlock | AnthropicImageBlock | undefined
) => Boolean(block && isAnthropicTextBlock(block) && block.cache_control);

const buildAnthropicPreviousRequestDiagnostic = (
  current: AnthropicMessagesRequestBody,
  previous: AnthropicCapturePrevious
): AnthropicPreviousRequestDiagnostic => {
  const currentBlocks = current.messages[0]?.content ?? [];
  const previousBlocks = previous.requestBody.messages[0]?.content ?? [];
  const comparableLength = Math.min(currentBlocks.length, previousBlocks.length);
  let identicalUserContentBlockCount = 0;
  while (
    identicalUserContentBlockCount < comparableLength &&
    JSON.stringify(currentBlocks[identicalUserContentBlockCount]) ===
      JSON.stringify(previousBlocks[identicalUserContentBlockCount])
  ) {
    identicalUserContentBlockCount += 1;
  }

  const firstDifferentUserContentBlockIndex =
    identicalUserContentBlockCount === comparableLength &&
    currentBlocks.length === previousBlocks.length
      ? null
      : identicalUserContentBlockCount;
  const currentDifferent =
    typeof firstDifferentUserContentBlockIndex === "number"
      ? currentBlocks[firstDifferentUserContentBlockIndex]
      : undefined;
  const previousDifferent =
    typeof firstDifferentUserContentBlockIndex === "number"
      ? previousBlocks[firstDifferentUserContentBlockIndex]
      : undefined;
  const currentContent = stringifyAnthropicUserContentBlock(currentDifferent);
  const previousContent = stringifyAnthropicUserContentBlock(previousDifferent);
  const firstDifferentContentDiffIndex =
    typeof firstDifferentUserContentBlockIndex === "number"
      ? findFirstDiffIndex(previousContent, currentContent)
      : null;

  return {
    path: previous.path,
    cacheBreakpointPaths: previous.cacheBreakpointPaths,
    identicalUserContentBlockCount,
    previousUserContentBlockCount: previousBlocks.length,
    currentUserContentBlockCount: currentBlocks.length,
    firstDifferentUserContentBlockIndex,
    ...(currentDifferent
      ? {
          firstDifferentCurrentBlockCacheControl:
            hasAnthropicTextCacheControl(currentDifferent),
        }
      : {}),
    ...(previousDifferent
      ? {
          firstDifferentPreviousBlockCacheControl:
            hasAnthropicTextCacheControl(previousDifferent),
        }
      : {}),
    firstDifferentContentCommonPrefixLength:
      firstDifferentContentDiffIndex ??
      Math.min(previousContent.length, currentContent.length),
    firstDifferentContentLeftContext: sliceDiffContext(
      previousContent,
      firstDifferentContentDiffIndex
    ),
    firstDifferentContentRightContext: sliceDiffContext(
      currentContent,
      firstDifferentContentDiffIndex
    ),
  };
};

const extractAnthropicLatestUsageDiagnostic = (
  usageEvents: Array<{ eventType: string; usage: unknown }>
): AnthropicLatestUsageDiagnostic | undefined => {
  const latestUsage = usageEvents.at(-1)?.usage;
  const usageRecord = asRecord(latestUsage);
  if (!usageRecord) {
    return undefined;
  }
  return {
    ...(typeof usageRecord.input_tokens === "number"
      ? { inputTokens: Math.max(0, Math.floor(usageRecord.input_tokens)) }
      : {}),
    ...(typeof usageRecord.output_tokens === "number"
      ? { outputTokens: Math.max(0, Math.floor(usageRecord.output_tokens)) }
      : {}),
    ...(typeof usageRecord.cache_read_input_tokens === "number"
      ? {
          cacheReadInputTokens: Math.max(
            0,
            Math.floor(usageRecord.cache_read_input_tokens)
          ),
        }
      : {}),
    ...(typeof usageRecord.cache_creation_input_tokens === "number"
      ? {
          cacheCreationInputTokens: Math.max(
            0,
            Math.floor(usageRecord.cache_creation_input_tokens)
          ),
        }
      : {}),
  };
};

const resolveAnthropicSnapshotDir = (options?: {
  appRoot?: string;
  env?: NodeJS.ProcessEnv;
  capture?: AnthropicRequestCaptureOptions;
}) => {
  const configuredDir =
    options?.capture?.directory?.trim() ||
    options?.env?.CYRENE_CAPTURE_ANTHROPIC_REQUESTS_DIR?.trim() ||
    options?.env?.CYRENE_DEBUG_HTTP_REQUESTS_DIR?.trim();
  if (configuredDir) {
    if (isAbsolute(configuredDir)) {
      return resolve(configuredDir);
    }
    return resolve(options?.appRoot ?? process.cwd(), configuredDir);
  }
  return join(
    resolveUserHomeDir({ env: options?.env }),
    ".cyrene",
    "debug",
    "anthropic-requests"
  );
};

const sanitizeAnthropicRequestHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== "x-api-key")
  );

const buildAnthropicRequestHeaders = (
  apiKey: string,
  betaHeaders: string[]
) => ({
  Accept: "text/event-stream",
  "Content-Type": "application/json",
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
  ...(betaHeaders.length > 0
    ? {
        "anthropic-beta": betaHeaders.join(","),
      }
    : {}),
});

const headersToObject = (headers: Headers) => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const updateAnthropicRequestSnapshot = async (
  snapshotPath: string,
  patch: Partial<AnthropicRequestSnapshotRecord>
) => {
  const current = JSON.parse(
    await readFile(snapshotPath, "utf8")
  ) as AnthropicRequestSnapshotRecord;
  const next: AnthropicRequestSnapshotRecord = {
    ...current,
    ...patch,
  };
  await writeFile(snapshotPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
};

const updateAnthropicSnapshotLatestUsage = async (
  snapshotPath: string,
  usageEvents: Array<{ eventType: string; usage: unknown }>
) => {
  const current = JSON.parse(
    await readFile(snapshotPath, "utf8")
  ) as AnthropicRequestSnapshotRecord;
  const latestUsage = extractAnthropicLatestUsageDiagnostic(usageEvents);
  const next: AnthropicRequestSnapshotRecord = {
    ...current,
    usageEvents,
    ...(latestUsage
      ? {
          summary: {
            ...current.summary,
            latestUsage,
          },
        }
      : {}),
  };
  await writeFile(snapshotPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
};

const writeAnthropicRequestSnapshot = async (options: {
  appRoot?: string;
  env?: NodeJS.ProcessEnv;
  capture?: AnthropicRequestCaptureOptions;
  captureId: string;
  provider: string;
  model: string;
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBody: AnthropicMessagesRequestBody;
  resolvedCacheControl: AnthropicCacheControl;
  resolvedBetaHeaders: string[];
  systemProjection: Pick<AnthropicPromptProjection, "systemBlocks">;
}) => {
  const snapshotDir = resolveAnthropicSnapshotDir({
    appRoot: options.appRoot,
    env: options.env,
    capture: options.capture,
  });
  const createdAt = new Date().toISOString();
  const snapshotPath = join(
    snapshotDir,
    `${createdAt.replaceAll(":", "-")}-${options.captureId}.json`
  );
  const cacheBreakpointPaths = collectAnthropicCacheBreakpointPaths(
    options.requestBody
  );
  const cacheIdentity = [
    options.provider,
    options.model,
    options.requestUrl,
  ].join("\u0000");
  const previous = anthropicCapturePreviousByKey.get(cacheIdentity);
  const snapshot: AnthropicRequestSnapshotRecord = {
    createdAt,
    captureId: options.captureId,
    provider: options.provider,
    model: options.model,
    requestUrl: options.requestUrl,
    requestHeaders: sanitizeAnthropicRequestHeaders(options.requestHeaders),
    summary: {
      systemBlockCount: options.requestBody.system.length,
      toolCount: options.requestBody.tools.length,
      messageCount: options.requestBody.messages.length,
      userContentBlockCount:
        options.requestBody.messages[0]?.content.length ?? 0,
      cacheBreakpointPaths,
      resolvedCacheControl: options.resolvedCacheControl,
      resolvedBetaHeaders: options.resolvedBetaHeaders,
      systemSplitSummary: {
        cachedSystemTextLength: options.systemProjection.systemBlocks
          .filter(block => block.cacheable)
          .reduce((total, block) => total + block.text.length, 0),
        uncachedSystemTailTextLength: options.systemProjection.systemBlocks
          .filter(block => !block.cacheable)
          .reduce((total, block) => total + block.text.length, 0),
      },
      ...(previous
        ? {
            previous: buildAnthropicPreviousRequestDiagnostic(
              options.requestBody,
              previous
            ),
          }
        : {}),
    },
    requestBody: options.requestBody,
  };
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  anthropicCapturePreviousByKey.set(cacheIdentity, {
    path: snapshotPath,
    requestBody: options.requestBody,
    cacheBreakpointPaths,
  });
  return snapshotPath;
};

const splitAnthropicSystemPromptForCaching = (systemPrompt: string) => {
  const extensionIndex = systemPrompt.indexOf(
    ANTHROPIC_SELECTED_EXTENSIONS_MARKER
  );
  if (extensionIndex < 0) {
    return {
      systemBlocks: [{ text: systemPrompt.trim(), cacheable: true }],
    };
  }

  const executionPlanIndex = systemPrompt.indexOf(
    ANTHROPIC_EXECUTION_PLAN_PROTOCOL_MARKER,
    extensionIndex + ANTHROPIC_SELECTED_EXTENSIONS_MARKER.length
  );
  if (executionPlanIndex < 0) {
    return {
      systemBlocks: [{ text: systemPrompt.trim(), cacheable: true }],
    };
  }

  const prefixText = systemPrompt.slice(0, extensionIndex).trim();
  const extensionText = systemPrompt
    .slice(extensionIndex, executionPlanIndex)
    .trim();
  const suffixText = systemPrompt.slice(executionPlanIndex).trim();

  return {
    systemBlocks: [
      { text: prefixText, cacheable: true },
      { text: extensionText, cacheable: false },
      { text: suffixText, cacheable: true },
    ].filter(block => block.text),
  };
};

const splitAnthropicPromptForCaching = (
  query: string,
  fallbackSystemPrompt: string
): AnthropicPromptProjection => {
  const taskStateIndex = query.indexOf(ANTHROPIC_TASK_STATE_MARKER);
  if (taskStateIndex <= 0) {
    return {
      systemBlocks: [{ text: fallbackSystemPrompt.trim(), cacheable: true }],
      userText: query,
    };
  }

  const stablePrefix = query.slice(0, taskStateIndex).trim();
  const dynamicSuffix = query.slice(taskStateIndex).trim();

  if (!stablePrefix || !dynamicSuffix) {
    return {
      systemBlocks: [{ text: fallbackSystemPrompt.trim(), cacheable: true }],
      userText: query,
    };
  }

  const systemSplit = splitAnthropicSystemPromptForCaching(stablePrefix);
  return {
    systemBlocks: systemSplit.systemBlocks,
    userText: dynamicSuffix,
  };
};

const splitOpenAiPromptForCaching = (
  query: string,
  fallbackSystemPrompt: string
): OpenAiPromptProjection => {
  const stableSystemPrompt = fallbackSystemPrompt.trim();
  const joinStableSystemPrompt = (parts: Array<string | undefined>) =>
    [stableSystemPrompt, ...parts.map(part => part?.trim()).filter(Boolean)]
      .filter(Boolean)
      .join("\n\n");
  const taskStateIndex = query.indexOf(ANTHROPIC_TASK_STATE_MARKER);
  if (taskStateIndex <= 0) {
    const continuationProjection = splitOpenAiContinuationPromptForCaching(
      query,
      stableSystemPrompt
    );
    if (continuationProjection) {
      return continuationProjection;
    }
    return {
      systemPrompt: stableSystemPrompt,
      userText: query,
    };
  }

  const stablePrefix = query.slice(0, taskStateIndex).trim();
  const dynamicSuffix = query.slice(taskStateIndex).trim();
  if (!stablePrefix || !dynamicSuffix) {
    return {
      systemPrompt: stableSystemPrompt,
      userText: query,
    };
  }

  const systemSplit = splitAnthropicSystemPromptForCaching(stablePrefix);
  return {
    systemPrompt: joinStableSystemPrompt(
      systemSplit.systemBlocks.map(block => block.text)
    ),
    userText: dynamicSuffix,
  };
};

const splitOpenAiContinuationPromptForCaching = (
  query: string,
  fallbackSystemPrompt: string
): OpenAiPromptProjection | null => {
  const continuationParts = splitOpenAiContinuationPromptParts(query);
  if (!continuationParts) {
    return null;
  }

  return {
    systemPrompt: fallbackSystemPrompt.trim(),
    userText: [
      continuationParts.stableUserPrefix,
      continuationParts.dynamicUserText,
    ].filter(Boolean).join("\n\n"),
  };
};

const splitOpenAiContinuationPromptParts = (
  query: string
): OpenAiContinuationPromptParts | null => {
  const toolResultsIndex = query.indexOf(ANTHROPIC_TOOL_RESULTS_MARKER);
  if (toolResultsIndex <= 0) {
    return null;
  }

  const prefixText = query.slice(0, toolResultsIndex).trim();
  const remainder = query.slice(toolResultsIndex + ANTHROPIC_TOOL_RESULTS_MARKER.length);
  if (!prefixText || !remainder.trim()) {
    return null;
  }

  const { stablePrefix, dynamicPrefix } =
    splitAnthropicContinuationPrefix(prefixText);
  if (!stablePrefix) {
    return null;
  }

  const suffixIndex = remainder.indexOf(ANTHROPIC_TOOL_RESULTS_SUFFIX);
  const toolResultsText =
    suffixIndex >= 0 ? remainder.slice(0, suffixIndex).trim() : remainder.trim();
  const suffixText =
    suffixIndex >= 0 ? remainder.slice(suffixIndex).trim() : "";
  const normalizedToolResultsText =
    normalizeOpenAiContinuationToolResultsText(toolResultsText);
  const stableUserPrefix =
    buildOpenAiContinuationStableUserPrefix(stablePrefix);

  return {
    stableUserPrefix,
    dynamicUserText: [
    `Tool results:\n${normalizedToolResultsText}`,
    dynamicPrefix,
    suffixText,
    ].filter(Boolean).join("\n\n"),
  };
};

const splitAnthropicUserTextAroundCurrentQuery = (userText: string) => {
  const queryIndex = userText.indexOf(ANTHROPIC_CURRENT_USER_QUERY_MARKER);
  if (queryIndex <= 0) {
    return null;
  }
  const stablePrefix = userText.slice(0, queryIndex).trim();
  const currentQuery = userText.slice(queryIndex).trim();
  if (!stablePrefix || !currentQuery) {
    return null;
  }
  return {
    stablePrefix,
    currentQuery,
  };
};

const parseAnthropicToolResultBlocks = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "(none)") {
    return [];
  }

  return trimmed
    .split(/\n\n(?=\[tool_result\]\s+)/)
    .map(part => part.trim())
    .filter(Boolean);
};

const normalizeOpenAiContinuationToolResultsText = (text: string) => {
  const parsedToolResults = parseAnthropicToolResultBlocks(text);
  if (
    parsedToolResults.length === 0 ||
    !parsedToolResults[0]?.startsWith("[tool results truncated]")
  ) {
    return text;
  }

  return [
    normalizeAnthropicOmittedToolResultsPrefix(parsedToolResults[0] ?? ""),
    ...parsedToolResults.slice(1),
  ].join("\n\n");
};

const buildOpenAiContinuationStableUserPrefix = (stablePrefix: string) => {
  const basePrefix = [
    stablePrefix.trim(),
    OPENAI_CONTINUATION_DYNAMIC_CONTEXT_PLACEHOLDER,
  ].filter(Boolean).join("\n\n");

  if (basePrefix.length >= OPENAI_CONTINUATION_STABLE_PREFIX_TARGET_CHARS) {
    return basePrefix;
  }

  const paddingLength =
    OPENAI_CONTINUATION_STABLE_PREFIX_TARGET_CHARS - basePrefix.length;
  const padding = OPENAI_CONTINUATION_STABLE_PREFIX_ANCHOR_LINE.repeat(
    Math.ceil(
      paddingLength / OPENAI_CONTINUATION_STABLE_PREFIX_ANCHOR_LINE.length
    )
  );
  return `${basePrefix}\n\n${padding}`;
};

const buildDeepSeekDynamicContextStablePrefix = () => {
  if (
    DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX.length >=
    DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX_TARGET_CHARS
  ) {
    return DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX;
  }

  const paddingLength =
    DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX_TARGET_CHARS -
    DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX.length;
  const padding = DEEPSEEK_DYNAMIC_CONTEXT_STABLE_ANCHOR_LINE.repeat(
    Math.ceil(
      paddingLength / DEEPSEEK_DYNAMIC_CONTEXT_STABLE_ANCHOR_LINE.length
    )
  );
  return `${DEEPSEEK_DYNAMIC_CONTEXT_STABLE_PREFIX}\n\n${padding}`;
};

const splitAnthropicContinuationPrefix = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      stablePrefix: "",
      dynamicPrefix: "",
    };
  }

  let dynamicStart = -1;
  for (const marker of ANTHROPIC_DYNAMIC_CONTINUATION_MARKERS) {
    const index = trimmed.indexOf(marker);
    if (index >= 0 && (dynamicStart === -1 || index < dynamicStart)) {
      dynamicStart = index;
    }
  }

  if (dynamicStart < 0) {
    return {
      stablePrefix: trimmed,
      dynamicPrefix: "",
    };
  }

  return {
    stablePrefix: trimmed.slice(0, dynamicStart).trim(),
    dynamicPrefix: trimmed.slice(dynamicStart).trim(),
  };
};

const normalizeAnthropicOmittedToolResultsPrefix = (text: string) => {
  if (!text.startsWith("[tool results truncated]")) {
    return text;
  }
  return ANTHROPIC_NORMALIZED_OMITTED_TOOL_RESULTS_PREFIX;
};

const buildAnthropicUserBlocks = (
  userText: string,
  cacheControl: AnthropicCacheControl,
  attachments: EncodedImageAttachment[]
): Array<AnthropicTextBlock | AnthropicImageBlock> => {
  const imageBlocks: AnthropicImageBlock[] = attachments.map(attachment => ({
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.mimeType,
      data: attachment.data,
    },
  }));
  const toolResultsIndex = userText.indexOf(ANTHROPIC_TOOL_RESULTS_MARKER);
  if (toolResultsIndex >= 0) {
    const prefixText = userText.slice(0, toolResultsIndex).trim();
    const remainder = userText.slice(toolResultsIndex + ANTHROPIC_TOOL_RESULTS_MARKER.length);
    const suffixIndex = remainder.indexOf(ANTHROPIC_TOOL_RESULTS_SUFFIX);
    const toolResultsText =
      suffixIndex >= 0 ? remainder.slice(0, suffixIndex).trim() : remainder.trim();
    const suffixText =
      suffixIndex >= 0 ? remainder.slice(suffixIndex).trim() : "";
    const { stablePrefix, dynamicPrefix } =
      splitAnthropicContinuationPrefix(prefixText);
    const parsedToolResults = parseAnthropicToolResultBlocks(toolResultsText);
    const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = [...imageBlocks];

    const shouldCacheStablePrefix = parsedToolResults.length === 0;
    if (stablePrefix) {
      blocks.push({
        type: "text",
        text: parsedToolResults.length
          ? `${stablePrefix}\n\nTool results:`
          : stablePrefix,
        ...(shouldCacheStablePrefix ? { cache_control: cacheControl } : {}),
      });
    }

    const omittedPrefix =
      parsedToolResults[0]?.startsWith("[tool results truncated]")
        ? normalizeAnthropicOmittedToolResultsPrefix(parsedToolResults.shift() ?? "")
        : "";
    let omittedPrefixBlockIndex: number | null = null;
    if (omittedPrefix) {
      omittedPrefixBlockIndex = blocks.length;
      blocks.push({ type: "text", text: omittedPrefix });
    }

    const toolResultBlockIndexes: number[] = [];
    parsedToolResults.forEach(result => {
      toolResultBlockIndexes.push(blocks.length);
      blocks.push({
        type: "text",
        text: result,
      });
    });

    const toolResultCacheBreakpointIndexes =
      omittedPrefixBlockIndex === null
        ? toolResultBlockIndexes.slice(-2)
        : [
            omittedPrefixBlockIndex,
            ...toolResultBlockIndexes.slice(-1),
          ];
    for (const index of toolResultCacheBreakpointIndexes) {
      const block = blocks[index];
      if (block && isAnthropicTextBlock(block)) {
        blocks[index] = {
          ...block,
          cache_control: cacheControl,
        };
      }
    }

    if (!parsedToolResults.length && toolResultsText) {
      blocks.push({
        type: "text",
        text: stablePrefix
          ? toolResultsText
          : `Tool results:\n${toolResultsText}`,
      });
    }

    if (dynamicPrefix) {
      blocks.push({ type: "text", text: dynamicPrefix });
    }

    if (suffixText) {
      blocks.push({ type: "text", text: suffixText });
    }

    if (blocks.length > 0) {
      const firstCacheableBlockIndex = blocks.findIndex(isAnthropicTextBlock);
      if (
        firstCacheableBlockIndex >= 0 &&
        !blocks.some(block => isAnthropicTextBlock(block) && block.cache_control)
      ) {
        const firstCacheableBlock = blocks[firstCacheableBlockIndex];
        if (firstCacheableBlock && isAnthropicTextBlock(firstCacheableBlock)) {
          blocks[firstCacheableBlockIndex] = {
            ...firstCacheableBlock,
            cache_control: cacheControl,
          };
        }
      }
      return blocks;
    }
  }

  const querySplit = splitAnthropicUserTextAroundCurrentQuery(userText);
  if (querySplit) {
    return [
      ...imageBlocks,
      {
        type: "text",
        text: querySplit.stablePrefix,
        cache_control: cacheControl,
      },
      {
        type: "text",
        text: querySplit.currentQuery,
      },
    ];
  }

  return [
    ...imageBlocks,
    {
      type: "text",
      text: userText,
      cache_control: cacheControl,
    },
  ];
};

const buildAnthropicMessagesRequestBody = (options: {
  model: string;
  temperature: number;
  promptProjection: AnthropicPromptProjection;
  userText: string;
  attachments?: EncodedImageAttachment[];
  mcpTools: McpToolDescriptor[];
  cacheControl: AnthropicCacheControl;
}): AnthropicMessagesRequestBody => ({
  model: options.model,
  stream: true,
  max_tokens: 4096,
  temperature: options.temperature,
  system: buildAnthropicSystemBlocks(options.promptProjection, options.cacheControl),
  tools: buildAnthropicTools(options.mcpTools, options.cacheControl),
  tool_choice: { type: "auto" },
  messages: [
    {
      role: "user",
      content: buildAnthropicUserBlocks(
        options.userText,
        options.cacheControl,
        options.attachments ?? []
      ),
    },
  ],
});

const sortMcpToolsForStablePromptCache = (tools: McpToolDescriptor[]) =>
  [...tools].sort((left, right) =>
    `${left.serverId}\u0000${left.name}\u0000${left.id}`.localeCompare(
      `${right.serverId}\u0000${right.name}\u0000${right.id}`
    )
  );

const buildToolUsageSystemPrompt = (
  mcpTools: McpToolDescriptor[],
  basePrompt = TOOL_USAGE_SYSTEM_PROMPT
) => {
  const visibleTools = buildTransportMcpTools(mcpTools)
    .map(tool => {
      const description = (tool.description ?? tool.label).trim();
      const routeNote = tool.renamedForTransport
        ? ` routes to ${tool.namespacedName}`
        : ` routes to ${tool.namespacedName}`;
      return description
        ? `- ${tool.transportName}:${routeNote}. ${description}`
        : `- ${tool.transportName}:${routeNote}.`;
    });

  if (visibleTools.length === 0) {
    return basePrompt;
  }

  return [
    basePrompt,
    "Tool visibility note: the model sees the built-in `file` tool plus provider-safe MCP tool names. The `file` tool folds local filesystem/search/git/semantic/shell actions behind its `action` field; remote MCP tools are exposed separately below.",
    "Additional available MCP tools:",
    ...visibleTools,
    "Use these additional tools directly when they are a better match than `file`.",
  ].join("\n");
};

const resolveProviderEndpointOverrideUrl = (
  baseUrl: string,
  override: string
) => {
  const trimmed = override.trim();
  if (!trimmed) {
    throw new Error("Provider endpoint override cannot be empty.");
  }
  const repaired = repairCommonSchemeTypos(trimmed);
  try {
    const absolute = new URL(repaired);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      throw new Error("Provider endpoint override must use http or https.");
    }
    return absolute.toString();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Provider endpoint override must use http or https."
    ) {
      throw error;
    }
  }

  const normalized = normalizeProviderBaseUrl(baseUrl);
  const baseWithSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return new URL(repaired, baseWithSlash).toString();
};

const resolveChatCompletionsUrl = (
  baseUrl: string,
  endpointOverride?: string | null
) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride);
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const family = resolveProviderFamily(normalized);
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (family === "glm") {
    return normalized.endsWith("/api/paas/v4") || normalized.endsWith("/v4")
      ? `${normalized}/chat/completions`
      : `${normalized}/chat/completions`;
  }
  if (normalized.endsWith("/openai")) {
    return `${normalized}/chat/completions`;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};

const resolveResponsesUrls = (baseUrl: string, endpointOverride?: string | null) => {
  if (endpointOverride?.trim()) {
    return [resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride)];
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (normalized.endsWith("/responses")) {
    return [normalized];
  }
  if (normalized.endsWith("/openai")) {
    return [`${normalized}/responses`];
  }
  if (normalized.endsWith("/v1")) {
    return [`${normalized}/responses`];
  }
  return [`${normalized}/responses`, `${normalized}/v1/responses`];
};

const resolveModelsUrl = (baseUrl: string, endpointOverride?: string | null) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride);
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const family = resolveProviderFamily(normalized);
  if (normalized.endsWith("/models")) {
    return normalized;
  }
  if (family === "glm") {
    return normalized.endsWith("/api/paas/v4") || normalized.endsWith("/v4")
      ? `${normalized}/models`
      : `${normalized}/models`;
  }
  if (normalized.endsWith("/openai")) {
    return `${normalized}/models`;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
};

const resolveAnthropicMessagesUrl = (
  baseUrl: string,
  endpointOverride?: string | null
) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(baseUrl, endpointOverride);
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (normalized.endsWith("/messages")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
};

const resolveGeminiGenerateContentUrl = (
  baseUrl: string,
  model: string,
  endpointOverride?: string | null
) => {
  if (endpointOverride?.trim()) {
    return resolveProviderEndpointOverrideUrl(
      baseUrl,
      endpointOverride.replaceAll("{model}", encodeURIComponent(model))
    );
  }
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (normalized.includes("/openai")) {
    throw new Error(
      "gemini_generate_content requires a native Gemini base URL, not the OpenAI-compatible /openai endpoint."
    );
  }
  if (/\/models\/[^/?#]+$/.test(normalized)) {
    return `${normalized}:streamGenerateContent?alt=sse`;
  }
  if (normalized.endsWith("/models")) {
    return `${normalized}/${model}:streamGenerateContent?alt=sse`;
  }
  if (normalized.endsWith("/v1beta")) {
    return `${normalized}/models/${model}:streamGenerateContent?alt=sse`;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/models/${model}:streamGenerateContent?alt=sse`;
  }
  return `${normalized}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
};
const DONE_EVENT = JSON.stringify({ type: "done" });

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
};

const readStreamChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
) => {
  throwIfAborted(signal);
  try {
    const result = await reader.read();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        // Ignore reader cancellation failures after an abort.
      }
    }
    throw error;
  }
};
const buildCompletionEvent = (completion: {
  source: "provider" | "runtime";
  reason: string;
  detail?: string;
  expected?: boolean;
}) =>
  JSON.stringify({
    type: "completion",
    source: completion.source,
    reason: completion.reason,
    ...(completion.detail ? { detail: completion.detail } : {}),
    ...(typeof completion.expected === "boolean"
      ? { expected: completion.expected }
      : {}),
  });

const buildProviderCompletionEvent = (
  reason: string,
  detail: string,
  expected: boolean
) =>
  buildCompletionEvent({
    source: "provider",
    reason,
    detail,
    expected,
  });

const buildStreamInterruptionEvent = (detail: string) =>
  JSON.stringify({
    type: "text_delta",
    text: `\n[model stream interrupted] ${detail}\n`,
  });

const buildUnexpectedSocketCloseEvent = () =>
  buildStreamInterruptionEvent(
    "The stream closed before the provider sent an explicit completion signal."
  );

const buildUnexpectedSocketCloseCompletionEvent = () =>
  buildProviderCompletionEvent(
    "unexpected_socket_close",
    "The stream closed before the provider sent an explicit completion signal.",
    false
  );

const buildOpenAiFinishReasonInterruptionEvent = (finishReason: string) => {
  switch (finishReason) {
    case "length":
      return buildStreamInterruptionEvent(
        "The model hit the output limit before finishing the task."
      );
    case "content_filter":
      return buildStreamInterruptionEvent(
        "The provider stopped the response due to content filtering."
      );
    default:
      return buildStreamInterruptionEvent(
        `The provider ended the response with finish_reason=${finishReason}.`
      );
  }
};

const buildOpenAiFinishReasonCompletionEvent = (finishReason: string) =>
  buildProviderCompletionEvent(
    `finish_reason:${finishReason}`,
    `The provider ended the response with finish_reason=${finishReason}.`,
    finishReason === "stop" || finishReason === "tool_calls"
  );

const extractResponseCompletionDetail = (response: unknown) => {
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as {
    error?: unknown;
    incomplete_details?: unknown;
  };
  return (
    extractHttpFailureDetail(record.error) ??
    extractHttpFailureDetail(record.incomplete_details)
  );
};

const buildResponsesStatusInterruptionEvent = (
  status: string,
  response: unknown
) => {
  const detail = extractResponseCompletionDetail(response);
  if (status === "incomplete") {
    return buildStreamInterruptionEvent(
      detail
        ? `The provider marked the response incomplete: ${detail}`
        : "The provider marked the response incomplete before finishing the task."
    );
  }
  if (status === "failed") {
    return buildStreamInterruptionEvent(
      detail
        ? `The provider reported response failure: ${detail}`
        : "The provider reported response.status=failed."
    );
  }
  if (status === "cancelled" || status === "canceled") {
    return buildStreamInterruptionEvent(
      detail
        ? `The provider cancelled the response: ${detail}`
        : "The provider cancelled the response before completion."
    );
  }
  return buildStreamInterruptionEvent(
    detail
      ? `The provider ended the response with status=${status}: ${detail}`
      : `The provider ended the response with status=${status}.`
  );
};

const buildResponsesStatusCompletionEvent = (
  status: string,
  response: unknown
) => {
  const detail = extractResponseCompletionDetail(response);
  return buildProviderCompletionEvent(
    `response_status:${status}`,
    detail
      ? `The provider ended the response with status=${status}: ${detail}`
      : `The provider ended the response with status=${status}.`,
    status === "completed"
  );
};

const isAnthropicExpectedStopReason = (stopReason: string) =>
  stopReason === "end_turn" ||
  stopReason === "tool_use" ||
  stopReason === "stop_sequence";

const buildAnthropicStopReasonInterruptionEvent = (stopReason: string) => {
  switch (stopReason) {
    case "max_tokens":
      return buildStreamInterruptionEvent(
        "The model hit the output limit before finishing the task."
      );
    case "refusal":
      return buildStreamInterruptionEvent(
        "The provider refused to continue the response."
      );
    default:
      return buildStreamInterruptionEvent(
        `The provider ended the response with stop_reason=${stopReason}.`
      );
  }
};

const buildAnthropicStopReasonCompletionEvent = (stopReason: string) =>
  buildProviderCompletionEvent(
    `stop_reason:${stopReason}`,
    `The provider ended the response with stop_reason=${stopReason}.`,
    isAnthropicExpectedStopReason(stopReason)
  );

const extractAnthropicStreamErrorEvent = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    type?: unknown;
    error?: unknown;
  };
  if (record.type !== "error") {
    return null;
  }

  const detail =
    extractHttpFailureDetail(record.error) ?? extractHttpFailureDetail(payload);
  return buildStreamInterruptionEvent(
    detail
      ? `Anthropic stream error: ${detail}`
      : "Anthropic reported a stream error before completion."
  );
};

const buildGeminiFinishReasonInterruptionEvent = (finishReason: string) => {
  switch (finishReason) {
    case "MAX_TOKENS":
      return buildStreamInterruptionEvent(
        "The model hit the output limit before finishing the task."
      );
    case "SAFETY":
      return buildStreamInterruptionEvent(
        "The provider stopped the response due to safety filtering."
      );
    case "RECITATION":
      return buildStreamInterruptionEvent(
        "The provider stopped the response due to recitation safeguards."
      );
    default:
      return buildStreamInterruptionEvent(
        `The provider ended the response with finishReason=${finishReason}.`
      );
  }
};

const buildGeminiFinishReasonCompletionEvent = (finishReason: string) =>
  buildProviderCompletionEvent(
    `finish_reason:${finishReason}`,
    `The provider ended the response with finishReason=${finishReason}.`,
    finishReason === "STOP"
  );

const extractGeminiInterruptionEvent = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    candidates?: unknown;
    promptFeedback?: unknown;
  };
  if (Array.isArray(record.candidates)) {
    for (const candidate of record.candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const finishReason = (candidate as { finishReason?: unknown }).finishReason;
      if (typeof finishReason === "string" && finishReason && finishReason !== "STOP") {
        return buildGeminiFinishReasonInterruptionEvent(finishReason);
      }
    }
  }

  const blockReason =
    record.promptFeedback &&
    typeof record.promptFeedback === "object" &&
    typeof (record.promptFeedback as { blockReason?: unknown }).blockReason === "string"
      ? String((record.promptFeedback as { blockReason?: unknown }).blockReason)
      : "";
  if (blockReason) {
    return buildStreamInterruptionEvent(
      `The provider blocked the prompt with blockReason=${blockReason}.`
    );
  }

  return null;
};

const extractGeminiCompletionEvent = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    candidates?: unknown;
    promptFeedback?: unknown;
  };
  if (Array.isArray(record.candidates)) {
    for (const candidate of record.candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const finishReason = (candidate as { finishReason?: unknown }).finishReason;
      if (typeof finishReason === "string" && finishReason) {
        return buildGeminiFinishReasonCompletionEvent(finishReason);
      }
    }
  }

  const blockReason =
    record.promptFeedback &&
    typeof record.promptFeedback === "object" &&
    typeof (record.promptFeedback as { blockReason?: unknown }).blockReason === "string"
      ? String((record.promptFeedback as { blockReason?: unknown }).blockReason)
      : "";
  if (blockReason) {
    return buildProviderCompletionEvent(
      `prompt_block:${blockReason}`,
      `The provider blocked the prompt with blockReason=${blockReason}.`,
      false
    );
  }

  return null;
};

const resolveProviderBaseUrl = safeNormalizeProviderBaseUrl;
const joinVisibleParts = (parts: string[]) => parts.filter(Boolean).join("");

const extractTextValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    value?: unknown;
    text?: unknown;
  };
  if (typeof record.value === "string") {
    return record.value;
  }
  if (typeof record.text === "string") {
    return record.text;
  }

  return "";
};

const extractReasoningText = (value: unknown, depth = 0): string => {
  if (depth > 4) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return joinVisibleParts(
      value.map(item => extractReasoningText(item, depth + 1))
    );
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    type?: unknown;
    text?: unknown;
    value?: unknown;
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
    summary?: unknown;
  };
  const type = typeof record.type === "string" ? record.type : undefined;

  if (
    type === "text" ||
    type === "output_text" ||
    type === "input_text" ||
    type === "reasoning" ||
    type === "reasoning_text" ||
    type === "thinking" ||
    type === "summary_text"
  ) {
    return joinVisibleParts([
      extractTextValue(record.text),
      extractTextValue(record.value),
      extractReasoningText(record.content, depth + 1),
    ]);
  }

  return joinVisibleParts([
    extractTextValue(record.text),
    extractTextValue(record.value),
    extractReasoningText(record.content, depth + 1),
    extractReasoningText(record.reasoning, depth + 1),
    extractReasoningText(record.reasoning_content, depth + 1),
    extractReasoningText(record.thinking, depth + 1),
    extractReasoningText(record.summary, depth + 1),
  ]);
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const typedContent = content as {
      type?: unknown;
      text?: unknown;
    };
    if (
      typedContent.type === "text" ||
      typedContent.type === "output_text" ||
      typedContent.type === "input_text"
    ) {
      return extractTextValue(typedContent.text);
    }
    return "";
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const stringParts = content.filter(
    (item): item is string => typeof item === "string"
  );
  const typedItems = content
    .filter(
      (item): item is { type?: unknown; text?: unknown } =>
        Boolean(item) && typeof item === "object"
    )
    .filter(
      item =>
        item.type === "text" ||
        item.type === "output_text" ||
        item.type === "input_text"
    );
  const preferredTypedItems = typedItems.some(item => item.type === "output_text")
    ? typedItems.filter(item => item.type === "output_text")
    : typedItems.filter(item => item.type === "text");

  return joinVisibleParts([
    ...stringParts,
    ...preferredTypedItems.map(item => extractTextValue(item.text)),
  ]);
};

const extractVisibleDeltaText = (
  delta: unknown,
  options?: { includeReasoning?: boolean }
) => {
  if (!delta || typeof delta !== "object") {
    return "";
  }

  const typedDelta = delta as {
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
  };

  return joinVisibleParts(
    [
      extractTextContent(typedDelta.content),
      options?.includeReasoning
        ? extractReasoningText(typedDelta.reasoning_content)
        : "",
      options?.includeReasoning
        ? extractReasoningText(typedDelta.reasoning)
        : "",
      options?.includeReasoning ? extractReasoningText(typedDelta.thinking) : "",
    ].filter(Boolean)
  );
};

const buildOpenAIChatUserContent = (
  input: QueryInput,
  attachments: EncodedImageAttachment[]
) =>
  attachments.length > 0
    ? [
        ...(input.text.trim()
          ? [
              {
                type: "text",
                text: input.text,
              },
            ]
          : []),
        ...attachments.map(attachment => ({
          type: "image_url",
          image_url: {
            url: attachment.dataUrl,
          },
        })),
      ]
    : input.text;

type OpenAIChatMessage = {
  role: "system" | "user";
  content: ReturnType<typeof buildOpenAIChatUserContent>;
};

const splitProjectedOpenAiContinuationUserText = (
  userText: string
): OpenAiContinuationPromptParts | null => {
  const toolResultsIndex = userText.indexOf(ANTHROPIC_TOOL_RESULTS_MARKER);
  if (toolResultsIndex <= 0) {
    return null;
  }
  const stableUserPrefix = userText.slice(0, toolResultsIndex).trim();
  const dynamicUserText = userText
    .slice(toolResultsIndex + ANTHROPIC_TOOL_RESULTS_MARKER.length)
    .trim();
  if (!stableUserPrefix || !dynamicUserText) {
    return null;
  }
  const dynamicSections = splitTextIntoDoubleNewlineSections(dynamicUserText);
  const runtimeSections = dynamicSections.filter(section =>
    sectionStartsWithAny(section, [
      ...ANTHROPIC_DYNAMIC_CONTINUATION_MARKERS,
      ANTHROPIC_TOOL_RESULTS_SUFFIX,
    ])
  );
  const toolResultSections = dynamicSections.filter(
    section =>
      !sectionStartsWithAny(section, [
        ...ANTHROPIC_DYNAMIC_CONTINUATION_MARKERS,
        ANTHROPIC_TOOL_RESULTS_SUFFIX,
      ])
  );
  return {
    stableUserPrefix,
    dynamicUserText: [
      buildDeepSeekDynamicContextStablePrefix(),
      ...runtimeSections,
      "Tool results:",
      ...toolResultSections,
    ].filter(Boolean).join("\n\n"),
  };
};

const buildDeepSeekOpenAIChatMessages = (options: {
  systemPrompt: string;
  userText: string;
  projectedInput: QueryInput;
  attachments: EncodedImageAttachment[];
}): OpenAIChatMessage[] => {
  const continuationParts = splitProjectedOpenAiContinuationUserText(options.userText);
  if (!continuationParts || options.attachments.length > 0) {
    return [
      { role: "system", content: options.systemPrompt },
      {
        role: "user",
        content: buildOpenAIChatUserContent(options.projectedInput, options.attachments),
      },
    ];
  }

  return [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: continuationParts.stableUserPrefix },
    { role: "user", content: continuationParts.dynamicUserText },
  ];
};

const buildOpenAIResponsesInput = (
  input: QueryInput,
  attachments: EncodedImageAttachment[]
) => [
  {
    role: "user",
    content: [
      ...(input.text.trim()
        ? [
            {
              type: "input_text",
              text: input.text,
            },
          ]
        : []),
      ...attachments.map(attachment => ({
        type: "input_image",
        image_url: attachment.dataUrl,
      })),
    ],
  },
];

const buildOpenAIResponsesRequestBody = (options: {
  model: string;
  provider: string;
  input: QueryInput;
  attachments: EncodedImageAttachment[];
  temperature?: number;
  systemPrompt?: string;
  mcpTools: McpToolDescriptor[];
  cacheConfig?: OpenAiPromptCacheConfig | null;
  includeCacheConfig?: boolean;
  env?: NodeJS.ProcessEnv;
}) => ({
  model: options.model,
  ...(typeof options.temperature === "number"
    ? { temperature: options.temperature }
    : {}),
  ...(options.cacheConfig && options.includeCacheConfig !== false
    ? buildOpenAiPromptCacheFields(options.cacheConfig)
    : {}),
  stream: true,
  tool_choice: "auto" as const,
  ...(shouldPreferPromptBeforeTools({
    provider: options.provider,
    model: options.model,
    env: options.env,
  }) && !shouldPreferToolsBeforePrompt({ cacheConfig: options.cacheConfig })
    ? {
        instructions: options.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT,
        input: buildOpenAIResponsesInput(options.input, options.attachments),
        tools: buildOpenAIResponsesTools(options.mcpTools),
      }
    : {
        tools: buildOpenAIResponsesTools(options.mcpTools),
        instructions: options.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT,
        input: buildOpenAIResponsesInput(options.input, options.attachments),
      }),
});

const buildGeminiUserParts = (
  input: QueryInput,
  attachments: EncodedImageAttachment[]
) => [
  ...(input.text.trim()
    ? [
        {
          text: input.text,
        },
      ]
    : []),
  ...attachments.map(attachment => ({
    inlineData: {
      mimeType: attachment.mimeType,
      data: attachment.data,
    },
  })),
];

async function* streamSseOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: QueryInput,
  options?: {
    includeReasoning?: boolean;
    temperature?: number;
    family?: ProviderFamily;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
    appRoot?: string;
    env?: NodeJS.ProcessEnv;
    promptCacheCapabilities?: OpenAiPromptCacheCapabilityStore;
    signal?: AbortSignal;
  }
): AsyncGenerator<string> {
  throwIfAborted(options?.signal);
  const attachments = await encodeImageAttachments(
    input.attachments ?? [],
    options?.appRoot ?? process.cwd()
  );
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (options?.family === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  }

  const requestUrl = resolveChatCompletionsUrl(
    baseUrl,
    options?.endpointOverride
  );
  const cacheCapability = getOpenAiPromptCacheCapability(
    options?.promptCacheCapabilities,
    {
      provider: baseUrl,
      model,
      format: "openai_chat",
    }
  );
  const cacheConfig = resolveOpenAiPromptCacheConfig({
    env: options?.env,
    provider: baseUrl,
    model,
    family: options?.family,
    format: "openai_chat",
    appRoot: options?.appRoot,
    mcpTools: options?.mcpTools,
    systemPrompt: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT,
    capability: cacheCapability,
  });
  const promptProjection = splitOpenAiPromptForCaching(
    input.text,
    options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT
  );
  const baseSystemPrompt = (options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT).trim();
  let effectiveSystemPrompt = promptProjection.systemPrompt;
  let effectiveUserText = promptProjection.userText;
  const isDeepSeekRequest = resolveDeepSeekCompatibilityMode({
    provider: baseUrl,
    model,
    env: options?.env,
  });
  if (isDeepSeekRequest) {
    if (
      effectiveSystemPrompt.startsWith(baseSystemPrompt) &&
      effectiveSystemPrompt.length > baseSystemPrompt.length
    ) {
      const stableSystemExtra = effectiveSystemPrompt
        .slice(baseSystemPrompt.length)
        .trim();
      effectiveSystemPrompt = baseSystemPrompt;
      effectiveUserText = stableSystemExtra
        ? stableSystemExtra + "\n\n" + effectiveUserText
        : effectiveUserText;
    }
  }
  const projectedInput: QueryInput = {
    ...input,
    text: effectiveUserText,
  };
  const promptBeforeTools = shouldPreferPromptBeforeTools({
    provider: baseUrl,
    model,
    env: options?.env,
  }) && !shouldPreferToolsBeforePrompt({ cacheConfig });
  const buildChatMessages = () =>
    isDeepSeekRequest
      ? buildDeepSeekOpenAIChatMessages({
          systemPrompt: effectiveSystemPrompt,
          userText: effectiveUserText,
          projectedInput,
          attachments,
        })
      : [
          { role: "system" as const, content: effectiveSystemPrompt },
          {
            role: "user" as const,
            content: buildOpenAIChatUserContent(projectedInput, attachments),
          },
        ];
  const buildRequestBody = (cacheConfigOverride: OpenAiPromptCacheConfig | null) =>
    JSON.stringify(
      promptBeforeTools
        ? {
            model,
            temperature: options?.temperature ?? 0.2,
            ...(cacheConfigOverride
              ? buildOpenAiPromptCacheFields(cacheConfigOverride)
              : {}),
            stream: true,
            stream_options: {
              include_usage: true,
            },
            messages: buildChatMessages(),
            tool_choice: "auto",
            tools: buildDynamicFunctionTools(options?.mcpTools ?? []),
          }
        : {
            model,
            temperature: options?.temperature ?? 0.2,
            ...(cacheConfigOverride
              ? buildOpenAiPromptCacheFields(cacheConfigOverride)
              : {}),
            stream: true,
            stream_options: {
              include_usage: true,
            },
            tool_choice: "auto",
            tools: buildDynamicFunctionTools(options?.mcpTools ?? []),
            messages: buildChatMessages(),
          }
    );
  let activeCacheConfig = cacheConfig;
  const captureId = crypto.randomUUID();
  const buildCapturedRequestBody = async (
    cacheConfigOverride: OpenAiPromptCacheConfig | null
  ) => {
    const bodyText = buildRequestBody(cacheConfigOverride);
    activeSnapshotPath = await writeOpenAiRequestSnapshot({
      appRoot: options?.appRoot,
      env: options?.env,
      captureId,
      format: "openai_chat",
      provider: baseUrl,
      model,
      requestUrl,
      bodyText,
      promptBeforeTools,
    });
    return bodyText;
  };
  let activeSnapshotPath: string | null = null;
  let response = await fetch(requestUrl, {
    method: "POST",
    headers,
    body: await buildCapturedRequestBody(activeCacheConfig),
    signal: options?.signal,
  });

  for (let retryCount = 0; retryCount < 3 && activeCacheConfig && !response.ok; retryCount++) {
    const failureDetail = await readHttpFailureDetail(response.clone());
    const downgradedCacheConfig = nextOpenAiPromptCacheConfigAfterFailure(
      activeCacheConfig,
      failureDetail
    );
    if (downgradedCacheConfig === activeCacheConfig) {
      break;
    }
    rememberOpenAiPromptCacheFailure(options?.promptCacheCapabilities, {
      provider: baseUrl,
      model,
      format: "openai_chat",
    }, failureDetail);
    activeCacheConfig = downgradedCacheConfig;
    response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: await buildCapturedRequestBody(activeCacheConfig),
      signal: options?.signal,
    });
  }

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, requestUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolState = new Map<number, { name?: string; args: string; emitted: boolean }>();
  const usageState: OpenAiUsageState = {};
  let lastUsageSignature = "";
  let sawExplicitCompletion = false;

  while (true) {
    const { done, value } = await readStreamChunk(reader, options?.signal);
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const dataLines = parseSseEventData(rawEvent);
      for (const line of dataLines) {
        if (line === "[DONE]") {
          sawExplicitCompletion = true;
          yield buildProviderCompletionEvent(
            "explicit_done",
            "The provider sent [DONE] without a separate finish_reason chunk.",
            true
          );
          yield DONE_EVENT;
          return;
        }

        try {
          const parsed = JSON.parse(line) as {
            usage?: unknown;
            choices?: Array<{
              delta?: {
                content?: unknown;
                tool_calls?: Array<{
                  index?: number;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          const usageEvent = extractUsageEvent(parsed, usageState);
          if (usageEvent) {
            const signature = buildUsageSignature(usageEvent.usage);
            if (signature !== lastUsageSignature) {
              lastUsageSignature = signature;
              await appendOpenAiSnapshotUsage({
                env: options?.env,
                snapshotPath: activeSnapshotPath,
                usage: parsed.usage,
                normalized: usageEvent.usage,
              });
              yield usageEvent.event;
            }
          }
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          const deltaText = extractVisibleDeltaText(delta, {
            includeReasoning: options?.includeReasoning,
          });

          if (deltaText) {
            yield JSON.stringify({ type: "text_delta", text: deltaText });
          }

          if (delta?.tool_calls) {
            for (const call of delta.tool_calls) {
              const index = typeof call.index === "number" ? call.index : 0;
              const current = toolState.get(index) ?? {
                args: "",
                emitted: false,
              };
              if (call.function?.name) {
                current.name = call.function.name;
              }
              if (call.function?.arguments) {
                current.args += call.function.arguments;
              }
              toolState.set(index, current);

              if (current.name && !current.emitted) {
                try {
                  const parsedArgs = current.args ? JSON.parse(current.args) : {};
                  if (
                    parsedArgs &&
                    typeof parsedArgs === "object" &&
                    Object.keys(parsedArgs as Record<string, unknown>).length === 0
                  ) {
                    // Skip empty argument payloads. Wait for fuller chunks or finalization.
                    continue;
                  }
                  yield JSON.stringify({
                    type: "tool_call",
                    toolName: current.name,
                    input: parsedArgs,
                  });
                  current.emitted = true;
                  toolState.set(index, current);
                } catch {
                  // Wait for more argument chunks.
                }
              }
            }
          }

          if (choice?.finish_reason === "tool_calls") {
            for (const [, current] of toolState) {
              if (!current.name || current.emitted) {
                continue;
              }
              let parsedArgs: unknown = {};
              try {
                parsedArgs = current.args ? JSON.parse(current.args) : {};
              } catch {
                parsedArgs = { raw: current.args };
              }
              if (
                parsedArgs &&
                typeof parsedArgs === "object" &&
                Object.keys(parsedArgs as Record<string, unknown>).length === 0
              ) {
                continue;
              }
              yield JSON.stringify({
                type: "tool_call",
                toolName: current.name,
                input: parsedArgs,
              });
              current.emitted = true;
            }
          }

          if (choice?.finish_reason === "stop") {
            sawExplicitCompletion = true;
            yield buildOpenAiFinishReasonCompletionEvent(choice.finish_reason);
            yield DONE_EVENT;
            return;
          }

          if (
            typeof choice?.finish_reason === "string" &&
            choice.finish_reason &&
            choice.finish_reason !== "tool_calls"
          ) {
            sawExplicitCompletion = true;
            yield buildOpenAiFinishReasonCompletionEvent(choice.finish_reason);
            yield buildOpenAiFinishReasonInterruptionEvent(choice.finish_reason);
            yield DONE_EVENT;
            return;
          }
        } catch {
          // ignore malformed SSE data line
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const dataLines = parseSseEventData(buffer);
    for (const line of dataLines) {
      if (line === "[DONE]") {
        sawExplicitCompletion = true;
        yield buildProviderCompletionEvent(
          "explicit_done",
          "The provider sent [DONE] without a separate finish_reason chunk.",
          true
        );
        yield DONE_EVENT;
        return;
      }
    }
  }

  if (!sawExplicitCompletion) {
    yield buildUnexpectedSocketCloseCompletionEvent();
    yield buildUnexpectedSocketCloseEvent();
  }
  yield DONE_EVENT;
}

type GeminiSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
};

const sanitizeGeminiSchema = (value: unknown): GeminiSchema | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    type?: unknown;
    description?: unknown;
    enum?: unknown;
    format?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    required?: unknown;
    items?: unknown;
    properties?: unknown;
  };
  const schema: GeminiSchema = {};

  if (typeof record.type === "string" && record.type.trim()) {
    schema.type = record.type;
  }
  if (typeof record.description === "string" && record.description.trim()) {
    schema.description = record.description;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    schema.enum = [...record.enum];
  }
  if (typeof record.format === "string" && record.format.trim()) {
    schema.format = record.format;
  }
  if (typeof record.minimum === "number" && Number.isFinite(record.minimum)) {
    schema.minimum = record.minimum;
  }
  if (typeof record.maximum === "number" && Number.isFinite(record.maximum)) {
    schema.maximum = record.maximum;
  }
  if (Array.isArray(record.required)) {
    const required = record.required.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    if (required.length > 0) {
      schema.required = required;
    }
  }

  const items = sanitizeGeminiSchema(record.items);
  if (items) {
    schema.items = items;
  }

  if (record.properties && typeof record.properties === "object") {
    const properties = Object.entries(record.properties).reduce<Record<string, GeminiSchema>>(
      (accumulator, [key, child]) => {
        const sanitized = sanitizeGeminiSchema(child);
        if (sanitized) {
          accumulator[key] = sanitized;
        }
        return accumulator;
      },
      {}
    );
    if (Object.keys(properties).length > 0) {
      schema.properties = properties;
    }
  }

  if (Object.keys(schema).length === 0) {
    return undefined;
  }
  return schema;
};

type ResponsesUsageState = {
  cachedTokens?: number;
  lastEmitted?: string;
};

const emitResponseToolCallIfReady = (
  current: { name?: string; args: string; emitted: boolean }
) => {
  if (!current.name || current.emitted) {
    return null;
  }
  let parsedArgs: unknown = {};
  try {
    parsedArgs = current.args ? JSON.parse(current.args) : {};
  } catch {
    return null;
  }
  if (
    parsedArgs &&
    typeof parsedArgs === "object" &&
    Object.keys(parsedArgs as Record<string, unknown>).length === 0
  ) {
    return null;
  }
  current.emitted = true;
  return JSON.stringify({
    type: "tool_call",
    toolName: current.name,
    input: parsedArgs,
  });
};

const extractResponsesUsageEvent = (
  payload: unknown,
  state: ResponsesUsageState
) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    usage?: unknown;
    response?: { usage?: unknown };
  };
  const usageCandidate = record.usage ?? record.response?.usage;
  if (!usageCandidate || typeof usageCandidate !== "object") {
    return null;
  }

  const usageRecord = usageCandidate as Record<string, unknown>;
  const promptTokens =
    typeof usageRecord.input_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.input_tokens))
      : 0;
  const completionTokens =
    typeof usageRecord.output_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.output_tokens))
      : 0;
  const totalTokens =
    typeof usageRecord.total_tokens === "number"
      ? Math.max(0, Math.floor(usageRecord.total_tokens))
      : promptTokens + completionTokens;
  const cachedTokens = resolveOpenAiCachedTokens(usageRecord, state);
  const signature = `${promptTokens}:${cachedTokens ?? 0}:${completionTokens}:${totalTokens}`;
  if (state.lastEmitted === signature) {
    return null;
  }
  state.lastEmitted = signature;
  const normalized: TokenUsage = {
    promptTokens,
    ...(typeof cachedTokens === "number" ? { cachedTokens } : {}),
    completionTokens,
    totalTokens,
  };
  return {
    event: JSON.stringify({
      type: "usage",
      ...normalized,
    }),
    usage: usageCandidate,
    normalized,
  };
};

async function* streamSseOpenAIResponses(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: QueryInput,
  options?: {
    temperature?: number;
    family?: ProviderFamily;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
    appRoot?: string;
    env?: NodeJS.ProcessEnv;
    promptCacheCapabilities?: OpenAiPromptCacheCapabilityStore;
    signal?: AbortSignal;
  }
): AsyncGenerator<string> {
  throwIfAborted(options?.signal);
  const attachments = await encodeImageAttachments(
    input.attachments ?? [],
    options?.appRoot ?? process.cwd()
  );
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (options?.family === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  }

  const cacheCapability = getOpenAiPromptCacheCapability(
    options?.promptCacheCapabilities,
    {
      provider: baseUrl,
      model,
      format: "openai_responses",
    }
  );
  const cacheConfig = resolveOpenAiPromptCacheConfig({
    env: options?.env,
    provider: baseUrl,
    model,
    family: options?.family,
    format: "openai_responses",
    appRoot: options?.appRoot,
    mcpTools: options?.mcpTools,
    systemPrompt: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT,
    capability: cacheCapability,
  });
  const promptProjection = splitOpenAiPromptForCaching(
    input.text,
    options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT
  );
  const baseSystemPrompt = (options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT).trim();
  let effectiveSystemPrompt = promptProjection.systemPrompt;
  let effectiveUserText = promptProjection.userText;
  if (
    resolveDeepSeekCompatibilityMode({
      provider: baseUrl,
      model,
      env: options?.env,
    })
  ) {
    if (
      effectiveSystemPrompt.startsWith(baseSystemPrompt) &&
      effectiveSystemPrompt.length > baseSystemPrompt.length
    ) {
      const stableSystemExtra = effectiveSystemPrompt
        .slice(baseSystemPrompt.length)
        .trim();
      effectiveSystemPrompt = baseSystemPrompt;
      effectiveUserText = stableSystemExtra
        ? stableSystemExtra + "\n\n" + effectiveUserText
        : effectiveUserText;
    }
  }
  const projectedInput: QueryInput = {
    ...input,
    text: effectiveUserText,
  };
  const buildRequestBody = (
    temperature: number | undefined,
    cacheConfigOverride: OpenAiPromptCacheConfig | null
  ) =>
    JSON.stringify(buildOpenAIResponsesRequestBody({
      model,
      provider: baseUrl,
      input: projectedInput,
      attachments,
      temperature,
      systemPrompt: effectiveSystemPrompt,
      mcpTools: options?.mcpTools ?? [],
      cacheConfig: cacheConfigOverride,
      env: options?.env,
    }));
  const candidateUrls = resolveResponsesUrls(
    baseUrl,
    options?.endpointOverride
  );
  let attemptedUrl = candidateUrls[0] ?? baseUrl;
  let activeTemperature: number | undefined = options?.temperature ?? 0.2;
  let activeCacheConfig = cacheConfig;
  const captureId = crypto.randomUUID();
  const promptBeforeTools = shouldPreferPromptBeforeTools({
    provider: baseUrl,
    model,
    env: options?.env,
  }) && !shouldPreferToolsBeforePrompt({ cacheConfig });
  const buildCapturedRequestBody = async (
    requestUrl: string,
    temperature: number | undefined,
    cacheConfigOverride: OpenAiPromptCacheConfig | null
  ) => {
    const bodyText = buildRequestBody(temperature, cacheConfigOverride);
    activeSnapshotPath = await writeOpenAiRequestSnapshot({
      appRoot: options?.appRoot,
      env: options?.env,
      captureId,
      format: "openai_responses",
      provider: baseUrl,
      model,
      requestUrl,
      bodyText,
      promptBeforeTools,
    });
    return bodyText;
  };
  let activeSnapshotPath: string | null = null;
  let response = await fetch(attemptedUrl, {
    method: "POST",
    headers,
    body: await buildCapturedRequestBody(
      attemptedUrl,
      activeTemperature,
      activeCacheConfig
    ),
    signal: options?.signal,
  });

  if (
    candidateUrls.length > 1 &&
    !response.ok &&
    (response.status === 404 ||
      response.status === 405 ||
      response.status === 410 ||
      response.status === 501)
  ) {
    attemptedUrl = candidateUrls[1]!;
    response = await fetch(attemptedUrl, {
      method: "POST",
      headers,
      body: await buildCapturedRequestBody(
        attemptedUrl,
        activeTemperature,
        activeCacheConfig
      ),
      signal: options?.signal,
    });
  }

  for (let retryCount = 0; retryCount < 3 && !response.ok; retryCount++) {
    const failureDetail = await readHttpFailureDetail(response.clone());
    let changed = false;
    if (typeof activeTemperature === "number" && isUnsupportedTemperatureFailureDetail(failureDetail)) {
      activeTemperature = undefined;
      changed = true;
    }
    if (activeCacheConfig) {
      const downgradedCacheConfig = nextOpenAiPromptCacheConfigAfterFailure(
        activeCacheConfig,
        failureDetail
      );
      if (downgradedCacheConfig !== activeCacheConfig) {
        rememberOpenAiPromptCacheFailure(options?.promptCacheCapabilities, {
          provider: baseUrl,
          model,
          format: "openai_responses",
        }, failureDetail);
        activeCacheConfig = downgradedCacheConfig;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
    response = await fetch(attemptedUrl, {
      method: "POST",
      headers,
      body: await buildCapturedRequestBody(
        attemptedUrl,
        activeTemperature,
        activeCacheConfig
      ),
      signal: options?.signal,
    });
  }

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, attemptedUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageState: ResponsesUsageState = {};
  const toolState = new Map<
    string,
    {
      name?: string;
      args: string;
      emitted: boolean;
    }
  >();
  let sawExplicitCompletion = false;

  while (true) {
    const { done, value } = await readStreamChunk(reader, options?.signal);
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const dataLines = parseSseEventData(rawEvent);
      for (const line of dataLines) {
        if (line === "[DONE]") {
          sawExplicitCompletion = true;
          yield buildProviderCompletionEvent(
            "explicit_done",
            "The provider sent [DONE] without a response.completed event.",
            true
          );
          yield DONE_EVENT;
          return;
        }

        try {
          const parsed = JSON.parse(line) as {
            type?: unknown;
            delta?: unknown;
            item_id?: unknown;
            output_index?: unknown;
            item?: {
              type?: unknown;
              name?: unknown;
              arguments?: unknown;
              call_id?: unknown;
            };
            response?: {
              output?: Array<unknown>;
              usage?: unknown;
              status?: unknown;
              incomplete_details?: unknown;
              error?: unknown;
            };
          };
          const usageEvent = extractResponsesUsageEvent(parsed, usageState);
          if (usageEvent) {
            await appendOpenAiSnapshotUsage({
              env: options?.env,
              snapshotPath: activeSnapshotPath,
              usage: usageEvent.usage,
              normalized: usageEvent.normalized,
            });
            yield usageEvent.event;
          }

          const eventType =
            typeof parsed.type === "string" ? parsed.type : "";
          if (
            (eventType === "response.output_text.delta" ||
              eventType === "response.refusal.delta") &&
            typeof parsed.delta === "string" &&
            parsed.delta
          ) {
            yield JSON.stringify({
              type: "text_delta",
              text: parsed.delta,
            });
          }

          if (
            eventType === "response.output_item.added" ||
            eventType === "response.output_item.done"
          ) {
            const item = parsed.item;
            const itemType = typeof item?.type === "string" ? item.type : "";
            if (itemType === "function_call") {
              const key =
                (typeof parsed.item_id === "string" && parsed.item_id) ||
                (typeof item?.call_id === "string" && item.call_id) ||
                String(parsed.output_index ?? 0);
              const current = toolState.get(key) ?? {
                args: "",
                emitted: false,
              };
              if (typeof item?.name === "string") {
                current.name = item.name;
              }
              if (typeof item?.arguments === "string") {
                current.args = item.arguments;
              }
              toolState.set(key, current);
              const toolEvent = emitResponseToolCallIfReady(current);
              if (toolEvent) {
                yield toolEvent;
              }
            }
          }

          if (eventType === "response.function_call_arguments.delta") {
            const key =
              (typeof parsed.item_id === "string" && parsed.item_id) ||
              String(parsed.output_index ?? 0);
            const current = toolState.get(key) ?? {
              args: "",
              emitted: false,
            };
            if (typeof parsed.delta === "string") {
              current.args += parsed.delta;
            }
            toolState.set(key, current);
            const toolEvent = emitResponseToolCallIfReady(current);
            if (toolEvent) {
              yield toolEvent;
            }
          }

          if (eventType === "response.completed") {
            sawExplicitCompletion = true;
            if (parsed.response?.output) {
              for (const item of parsed.response.output) {
                if (!item || typeof item !== "object") {
                  continue;
                }
                const record = item as {
                  type?: unknown;
                  name?: unknown;
                  arguments?: unknown;
                  call_id?: unknown;
                };
                if (record.type !== "function_call") {
                  continue;
                }
                const key =
                  (typeof record.call_id === "string" && record.call_id) ||
                  String(toolState.size);
                const current = toolState.get(key) ?? {
                  args: "",
                  emitted: false,
                };
                if (typeof record.name === "string") {
                  current.name = record.name;
                }
                if (typeof record.arguments === "string") {
                  current.args = record.arguments;
                }
                toolState.set(key, current);
                const toolEvent = emitResponseToolCallIfReady(current);
                if (toolEvent) {
                  yield toolEvent;
                }
              }
            }
            const status =
              typeof parsed.response?.status === "string"
                ? parsed.response.status
                : "completed";
            yield buildResponsesStatusCompletionEvent(status, parsed.response);
            if (status !== "completed") {
              yield buildResponsesStatusInterruptionEvent(status, parsed.response);
            }
            yield DONE_EVENT;
            return;
          }
        } catch {
          // ignore malformed SSE data line
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const dataLines = parseSseEventData(buffer);
    for (const line of dataLines) {
      if (line === "[DONE]") {
        sawExplicitCompletion = true;
        yield buildProviderCompletionEvent(
          "explicit_done",
          "The provider sent [DONE] without a response.completed event.",
          true
        );
        yield DONE_EVENT;
        return;
      }

      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          delta?: unknown;
          item_id?: unknown;
          output_index?: unknown;
          item?: {
            type?: unknown;
            name?: unknown;
            arguments?: unknown;
            call_id?: unknown;
          };
          response?: {
            output?: Array<unknown>;
            usage?: unknown;
            status?: unknown;
            incomplete_details?: unknown;
            error?: unknown;
          };
        };
        const usageEvent = extractResponsesUsageEvent(parsed, usageState);
        if (usageEvent) {
          await appendOpenAiSnapshotUsage({
            env: options?.env,
            snapshotPath: activeSnapshotPath,
            usage: usageEvent.usage,
            normalized: usageEvent.normalized,
          });
          yield usageEvent.event;
        }

        const eventType =
          typeof parsed.type === "string" ? parsed.type : "";
        if (
          (eventType === "response.output_text.delta" ||
            eventType === "response.refusal.delta") &&
          typeof parsed.delta === "string" &&
          parsed.delta
        ) {
          yield JSON.stringify({
            type: "text_delta",
            text: parsed.delta,
          });
        }

        if (
          eventType === "response.output_item.added" ||
          eventType === "response.output_item.done"
        ) {
          const item = parsed.item;
          const itemType = typeof item?.type === "string" ? item.type : "";
          if (itemType === "function_call") {
            const key =
              (typeof parsed.item_id === "string" && parsed.item_id) ||
              (typeof item?.call_id === "string" && item.call_id) ||
              String(parsed.output_index ?? 0);
            const current = toolState.get(key) ?? {
              args: "",
              emitted: false,
            };
            if (typeof item?.name === "string") {
              current.name = item.name;
            }
            if (typeof item?.arguments === "string") {
              current.args = item.arguments;
            }
            toolState.set(key, current);
            const toolEvent = emitResponseToolCallIfReady(current);
            if (toolEvent) {
              yield toolEvent;
            }
          }
        }

        if (eventType === "response.function_call_arguments.delta") {
          const key =
            (typeof parsed.item_id === "string" && parsed.item_id) ||
            String(parsed.output_index ?? 0);
          const current = toolState.get(key) ?? {
            args: "",
            emitted: false,
          };
          if (typeof parsed.delta === "string") {
            current.args += parsed.delta;
          }
          toolState.set(key, current);
          const toolEvent = emitResponseToolCallIfReady(current);
          if (toolEvent) {
            yield toolEvent;
          }
        }

        if (eventType === "response.completed") {
          sawExplicitCompletion = true;
          if (parsed.response?.output) {
            for (const item of parsed.response.output) {
              if (!item || typeof item !== "object") {
                continue;
              }
              const record = item as {
                type?: unknown;
                name?: unknown;
                arguments?: unknown;
                call_id?: unknown;
              };
              if (record.type !== "function_call") {
                continue;
              }
              const key =
                (typeof record.call_id === "string" && record.call_id) ||
                String(toolState.size);
              const current = toolState.get(key) ?? {
                args: "",
                emitted: false,
              };
              if (typeof record.name === "string") {
                current.name = record.name;
              }
              if (typeof record.arguments === "string") {
                current.args = record.arguments;
              }
              toolState.set(key, current);
              const toolEvent = emitResponseToolCallIfReady(current);
              if (toolEvent) {
                yield toolEvent;
              }
            }
          }
          const status =
            typeof parsed.response?.status === "string"
              ? parsed.response.status
              : "completed";
          yield buildResponsesStatusCompletionEvent(status, parsed.response);
          if (status !== "completed") {
            yield buildResponsesStatusInterruptionEvent(status, parsed.response);
          }
          yield DONE_EVENT;
          return;
        }
      } catch {
        // ignore malformed SSE data line
      }
    }
  }

  if (!sawExplicitCompletion) {
    yield buildUnexpectedSocketCloseCompletionEvent();
    yield buildUnexpectedSocketCloseEvent();
  }
  yield DONE_EVENT;
}

type GeminiUsageState = {
  lastEmitted?: string;
};

const extractGeminiUsageEvent = (
  payload: unknown,
  state: GeminiUsageState
) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const usageRecord = (payload as { usageMetadata?: unknown }).usageMetadata;
  if (!usageRecord || typeof usageRecord !== "object") {
    return null;
  }

  const typedUsage = usageRecord as {
    promptTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
  const promptTokens =
    typeof typedUsage.promptTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.promptTokenCount))
      : 0;
  const cachedTokens =
    typeof typedUsage.cachedContentTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.cachedContentTokenCount))
      : undefined;
  const completionTokens =
    typeof typedUsage.candidatesTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.candidatesTokenCount))
      : 0;
  const totalTokens =
    typeof typedUsage.totalTokenCount === "number"
      ? Math.max(0, Math.floor(typedUsage.totalTokenCount))
      : promptTokens + completionTokens;
  const signature = `${promptTokens}:${cachedTokens ?? 0}:${completionTokens}:${totalTokens}`;
  if (state.lastEmitted === signature) {
    return null;
  }
  state.lastEmitted = signature;
  return JSON.stringify({
    type: "usage",
    promptTokens,
    ...(typeof cachedTokens === "number" ? { cachedTokens } : {}),
    completionTokens,
    totalTokens,
  });
};

const collectGeminiCandidateParts = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return [] as Array<Record<string, unknown>>;
  }

  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return [] as Array<Record<string, unknown>>;
  }

  return candidates.flatMap(candidate => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const content = (candidate as { content?: unknown }).content;
    if (!content || typeof content !== "object") {
      return [];
    }
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) {
      return [];
    }
    return parts.filter(
      (part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === "object"
    );
  });
};

const extractGeminiTextEvents = (payload: unknown) =>
  collectGeminiCandidateParts(payload)
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .map(text => JSON.stringify({ type: "text_delta", text }));

const extractGeminiToolEvents = (
  payload: unknown,
  emitted: Set<string>
) => {
  const events: string[] = [];
  for (const part of collectGeminiCandidateParts(payload)) {
    const functionCall = part.functionCall;
    if (!functionCall || typeof functionCall !== "object") {
      continue;
    }

    const typedFunctionCall = functionCall as {
      id?: unknown;
      name?: unknown;
      args?: unknown;
    };
    const toolName =
      typeof typedFunctionCall.name === "string" ? typedFunctionCall.name : "";
    if (!toolName) {
      continue;
    }

    let input: unknown = {};
    if (typeof typedFunctionCall.args === "string") {
      try {
        input = JSON.parse(typedFunctionCall.args);
      } catch {
        input = { raw: typedFunctionCall.args };
      }
    } else if (
      typedFunctionCall.args &&
      typeof typedFunctionCall.args === "object"
    ) {
      input = typedFunctionCall.args;
    }

    if (
      input &&
      typeof input === "object" &&
      Object.keys(input as Record<string, unknown>).length === 0
    ) {
      continue;
    }

    const signature = [
      typeof typedFunctionCall.id === "string" ? typedFunctionCall.id : "",
      toolName,
      JSON.stringify(input),
    ].join(":");
    if (emitted.has(signature)) {
      continue;
    }
    emitted.add(signature);
    events.push(
      JSON.stringify({
        type: "tool_call",
        toolName,
        input,
      })
    );
  }
  return events;
};

async function* streamSseGeminiGenerateContent(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: QueryInput,
  options?: {
    temperature?: number;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
    appRoot?: string;
    signal?: AbortSignal;
  }
): AsyncGenerator<string> {
  throwIfAborted(options?.signal);
  const attachments = await encodeImageAttachments(
    input.attachments ?? [],
    options?.appRoot ?? process.cwd()
  );
  const requestUrl = resolveGeminiGenerateContentUrl(
    baseUrl,
    model,
    options?.endpointOverride
  );
  const response = await fetch(
    requestUrl,
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: options?.systemPrompt ?? TOOL_USAGE_SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: buildGeminiUserParts(input, attachments),
          },
        ],
        tools: [buildGeminiFunctionTools(options?.mcpTools ?? [])],
        toolConfig: {
          functionCallingConfig: {
            mode: "AUTO",
          },
        },
        generationConfig: {
          temperature: options?.temperature ?? 0.2,
        },
      }),
      signal: options?.signal,
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, requestUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageState: GeminiUsageState = {};
  const emittedToolCalls = new Set<string>();
  let sawExplicitCompletion = false;

  while (true) {
    const { done, value } = await readStreamChunk(reader, options?.signal);
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const dataLines = parseSseEventData(rawEvent);
      for (const line of dataLines) {
        if (line === "[DONE]") {
          sawExplicitCompletion = true;
          yield buildProviderCompletionEvent(
            "explicit_done",
            "The provider sent [DONE] without a separate finishReason payload.",
            true
          );
          yield DONE_EVENT;
          return;
        }

        try {
          const parsed = JSON.parse(line) as unknown;
          const usageEvent = extractGeminiUsageEvent(parsed, usageState);
          if (usageEvent) {
            yield usageEvent;
          }
          for (const event of extractGeminiTextEvents(parsed)) {
            yield event;
          }
          for (const event of extractGeminiToolEvents(parsed, emittedToolCalls)) {
            yield event;
          }
          const completionEvent = extractGeminiCompletionEvent(parsed);
          const interruptionEvent = extractGeminiInterruptionEvent(parsed);
          if (completionEvent) {
            sawExplicitCompletion = true;
            yield completionEvent;
            if (interruptionEvent) {
              yield interruptionEvent;
            }
            yield DONE_EVENT;
            return;
          }
          if (interruptionEvent) {
            sawExplicitCompletion = true;
            yield interruptionEvent;
            yield DONE_EVENT;
            return;
          }
        } catch {
          // ignore malformed SSE data line
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const dataLines = parseSseEventData(buffer);
    for (const line of dataLines) {
      if (line === "[DONE]") {
        sawExplicitCompletion = true;
        yield buildProviderCompletionEvent(
          "explicit_done",
          "The provider sent [DONE] without a separate finishReason payload.",
          true
        );
        yield DONE_EVENT;
        return;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        const usageEvent = extractGeminiUsageEvent(parsed, usageState);
        if (usageEvent) {
          yield usageEvent;
        }
        for (const event of extractGeminiTextEvents(parsed)) {
          yield event;
        }
        for (const event of extractGeminiToolEvents(parsed, emittedToolCalls)) {
          yield event;
        }
        const completionEvent = extractGeminiCompletionEvent(parsed);
        const interruptionEvent = extractGeminiInterruptionEvent(parsed);
        if (completionEvent) {
          sawExplicitCompletion = true;
          yield completionEvent;
          if (interruptionEvent) {
            yield interruptionEvent;
          }
          yield DONE_EVENT;
          return;
        }
        if (interruptionEvent) {
          sawExplicitCompletion = true;
          yield interruptionEvent;
          yield DONE_EVENT;
          return;
        }
      } catch {
        // ignore malformed SSE data line
      }
    }
  }

  if (!sawExplicitCompletion) {
    yield buildUnexpectedSocketCloseCompletionEvent();
    yield buildUnexpectedSocketCloseEvent();
  }
  yield DONE_EVENT;
}

type AnthropicUsageState = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  lastEmitted?: string;
};

const parseAnthropicToolArgs = (rawArgs: string): unknown => {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Anthropic may emit an empty input object at block start before streaming
    // the real JSON arguments via input_json_delta chunks.
    if (trimmed.startsWith("{}")) {
      try {
        return JSON.parse(trimmed.slice(2).trimStart());
      } catch {
        // fall through to raw payload below
      }
    }
    return { raw: rawArgs };
  }
};

const extractAnthropicUsageEvent = (
  payload: unknown,
  state: AnthropicUsageState
) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    usage?: unknown;
    message?: { usage?: unknown };
  };
  const usageCandidate = record.usage ?? record.message?.usage;
  if (!usageCandidate || typeof usageCandidate !== "object") {
    return null;
  }

  const usageRecord = usageCandidate as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  if (typeof usageRecord.input_tokens === "number") {
    state.inputTokens = Math.max(0, Math.floor(usageRecord.input_tokens));
  }
  if (typeof usageRecord.output_tokens === "number") {
    state.outputTokens = Math.max(0, Math.floor(usageRecord.output_tokens));
  }
  if (typeof usageRecord.cache_read_input_tokens === "number") {
    state.cacheReadInputTokens = Math.max(
      0,
      Math.floor(usageRecord.cache_read_input_tokens)
    );
  }
  if (typeof usageRecord.cache_creation_input_tokens === "number") {
    state.cacheCreationInputTokens = Math.max(
      0,
      Math.floor(usageRecord.cache_creation_input_tokens)
    );
  }

  if (
    typeof state.inputTokens !== "number" &&
    typeof state.outputTokens !== "number" &&
    typeof state.cacheReadInputTokens !== "number" &&
    typeof state.cacheCreationInputTokens !== "number"
  ) {
    return null;
  }

  const promptTokens =
    (state.inputTokens ?? 0) +
    (state.cacheReadInputTokens ?? 0) +
    (state.cacheCreationInputTokens ?? 0);
  const completionTokens = state.outputTokens ?? 0;
  const cachedTokens = state.cacheReadInputTokens ?? 0;
  const signature = `${promptTokens}:${cachedTokens}:${completionTokens}:${promptTokens + completionTokens}`;
  if (state.lastEmitted === signature) {
    return null;
  }
  state.lastEmitted = signature;
  return JSON.stringify({
    type: "usage",
    promptTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(typeof state.cacheReadInputTokens === "number"
      ? { cacheReadInputTokens: state.cacheReadInputTokens }
      : {}),
    ...(typeof state.cacheCreationInputTokens === "number"
      ? { cacheCreationInputTokens: state.cacheCreationInputTokens }
      : {}),
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
};

async function* streamSseAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: QueryInput,
  options?: {
    temperature?: number;
    endpointOverride?: string | null;
    systemPrompt?: string;
    mcpTools?: McpToolDescriptor[];
    appRoot?: string;
    env?: NodeJS.ProcessEnv;
    captureId?: string;
    debugAnthropicRequests?: AnthropicRequestCaptureOptions;
    cacheSessionState?: AnthropicPromptCacheSessionState;
    signal?: AbortSignal;
  }
): AsyncGenerator<string> {
  throwIfAborted(options?.signal);
  const attachments = await encodeImageAttachments(
    input.attachments ?? [],
    options?.appRoot ?? process.cwd()
  );
  const cacheSessionState =
    options?.cacheSessionState ?? createAnthropicPromptCacheSessionState();
  const anthropicPrompt = splitAnthropicPromptForCaching(
    input.text,
    options?.systemPrompt ?? ANTHROPIC_TOOL_USAGE_SYSTEM_PROMPT
  );
  const resolvedCacheControl = getAnthropicCacheControl(
    cacheSessionState,
    options?.env
  );
  const resolvedBetaHeaders = getAnthropicBetaHeaders(
    cacheSessionState,
    options?.env
  );
  const requestUrl = resolveAnthropicMessagesUrl(
    baseUrl,
    options?.endpointOverride
  );
  const requestHeaders = buildAnthropicRequestHeaders(
    apiKey,
    resolvedBetaHeaders
  );
  const requestBody = buildAnthropicMessagesRequestBody({
    model,
    temperature: options?.temperature ?? 0.2,
    promptProjection: anthropicPrompt,
    userText: anthropicPrompt.userText,
    attachments,
    mcpTools: options?.mcpTools ?? [],
    cacheControl: resolvedCacheControl,
  });
  let snapshotPath: string | null = null;
  if (
    options?.captureId &&
    (options?.debugAnthropicRequests?.capture === true ||
      shouldCaptureAnthropicRequests(options.env))
  ) {
    try {
      snapshotPath = await writeAnthropicRequestSnapshot({
        appRoot: options.appRoot,
        env: options.env,
        capture: options.debugAnthropicRequests,
        captureId: options.captureId,
        provider: baseUrl,
        model,
        requestUrl,
        requestHeaders,
        requestBody,
        resolvedCacheControl,
        resolvedBetaHeaders,
        systemProjection: anthropicPrompt,
      });
    } catch {
      // Snapshotting should not break live requests.
    }
  }
  const response = await fetch(
    requestUrl,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: options?.signal,
    }
  );

  if (snapshotPath) {
    try {
      await updateAnthropicRequestSnapshot(snapshotPath, {
        response: {
          status: response.status,
          headers: headersToObject(response.headers),
        },
      });
    } catch {
      // ignore debug write errors
    }
  }

  if (!response.ok || !response.body) {
    throw new Error(await formatHttpFailure("Stream error", response, requestUrl));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usageState: AnthropicUsageState = {};
  const toolState = new Map<number, { name?: string; args: string; emitted: boolean }>();
  const usageEvents: Array<{ eventType: string; usage: unknown }> = [];
  let sawExplicitCompletion = false;
  let stopReason = "";

  while (true) {
    const { done, value } = await readStreamChunk(reader, options?.signal);
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const dataLines = parseSseEventData(rawEvent);
      for (const line of dataLines) {
        if (line === "[DONE]") {
          sawExplicitCompletion = true;
          yield buildProviderCompletionEvent(
            "explicit_done",
            "The provider sent [DONE] without a message_stop event.",
            true
          );
          yield DONE_EVENT;
          return;
        }

        try {
          const parsed = JSON.parse(line) as {
            type?: unknown;
            index?: unknown;
            content_block?: {
              type?: unknown;
              text?: unknown;
              name?: unknown;
              input?: unknown;
            };
            delta?: {
              type?: unknown;
              text?: unknown;
              partial_json?: unknown;
              stop_reason?: unknown;
            };
          };
          const usageEvent = extractAnthropicUsageEvent(parsed, usageState);
          const usageCandidate =
            parsed && typeof parsed === "object" && "usage" in parsed
              ? (parsed as { usage?: unknown }).usage
              : parsed &&
                  typeof parsed === "object" &&
                  "message" in parsed &&
                  (parsed as { message?: { usage?: unknown } }).message?.usage
                ? (parsed as { message?: { usage?: unknown } }).message?.usage
                : null;
          if (
            snapshotPath &&
            usageCandidate &&
            usageEvents.length < 16
          ) {
            usageEvents.push({
              eventType:
                typeof parsed.type === "string" ? parsed.type : "unknown",
              usage: usageCandidate,
            });
          }
          if (usageEvent) {
            yield usageEvent;
          }

          const anthropicErrorEvent = extractAnthropicStreamErrorEvent(parsed);
          if (anthropicErrorEvent) {
            sawExplicitCompletion = true;
            if (snapshotPath && usageEvents.length > 0) {
              try {
                await updateAnthropicSnapshotLatestUsage(
                  snapshotPath,
                  usageEvents
                );
              } catch {
                // ignore debug write errors
              }
            }
            yield buildProviderCompletionEvent(
              "stream_error",
              "Anthropic reported a stream error before completion.",
              false
            );
            yield anthropicErrorEvent;
            yield DONE_EVENT;
            return;
          }

          const eventType =
            typeof parsed.type === "string" ? parsed.type : "";
          const index = typeof parsed.index === "number" ? parsed.index : 0;

          if (
            eventType === "message_delta" &&
            typeof parsed.delta?.stop_reason === "string"
          ) {
            stopReason = parsed.delta.stop_reason;
          }

          if (eventType === "message_stop") {
            sawExplicitCompletion = true;
            if (snapshotPath && usageEvents.length > 0) {
              try {
                await updateAnthropicSnapshotLatestUsage(
                  snapshotPath,
                  usageEvents
                );
              } catch {
                // ignore debug write errors
              }
            }
            yield stopReason
              ? buildAnthropicStopReasonCompletionEvent(stopReason)
              : buildProviderCompletionEvent(
                  "message_stop",
                  "The provider ended the response with message_stop.",
                  true
                );
            if (stopReason && !isAnthropicExpectedStopReason(stopReason)) {
              yield buildAnthropicStopReasonInterruptionEvent(stopReason);
            }
            yield DONE_EVENT;
            return;
          }

          if (eventType === "content_block_start") {
            const contentBlock = parsed.content_block;
            const blockType =
              contentBlock && typeof contentBlock.type === "string"
                ? contentBlock.type
                : "";
            if (blockType === "text" && typeof contentBlock?.text === "string") {
              if (contentBlock.text) {
                yield JSON.stringify({
                  type: "text_delta",
                  text: contentBlock.text,
                });
              }
            }
            if (blockType === "tool_use") {
              const current = toolState.get(index) ?? {
                args: "",
                emitted: false,
              };
              if (typeof contentBlock?.name === "string") {
                current.name = contentBlock.name;
              }
              if (typeof contentBlock?.input === "string") {
                current.args += contentBlock.input;
              } else if (
                contentBlock?.input &&
                typeof contentBlock.input === "object"
              ) {
                const serializedInput = JSON.stringify(contentBlock.input);
                if (serializedInput !== "{}") {
                  current.args = serializedInput;
                }
              }
              toolState.set(index, current);
            }
          }

          if (eventType === "content_block_delta") {
            const deltaType =
              parsed.delta && typeof parsed.delta.type === "string"
                ? parsed.delta.type
                : "";
            if (
              deltaType === "text_delta" &&
              typeof parsed.delta?.text === "string" &&
              parsed.delta.text
            ) {
              yield JSON.stringify({
                type: "text_delta",
                text: parsed.delta.text,
              });
            }
            if (
              deltaType === "input_json_delta" &&
              typeof parsed.delta?.partial_json === "string"
            ) {
              const current = toolState.get(index) ?? {
                args: "",
                emitted: false,
              };
              current.args += parsed.delta.partial_json;
              toolState.set(index, current);
            }
          }

          if (eventType === "content_block_stop") {
            const current = toolState.get(index);
            if (current?.name && !current.emitted) {
              const parsedArgs = parseAnthropicToolArgs(current.args);
              if (
                parsedArgs &&
                typeof parsedArgs === "object" &&
                Object.keys(parsedArgs as Record<string, unknown>).length > 0
              ) {
                yield JSON.stringify({
                  type: "tool_call",
                  toolName: current.name,
                  input: parsedArgs,
                });
                current.emitted = true;
                toolState.set(index, current);
              }
            }
          }
        } catch {
          // ignore malformed SSE data line
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const dataLines = parseSseEventData(buffer);
    for (const line of dataLines) {
      if (line === "[DONE]") {
        sawExplicitCompletion = true;
        yield buildProviderCompletionEvent(
          "explicit_done",
          "The provider sent [DONE] without a message_stop event.",
          true
        );
        yield DONE_EVENT;
        return;
      }

      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          index?: unknown;
          content_block?: {
            type?: unknown;
            text?: unknown;
            name?: unknown;
            input?: unknown;
          };
          delta?: {
            type?: unknown;
            text?: unknown;
            partial_json?: unknown;
            stop_reason?: unknown;
          };
        };
        const usageEvent = extractAnthropicUsageEvent(parsed, usageState);
        const usageCandidate =
          parsed && typeof parsed === "object" && "usage" in parsed
            ? (parsed as { usage?: unknown }).usage
            : parsed &&
                typeof parsed === "object" &&
                "message" in parsed &&
                (parsed as { message?: { usage?: unknown } }).message?.usage
              ? (parsed as { message?: { usage?: unknown } }).message?.usage
              : null;
        if (snapshotPath && usageCandidate && usageEvents.length < 16) {
          usageEvents.push({
            eventType:
              typeof parsed.type === "string" ? parsed.type : "unknown",
            usage: usageCandidate,
          });
        }
        if (usageEvent) {
          yield usageEvent;
        }

        const anthropicErrorEvent = extractAnthropicStreamErrorEvent(parsed);
        if (anthropicErrorEvent) {
          sawExplicitCompletion = true;
          if (snapshotPath && usageEvents.length > 0) {
            try {
              await updateAnthropicSnapshotLatestUsage(
                snapshotPath,
                usageEvents
              );
            } catch {
              // ignore debug write errors
            }
          }
          yield buildProviderCompletionEvent(
            "stream_error",
            "Anthropic reported a stream error before completion.",
            false
          );
          yield anthropicErrorEvent;
          yield DONE_EVENT;
          return;
        }

        const eventType = typeof parsed.type === "string" ? parsed.type : "";
        const index = typeof parsed.index === "number" ? parsed.index : 0;

        if (
          eventType === "message_delta" &&
          typeof parsed.delta?.stop_reason === "string"
        ) {
          stopReason = parsed.delta.stop_reason;
        }

        if (eventType === "content_block_start") {
          const contentBlock = parsed.content_block;
          const blockType =
            contentBlock && typeof contentBlock.type === "string"
              ? contentBlock.type
              : "";
          if (blockType === "text" && typeof contentBlock?.text === "string") {
            if (contentBlock.text) {
              yield JSON.stringify({
                type: "text_delta",
                text: contentBlock.text,
              });
            }
          }
          if (blockType === "tool_use") {
            const current = toolState.get(index) ?? {
              args: "",
              emitted: false,
            };
            if (typeof contentBlock?.name === "string") {
              current.name = contentBlock.name;
            }
            if (typeof contentBlock?.input === "string") {
              current.args += contentBlock.input;
            } else if (
              contentBlock?.input &&
              typeof contentBlock.input === "object"
            ) {
              const serializedInput = JSON.stringify(contentBlock.input);
              if (serializedInput !== "{}") {
                current.args = serializedInput;
              }
            }
            toolState.set(index, current);
          }
        }

        if (eventType === "content_block_delta") {
          const deltaType =
            parsed.delta && typeof parsed.delta.type === "string"
              ? parsed.delta.type
              : "";
          if (
            deltaType === "text_delta" &&
            typeof parsed.delta?.text === "string" &&
            parsed.delta.text
          ) {
            yield JSON.stringify({
              type: "text_delta",
              text: parsed.delta.text,
            });
          }
          if (
            deltaType === "input_json_delta" &&
            typeof parsed.delta?.partial_json === "string"
          ) {
            const current = toolState.get(index) ?? {
              args: "",
              emitted: false,
            };
            current.args += parsed.delta.partial_json;
            toolState.set(index, current);
          }
        }

        if (eventType === "content_block_stop") {
          const current = toolState.get(index);
          if (current?.name && !current.emitted) {
            const parsedArgs = parseAnthropicToolArgs(current.args);
            if (
              parsedArgs &&
              typeof parsedArgs === "object" &&
              Object.keys(parsedArgs as Record<string, unknown>).length > 0
            ) {
              yield JSON.stringify({
                type: "tool_call",
                toolName: current.name,
                input: parsedArgs,
              });
              current.emitted = true;
              toolState.set(index, current);
            }
          }
        }

        if (eventType === "message_stop") {
          sawExplicitCompletion = true;
          if (snapshotPath && usageEvents.length > 0) {
            try {
              await updateAnthropicSnapshotLatestUsage(
                snapshotPath,
                usageEvents
              );
            } catch {
              // ignore debug write errors
            }
          }
          yield stopReason
            ? buildAnthropicStopReasonCompletionEvent(stopReason)
            : buildProviderCompletionEvent(
                "message_stop",
                "The provider ended the response with message_stop.",
                true
              );
          if (stopReason && !isAnthropicExpectedStopReason(stopReason)) {
            yield buildAnthropicStopReasonInterruptionEvent(stopReason);
          }
          yield DONE_EVENT;
          return;
        }
      } catch {
        // ignore malformed SSE data line
      }
    }
  }

  if (snapshotPath && usageEvents.length > 0) {
    try {
      await updateAnthropicSnapshotLatestUsage(snapshotPath, usageEvents);
    } catch {
      // ignore debug write errors
    }
  }

  if (!sawExplicitCompletion) {
    yield buildUnexpectedSocketCloseCompletionEvent();
    yield buildUnexpectedSocketCloseEvent();
  }
  yield DONE_EVENT;
}

const parseModelsPayload = (payload: unknown): string[] => {
  if (
    payload &&
    typeof payload === "object" &&
    "models" in payload &&
    Array.isArray((payload as { models: unknown[] }).models)
  ) {
    const models = (payload as { models: Array<{ name?: unknown }> }).models
      .map(item => (typeof item?.name === "string" ? item.name : ""))
      .map(name => name.replace(/^models\//, "").trim())
      .filter(Boolean);
    return Array.from(new Set(models));
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !Array.isArray((payload as { data: unknown[] }).data)
  ) {
    return [];
  }

  const models: string[] = [];
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== "object" || !("id" in item)) {
      continue;
    }
    const id = (item as { id: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      models.push(id.trim());
    }
  }

  return Array.from(new Set(models));
};

const shouldFallbackToManualModelCatalog = (status: number) =>
  status === 404 || status === 405 || status === 410 || status === 501;

const buildManualModelCatalog = (options: {
  providerBaseUrl: string;
  providerFamily: ProviderFamily;
  preferredModel?: string;
  currentModel?: string;
}): ProviderModelCatalogResult => {
  const fallbackModel = resolveDefaultModelForFamily(options.providerFamily);
  const selectedModel =
    options.preferredModel?.trim() ||
    options.currentModel?.trim() ||
    fallbackModel;
  const models = Array.from(
    new Set(
      [
        options.preferredModel?.trim(),
        options.currentModel?.trim(),
        selectedModel,
      ].filter(Boolean)
    )
  ) as string[];
  return {
    providerBaseUrl: options.providerBaseUrl,
    models,
    selectedModel,
    catalogMode: "manual",
  };
};

export type ProviderModelCatalogResult = {
  providerBaseUrl: string;
  models: string[];
  selectedModel: string;
  catalogMode: ProviderModelCatalogMode;
};

export const fetchProviderModelCatalog = async (options: {
  baseUrl: string;
  apiKey: string;
  preferredModel?: string;
  currentModel?: string;
  familyOverride?: ProviderFamily;
  endpointOverride?: string | null;
}): Promise<ProviderModelCatalogResult> => {
  const parsedProvider = parseProviderBaseUrl(options.baseUrl);
  const providerBaseUrl = parsedProvider.providerBaseUrl;
  const providerFamily = options.familyOverride ?? parsedProvider.family;
  const requestUrl = resolveModelsUrl(providerBaseUrl, options.endpointOverride);
  const response =
    providerFamily === "anthropic"
      ? await fetch(requestUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
        })
      : await fetch(requestUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            ...(providerFamily === "gemini"
              ? { "x-goog-api-key": options.apiKey }
              : {}),
          },
        });
  if (!response.ok) {
    if (shouldFallbackToManualModelCatalog(response.status)) {
      return buildManualModelCatalog({
        providerBaseUrl,
        providerFamily,
        preferredModel: options.preferredModel,
        currentModel: options.currentModel,
      });
    }
    throw new Error(await formatHttpFailure("Model fetch failed", response, requestUrl));
  }
  const payload = (await response.json()) as unknown;
  const models = parseModelsPayload(payload);
  if (models.length === 0) {
    return buildManualModelCatalog({
      providerBaseUrl,
      providerFamily,
      preferredModel: options.preferredModel,
      currentModel: options.currentModel,
    });
  }

  const fallbackModel = resolveDefaultModelForFamily(providerFamily);
  const firstModel = models[0] ?? options.currentModel ?? fallbackModel;
  const selectedModel =
    (options.preferredModel && models.includes(options.preferredModel)
      ? options.preferredModel
      : undefined) ??
    (options.currentModel && models.includes(options.currentModel)
      ? options.currentModel
      : undefined) ??
    firstModel;

  return {
    providerBaseUrl,
    models,
    selectedModel,
    catalogMode: "api",
  };
};

export type HttpQueryTransportOptions = {
  appRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTemperature?: number;
  mcpTools?: McpToolDescriptor[];
  debugAnthropicRequests?: AnthropicRequestCaptureOptions;
};

type ParsedHttpEnv = z.infer<typeof envSchema>;

const resolveDefaultModelForFamily = (family: ProviderFamily) =>
  family === "anthropic"
    ? "claude-3-7-sonnet-latest"
    : family === "glm"
      ? "glm-4-flash"
      : "gpt-4o-mini";

const resolveDefaultFormatForProvider = (
  provider: string | undefined,
  familyOverride?: ProviderFamily
): TransportFormat => {
  const normalizedProvider = resolveProviderBaseUrl(provider);
  const family =
    familyOverride ??
    (normalizedProvider ? resolveProviderFamily(normalizedProvider) : "openai");
  if (family === "anthropic") {
    return "anthropic_messages";
  }
  if (
    family === "gemini" &&
    normalizedProvider &&
    !normalizedProvider.includes("/openai")
  ) {
    try {
      if (
        new URL(normalizedProvider).hostname.toLowerCase() ===
        "generativelanguage.googleapis.com"
      ) {
        return "gemini_generate_content";
      }
    } catch {
      // Fall through to the default OpenAI-compatible format.
    }
  }
  if (normalizedProvider && normalizedProvider.endsWith("/responses")) {
    return "openai_responses";
  }
  return "openai_chat";
};

const resolveDefaultTypeForProvider = (
  provider: string | undefined,
  familyOverride?: ProviderFamily
): ProviderType | null => {
  const normalizedProvider = resolveProviderBaseUrl(provider);
  const family =
    familyOverride ??
    (normalizedProvider ? resolveProviderFamily(normalizedProvider) : "openai");
  return inferProviderType({
    family,
    format: resolveDefaultFormatForProvider(normalizedProvider, family),
  });
};

const resolveApiKeySourceForFamily = (
  family: ProviderFamily,
  env: ParsedHttpEnv
) => {
  if (family === "anthropic" && env.CYRENE_ANTHROPIC_API_KEY) {
    return "CYRENE_ANTHROPIC_API_KEY";
  }
  if (family === "gemini" && env.CYRENE_GEMINI_API_KEY) {
    return "CYRENE_GEMINI_API_KEY";
  }
  if (family === "glm") {
    return env.CYRENE_API_KEY ? "CYRENE_API_KEY" : "none";
  }
  if (family === "openai" && env.CYRENE_OPENAI_API_KEY) {
    return "CYRENE_OPENAI_API_KEY";
  }
  return env.CYRENE_API_KEY ? "CYRENE_API_KEY" : "none";
};

const resolveApiKeyForFamily = (
  family: ProviderFamily,
  env: ParsedHttpEnv
) => {
  if (family === "anthropic") {
    return env.CYRENE_ANTHROPIC_API_KEY ?? env.CYRENE_API_KEY;
  }
  if (family === "gemini") {
    return env.CYRENE_GEMINI_API_KEY ?? env.CYRENE_API_KEY;
  }
  if (family === "glm") {
    return env.CYRENE_API_KEY;
  }
  return env.CYRENE_OPENAI_API_KEY ?? env.CYRENE_API_KEY;
};

const resolveApiKeySourceForProvider = (
  provider: string | undefined,
  env: ParsedHttpEnv,
  resolveFamily?: (provider: string) => ProviderFamily
) => {
  if (!provider) {
    return env.CYRENE_API_KEY ? "CYRENE_API_KEY" : "none";
  }
  const family = resolveFamily
    ? resolveFamily(provider)
    : resolveProviderFamily(provider);
  return resolveApiKeySourceForFamily(family, env);
};

const resolveApiKeyForProvider = (
  provider: string | undefined,
  env: ParsedHttpEnv,
  resolveFamily?: (provider: string) => ProviderFamily
) => {
  if (!provider) {
    return env.CYRENE_API_KEY;
  }
  const family = resolveFamily
    ? resolveFamily(provider)
    : resolveProviderFamily(provider);
  return resolveApiKeyForFamily(family, env);
};

export const createHttpQueryTransport = (
  options?: HttpQueryTransportOptions
): QueryTransport => {
  const effectiveEnv = options?.env ?? process.env;
  const includeReasoningInTranscript =
    effectiveEnv.CYRENE_STREAM_REASONING === "1";
  const requestTemperature =
    typeof options?.requestTemperature === "number" &&
    Number.isFinite(options.requestTemperature)
      ? Math.min(2, Math.max(0, options.requestTemperature))
      : 0.2;
  const appRoot =
    options?.appRoot ??
    resolveAmbientAppRoot({
      cwd: options?.cwd,
      env: effectiveEnv,
    });
  const exposedMcpTools = sortMcpToolsForStablePromptCache(
    (options?.mcpTools ?? []).filter(tool => tool.enabled && tool.exposure !== "hidden")
  );
  const defaultToolUsageSystemPrompt = buildToolUsageSystemPrompt(exposedMcpTools);
  const anthropicToolUsageSystemPrompt = buildToolUsageSystemPrompt(
    exposedMcpTools,
    ANTHROPIC_TOOL_USAGE_SYSTEM_PROMPT
  );
  const env = envSchema.safeParse({
    CYRENE_BASE_URL: effectiveEnv.CYRENE_BASE_URL,
    CYRENE_API_KEY: effectiveEnv.CYRENE_API_KEY,
    CYRENE_OPENAI_API_KEY: effectiveEnv.CYRENE_OPENAI_API_KEY,
    CYRENE_GEMINI_API_KEY: effectiveEnv.CYRENE_GEMINI_API_KEY,
    CYRENE_ANTHROPIC_API_KEY: effectiveEnv.CYRENE_ANTHROPIC_API_KEY,
    CYRENE_MODEL: effectiveEnv.CYRENE_MODEL,
  });

  const parsedEnv: ParsedHttpEnv = env.success
    ? env.data
    : {
        CYRENE_BASE_URL: undefined,
        CYRENE_API_KEY: undefined,
        CYRENE_OPENAI_API_KEY: undefined,
        CYRENE_GEMINI_API_KEY: undefined,
        CYRENE_ANTHROPIC_API_KEY: undefined,
        CYRENE_MODEL: undefined,
      };
  const baseUrl = parsedEnv.CYRENE_BASE_URL;
  let currentModel = env.success
    ? env.data.CYRENE_MODEL ??
      resolveDefaultModelForFamily(
        baseUrl ? resolveProviderFamily(baseUrl) : "openai"
      )
    : "gpt-4o-mini";
  let currentProvider = resolveProviderBaseUrl(baseUrl);
  let availableModels: string[] = [];
  let providerCatalog = currentProvider ? [currentProvider] : ([] as string[]);
  let providerProfileOverrides: ProviderProfileOverrideMap = {};
  let providerTypeOverrides: ProviderTypeOverrideMap = {};
  let providerModelModes: ProviderModelCatalogModeMap = {};
  let providerFormatOverrides: ProviderFormatOverrideMap = {};
  let providerEndpointOverrides: ProviderEndpointOverrideMap = {};
  let providerNameOverrides: ProviderNameOverrideMap = {};
  let initializationError: string | null = null;
  const openAiPromptCacheCapabilities: OpenAiPromptCacheCapabilityStore = new Map();
  const anthropicCacheSessionState = createAnthropicPromptCacheSessionState();
  const sessionQueries = new Map<
    string,
    {
      input: QueryInput;
      provider: string;
      model: string;
      apiKey: string;
      family: ProviderFamily;
      format: TransportFormat;
      endpointOverrides: ProviderEndpointOverrideEntry;
      mcpTools: McpToolDescriptor[];
      systemPrompt: string;
    }
  >();
  const dedupeProviders = (providers: Array<string | undefined>) =>
    Array.from(new Set(providers.map(provider => resolveProviderBaseUrl(provider)).filter(Boolean))) as string[];
  const getProviderTypeOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerTypeOverrides[normalizedProvider] ?? null;
  };
  const setProviderTypeOverride = (
    provider: string | undefined,
    type: ProviderType | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (!type) {
      if (normalizedProvider in providerTypeOverrides) {
        const next = { ...providerTypeOverrides };
        delete next[normalizedProvider];
        providerTypeOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerTypeOverrides[normalizedProvider] === type) {
      return normalizedProvider;
    }
    providerTypeOverrides = {
      ...providerTypeOverrides,
      [normalizedProvider]: type,
    };
    return normalizedProvider;
  };
  const resolveFamilyForProvider = (provider: string | undefined): ProviderFamily => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return "openai";
    }
    const overrideType = getProviderTypeOverride(normalizedProvider);
    if (overrideType) {
      return resolveProviderTypeFamily(overrideType);
    }
    const overrideFamily = providerProfileOverrides[normalizedProvider];
    if (overrideFamily) {
      return overrideFamily;
    }
    return resolveProviderFamily(normalizedProvider);
  };
  const getProviderProfileOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerProfileOverrides[normalizedProvider] ?? null;
  };
  const setProviderProfileOverride = (
    provider: string | undefined,
    profile: ManualProviderProfile | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (!profile) {
      if (normalizedProvider in providerProfileOverrides) {
        const next = { ...providerProfileOverrides };
        delete next[normalizedProvider];
        providerProfileOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerProfileOverrides[normalizedProvider] === profile) {
      return normalizedProvider;
    }
    providerProfileOverrides = {
      ...providerProfileOverrides,
      [normalizedProvider]: profile,
    };
    return normalizedProvider;
  };
  const getProviderModelMode = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return "api" as const;
    }
    return providerModelModes[normalizedProvider] ?? "api";
  };
  const hasResolvedProviderModelMode = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return false;
    }
    return normalizedProvider in providerModelModes;
  };
  const setProviderModelMode = (
    provider: string | undefined,
    mode: ProviderModelCatalogMode
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (providerModelModes[normalizedProvider] === mode) {
      return normalizedProvider;
    }
    providerModelModes = {
      ...providerModelModes,
      [normalizedProvider]: mode,
    };
    return normalizedProvider;
  };
  const getProviderFormatOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerFormatOverrides[normalizedProvider] ?? null;
  };
  const resolveLegacyFormatForProvider = (
    provider: string | undefined,
    familyOverride?: ProviderFamily
  ): TransportFormat | null => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return (
      getProviderFormatOverride(normalizedProvider) ??
      resolveDefaultFormatForProvider(
        normalizedProvider,
        familyOverride ?? resolveFamilyForProvider(normalizedProvider)
      )
    );
  };
  const setProviderFormatOverride = (
    provider: string | undefined,
    format: TransportFormat | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    if (!format) {
      if (normalizedProvider in providerFormatOverrides) {
        const next = { ...providerFormatOverrides };
        delete next[normalizedProvider];
        providerFormatOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerFormatOverrides[normalizedProvider] === format) {
      return normalizedProvider;
    }
    providerFormatOverrides = {
      ...providerFormatOverrides,
      [normalizedProvider]: format,
    };
    return normalizedProvider;
  };
  const getProviderNameOverride = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerNameOverrides[normalizedProvider] ?? null;
  };
  const cloneProviderEndpointOverrideEntry = (
    entry: ProviderEndpointOverrideEntry | undefined
  ): ProviderEndpointOverrideEntry => ({ ...(entry ?? {}) });
  const cloneProviderEndpointOverrideMap = (
    endpoints: ProviderEndpointOverrideMap
  ): ProviderEndpointOverrideMap =>
    Object.fromEntries(
      Object.entries(endpoints).map(([provider, entry]) => [
        provider,
        cloneProviderEndpointOverrideEntry(entry),
      ])
    );
  const getProviderEndpointOverrides = (provider: string | undefined) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return {};
    }
    return cloneProviderEndpointOverrideEntry(
      providerEndpointOverrides[normalizedProvider]
    );
  };
  const getProviderEndpointOverride = (
    provider: string | undefined,
    kind: ProviderEndpointKind
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return providerEndpointOverrides[normalizedProvider]?.[kind] ?? null;
  };
  const setProviderEndpointOverride = (
    provider: string | undefined,
    kind: ProviderEndpointKind,
    endpoint: string | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    const trimmedEndpoint = endpoint?.trim();
    const currentEntry = providerEndpointOverrides[normalizedProvider] ?? {};
    if (!trimmedEndpoint) {
      if (kind in currentEntry) {
        const nextEntry = { ...currentEntry };
        delete nextEntry[kind];
        if (Object.keys(nextEntry).length === 0) {
          const next = { ...providerEndpointOverrides };
          delete next[normalizedProvider];
          providerEndpointOverrides = next;
        } else {
          providerEndpointOverrides = {
            ...providerEndpointOverrides,
            [normalizedProvider]: nextEntry,
          };
        }
      }
      return normalizedProvider;
    }
    if (currentEntry[kind] === trimmedEndpoint) {
      return normalizedProvider;
    }
    providerEndpointOverrides = {
      ...providerEndpointOverrides,
      [normalizedProvider]: {
        ...currentEntry,
        [kind]: trimmedEndpoint,
      },
    };
    return normalizedProvider;
  };
  const setProviderNameOverride = (
    provider: string | undefined,
    name: string | null
  ) => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    const trimmedName = name?.trim();
    if (!trimmedName) {
      if (normalizedProvider in providerNameOverrides) {
        const next = { ...providerNameOverrides };
        delete next[normalizedProvider];
        providerNameOverrides = next;
      }
      return normalizedProvider;
    }
    if (providerNameOverrides[normalizedProvider] === trimmedName) {
      return normalizedProvider;
    }
    providerNameOverrides = {
      ...providerNameOverrides,
      [normalizedProvider]: trimmedName,
    };
    return normalizedProvider;
  };
  const normalizeLoadedProviderProfiles = (
    profiles: Record<string, string | undefined> | undefined
  ): ProviderProfileOverrideMap => {
    const normalizedEntries: Array<[string, ManualProviderProfile]> = [];
    for (const [provider, profile] of Object.entries(profiles ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        continue;
      }
      if (!profile || !isManualProviderProfile(profile)) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, profile]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderProfileOverrideMap;
  };
  const normalizeLoadedProviderTypes = (
    types: Record<string, string | undefined> | undefined
  ): ProviderTypeOverrideMap => {
    const normalizedEntries: Array<[string, ProviderType]> = [];
    for (const [provider, type] of Object.entries(types ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider || !type || !isProviderType(type)) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, type]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderTypeOverrideMap;
  };
  const normalizeLoadedProviderFormats = (
    formats: Record<string, string | undefined> | undefined
  ): ProviderFormatOverrideMap => {
    const normalizedEntries: Array<[string, TransportFormat]> = [];
    for (const [provider, format] of Object.entries(formats ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider || !format || !isTransportFormat(format)) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, format]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderFormatOverrideMap;
  };
  const normalizeLoadedProviderModelModes = (
    modes: Record<string, string | undefined> | undefined
  ): ProviderModelCatalogModeMap => {
    const normalizedEntries: Array<[string, ProviderModelCatalogMode]> = [];
    for (const [provider, mode] of Object.entries(modes ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (
        !normalizedProvider ||
        (mode !== "api" && mode !== "manual")
      ) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, mode]);
    }
    return Object.fromEntries(normalizedEntries) as ProviderModelCatalogModeMap;
  };
  const normalizeLoadedProviderNames = (
    names: Record<string, string | undefined> | undefined
  ): ProviderNameOverrideMap => {
    const normalizedEntries: Array<[string, string]> = [];
    for (const [provider, name] of Object.entries(names ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      const normalizedName = name?.trim();
      if (!normalizedProvider || !normalizedName) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, normalizedName]);
    }
    return Object.fromEntries(normalizedEntries);
  };
  const normalizeLoadedProviderEndpoints = (
    endpoints: ProviderEndpointOverrideMap | undefined
  ): ProviderEndpointOverrideMap => {
    const normalizedEntries: Array<[string, ProviderEndpointOverrideEntry]> = [];
    for (const [provider, entry] of Object.entries(endpoints ?? {})) {
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        continue;
      }
      const normalizedEntry = Object.fromEntries(
        Object.entries(entry ?? {})
          .map(([kind, endpoint]) => {
            const trimmedEndpoint = endpoint?.trim();
            return isProviderEndpointKind(kind) && trimmedEndpoint
              ? ([kind, trimmedEndpoint] as const)
              : null;
          })
          .filter(
            (endpointEntry): endpointEntry is [ProviderEndpointKind, string] =>
              Boolean(endpointEntry)
          )
      ) as ProviderEndpointOverrideEntry;
      if (Object.keys(normalizedEntry).length === 0) {
        continue;
      }
      normalizedEntries.push([normalizedProvider, normalizedEntry]);
    }
    return Object.fromEntries(normalizedEntries);
  };
  const resolvePersistedModels = () =>
    availableModels.length > 0
      ? [...availableModels]
      : currentModel.trim()
        ? [currentModel]
        : ["gpt-4o-mini"];
  const resolveTypeForProvider = (
    provider: string | undefined,
    familyOverride?: ProviderFamily,
    formatOverride?: TransportFormat
  ): ProviderType | null => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    return (
      getProviderTypeOverride(normalizedProvider) ??
      inferProviderType({
        family: familyOverride ?? resolveFamilyForProvider(normalizedProvider),
        format:
          formatOverride ??
          resolveLegacyFormatForProvider(
            normalizedProvider,
            familyOverride ?? resolveFamilyForProvider(normalizedProvider)
          ) ??
          resolveDefaultFormatForProvider(normalizedProvider),
      })
    );
  };
  const resolveFormatForProvider = (
    provider: string | undefined,
    familyOverride?: ProviderFamily
  ): TransportFormat | null => {
    const normalizedProvider = resolveProviderBaseUrl(provider);
    if (!normalizedProvider) {
      return null;
    }
    const overrideType = getProviderTypeOverride(normalizedProvider);
    if (overrideType) {
      return resolveProviderTypeFormat(overrideType, normalizedProvider);
    }
    return resolveLegacyFormatForProvider(normalizedProvider, familyOverride);
  };
  const persistCatalog = async (
    models: string[],
    selectedModel: string,
    provider: string | undefined
  ) => {
    providerCatalog = dedupeProviders([...providerCatalog, provider]);
    await saveModelYaml(models, selectedModel, {
      lastUsedModel: selectedModel,
      providerBaseUrl: provider,
      providers: providerCatalog,
      providerProfiles: providerProfileOverrides,
      providerTypes: providerTypeOverrides,
      providerModelModes,
      providerFormats: providerFormatOverrides,
      providerEndpoints: providerEndpointOverrides,
      providerNames: providerNameOverrides,
    }, appRoot, {
      cwd: options?.cwd,
      env: effectiveEnv,
    });
  };

  const refreshFromApi = async (
    preferredModel?: string,
    providerOverride?: string
  ) => {
    const targetProvider = resolveProviderBaseUrl(providerOverride ?? currentProvider ?? baseUrl);
    const targetApiKey = resolveApiKeyForProvider(
      targetProvider,
      parsedEnv,
      resolveFamilyForProvider
    );
    if (!targetProvider || !targetApiKey) {
      throw new Error("Missing provider or API key. Use /provider and /login.");
    }
    const catalog = await fetchProviderModelCatalog({
      baseUrl: targetProvider,
      apiKey: targetApiKey,
      preferredModel,
      currentModel,
      familyOverride: resolveFamilyForProvider(targetProvider),
      endpointOverride: getProviderEndpointOverride(targetProvider, "models"),
    });
    const previousProviderModelModes = providerModelModes;
    setProviderModelMode(catalog.providerBaseUrl, catalog.catalogMode);
    try {
      await persistCatalog(
        catalog.models,
        catalog.selectedModel,
        catalog.providerBaseUrl
      );
    } catch (error) {
      providerModelModes = previousProviderModelModes;
      throw error;
    }
    availableModels = catalog.models;
    currentModel = catalog.selectedModel;
    currentProvider = catalog.providerBaseUrl;
    initializationError = null;

    return catalog.models;
  };

  const initializeModels = async () => {
    try {
      const local = await loadModelYaml(appRoot, {
        cwd: options?.cwd,
        env: effectiveEnv,
      });
      providerProfileOverrides = normalizeLoadedProviderProfiles(
        local.providerProfiles
      );
      providerTypeOverrides = normalizeLoadedProviderTypes(local.providerTypes);
      providerModelModes = normalizeLoadedProviderModelModes(
        local.providerModelModes
      );
      providerFormatOverrides = normalizeLoadedProviderFormats(
        local.providerFormats
      );
      providerEndpointOverrides = normalizeLoadedProviderEndpoints(
        local.providerEndpoints
      );
      providerNameOverrides = normalizeLoadedProviderNames(local.providerNames);
      const localProvider = resolveProviderBaseUrl(local.providerBaseUrl);
      providerCatalog = dedupeProviders([
        ...local.providers,
        ...Object.keys(providerProfileOverrides),
        ...Object.keys(providerTypeOverrides),
        ...Object.keys(providerModelModes),
        ...Object.keys(providerFormatOverrides),
        ...Object.keys(providerEndpointOverrides),
        ...Object.keys(providerNameOverrides),
        localProvider,
        currentProvider,
      ]);
      const providerChanged =
        Boolean(currentProvider) &&
        Boolean(localProvider) &&
        localProvider !== currentProvider;
      if (providerChanged) {
        await refreshFromApi(
          local.lastUsedModel ?? local.defaultModel ?? currentModel,
          currentProvider
        );
        return;
      }
      currentProvider = currentProvider ?? localProvider;
      availableModels = local.models;
      currentModel =
        (local.lastUsedModel && local.models.includes(local.lastUsedModel)
          ? local.lastUsedModel
          : undefined) ??
        (local.defaultModel && local.models.includes(local.defaultModel)
          ? local.defaultModel
          : undefined) ??
        (local.models.includes(currentModel)
          ? currentModel
          : (local.models[0] ?? currentModel));
      initializationError = null;
      if (providerCatalog.length > 0) {
        await persistCatalog(local.models, currentModel, currentProvider);
      }
      return;
    } catch {
      // Fall through to remote fetch.
    }

    try {
      await refreshFromApi(undefined, currentProvider);
    } catch (error) {
      initializationError =
        error instanceof Error ? error.message : String(error);
    }
  };

  const modelInit = initializeModels();

  return {
    getModel: () => currentModel,
    getProvider: () => currentProvider ?? "none",
    describeProvider: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return {
          provider: "none",
          vendor: "none",
          keySource: "none",
        };
      }
      const family = resolveFamilyForProvider(normalizedProvider);
      const keySource = resolveApiKeySourceForProvider(
        normalizedProvider,
        parsedEnv,
        resolveFamilyForProvider
      );
      const vendor = family === "glm" ? "custom" : family;
      const format = resolveFormatForProvider(normalizedProvider, family) ?? undefined;
      return {
        provider: normalizedProvider,
        vendor,
        keySource,
        type:
          family === "glm"
            ? undefined
            : (resolveTypeForProvider(normalizedProvider, family, format) ?? undefined),
        format,
      };
    },
    setProviderProfile: async (provider: string, profile: ProviderProfile) => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const normalizedProfile = profile.trim().toLowerCase();
      const isCustomProfile = normalizedProfile === "custom";
      if (!isCustomProfile && !isManualProviderProfile(normalizedProfile)) {
        return {
          ok: false,
          message:
            "Profile must be one of: openai, gemini, anthropic, custom.",
        };
      }

      const previousOverrides = providerProfileOverrides;
      const previousTypeOverrides = providerTypeOverrides;
      const previousProvider = currentProvider;
      const previousModel = currentModel;
      const previousModels = [...availableModels];
      const previousProviderCatalog = [...providerCatalog];

      setProviderTypeOverride(normalizedProvider, null);
      setProviderProfileOverride(
        normalizedProvider,
        isCustomProfile ? null : normalizedProfile
      );
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        if (currentProvider === normalizedProvider) {
          await refreshFromApi(undefined, normalizedProvider);
        } else {
          await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
        }
      } catch (error) {
        providerProfileOverrides = previousOverrides;
        providerTypeOverrides = previousTypeOverrides;
        currentProvider = previousProvider;
        currentModel = previousModel;
        availableModels = previousModels;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider profile: ${error.message}`
              : `Failed to apply provider profile: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderProfileOverride(normalizedProvider);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider profile override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider profile override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        profile: appliedOverride ?? "custom",
      };
    },
    getProviderProfile: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return getProviderProfileOverride(normalizedProvider) ?? "custom";
    },
    listProviderProfiles: () => ({ ...providerProfileOverrides }),
    setProviderType: async (
      provider: string,
      type: ProviderType | null
    ): Promise<ProviderTypeSetResult> => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const normalizedType =
        typeof type === "string" && type.trim()
          ? (type.trim().toLowerCase() as ProviderType)
          : null;
      if (normalizedType && !isProviderType(normalizedType)) {
        return {
          ok: false,
          message:
            "Provider type must be one of: openai-compatible, openai-responses, gemini, anthropic.",
        };
      }

      const previousTypeOverrides = providerTypeOverrides;
      const previousProfileOverrides = providerProfileOverrides;
      const previousFormatOverrides = providerFormatOverrides;
      const previousProvider = currentProvider;
      const previousModel = currentModel;
      const previousModels = [...availableModels];
      const previousProviderCatalog = [...providerCatalog];

      if (normalizedType) {
        setProviderProfileOverride(normalizedProvider, null);
        setProviderFormatOverride(normalizedProvider, null);
      }
      setProviderTypeOverride(normalizedProvider, normalizedType);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        if (currentProvider === normalizedProvider) {
          await refreshFromApi(undefined, normalizedProvider);
        } else {
          await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
        }
      } catch (error) {
        providerTypeOverrides = previousTypeOverrides;
        providerProfileOverrides = previousProfileOverrides;
        providerFormatOverrides = previousFormatOverrides;
        currentProvider = previousProvider;
        currentModel = previousModel;
        availableModels = previousModels;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider type: ${error.message}`
              : `Failed to apply provider type: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderTypeOverride(normalizedProvider);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider type override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider type override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        type:
          appliedOverride ??
          resolveDefaultTypeForProvider(
            normalizedProvider,
            resolveFamilyForProvider(normalizedProvider)
          ) ??
          undefined,
      };
    },
    getProviderType: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return resolveTypeForProvider(normalizedProvider);
    },
    listProviderTypes: () => ({ ...providerTypeOverrides }),
    setProviderFormat: async (
      provider: string,
      format: TransportFormat | null
    ): Promise<ProviderFormatSetResult> => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const normalizedFormat =
        typeof format === "string" && format.trim()
          ? (format.trim().toLowerCase() as TransportFormat)
          : null;
      if (normalizedFormat && !isTransportFormat(normalizedFormat)) {
        return {
          ok: false,
          message:
            "Format must be one of: openai_chat, openai_responses, anthropic_messages, gemini_generate_content.",
        };
      }

      const previousOverrides = providerFormatOverrides;
      const previousTypeOverrides = providerTypeOverrides;
      const previousProviderCatalog = [...providerCatalog];

      setProviderTypeOverride(normalizedProvider, null);
      setProviderFormatOverride(normalizedProvider, normalizedFormat);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
      } catch (error) {
        providerFormatOverrides = previousOverrides;
        providerTypeOverrides = previousTypeOverrides;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider format: ${error.message}`
              : `Failed to apply provider format: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderFormatOverride(normalizedProvider);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider format override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider format override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        format:
          appliedOverride ??
          resolveDefaultFormatForProvider(
            normalizedProvider,
            resolveFamilyForProvider(normalizedProvider)
          ),
      };
    },
    getProviderFormat: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return resolveFormatForProvider(normalizedProvider);
    },
    listProviderFormats: () => ({ ...providerFormatOverrides }),
    setProviderEndpoint: async (
      provider: string,
      kind: ProviderEndpointKind,
      endpoint: string | null
    ): Promise<ProviderEndpointSetResult> => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }
      if (!isProviderEndpointKind(kind)) {
        return {
          ok: false,
          message:
            "Endpoint kind must be one of: responses, chat_completions, models, anthropic_messages, gemini_generate_content.",
        };
      }

      const trimmedEndpoint = endpoint?.trim() ?? "";
      if (trimmedEndpoint.includes(" ")) {
        return {
          ok: false,
          message:
            "Endpoint override must be a single path or absolute URL without spaces.",
        };
      }
      if (trimmedEndpoint) {
        try {
          switch (kind) {
            case "responses":
              resolveResponsesUrls(normalizedProvider, trimmedEndpoint);
              break;
            case "chat_completions":
              resolveChatCompletionsUrl(normalizedProvider, trimmedEndpoint);
              break;
            case "models":
              resolveModelsUrl(normalizedProvider, trimmedEndpoint);
              break;
            case "anthropic_messages":
              resolveAnthropicMessagesUrl(normalizedProvider, trimmedEndpoint);
              break;
            case "gemini_generate_content":
              resolveGeminiGenerateContentUrl(
                normalizedProvider,
                currentModel || resolveDefaultModelForFamily(resolveFamilyForProvider(normalizedProvider)),
                trimmedEndpoint
              );
              break;
          }
        } catch (error) {
          return {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : `Invalid endpoint override: ${String(error)}`,
          };
        }
      }

      const previousOverrides = providerEndpointOverrides;
      const previousProviderCatalog = [...providerCatalog];

      setProviderEndpointOverride(normalizedProvider, kind, trimmedEndpoint || null);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
      } catch (error) {
        providerEndpointOverrides = previousOverrides;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to apply provider endpoint: ${error.message}`
              : `Failed to apply provider endpoint: ${String(error)}`,
        };
      }

      const appliedOverride = getProviderEndpointOverride(normalizedProvider, kind);
      return {
        ok: true,
        message: appliedOverride
          ? `Provider ${kind} endpoint override set: ${normalizedProvider} => ${appliedOverride}`
          : `Provider ${kind} endpoint override cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        kind,
        endpoint: appliedOverride ?? undefined,
      };
    },
    getProviderEndpoint: (
      provider: string | undefined,
      kind: ProviderEndpointKind
    ) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider || !isProviderEndpointKind(kind)) {
        return null;
      }
      return getProviderEndpointOverride(normalizedProvider, kind);
    },
    listProviderEndpoints: () =>
      cloneProviderEndpointOverrideMap(providerEndpointOverrides),
    setProviderName: async (provider: string, name: string | null) => {
      await modelInit;
      const normalizedProvider = resolveProviderBaseUrl(provider);
      if (!normalizedProvider) {
        return {
          ok: false,
          message: "Provider cannot be empty.",
        };
      }

      const previousOverrides = providerNameOverrides;
      const previousProviderCatalog = [...providerCatalog];
      const trimmedName = name?.trim() ?? "";

      setProviderNameOverride(normalizedProvider, trimmedName || null);
      providerCatalog = dedupeProviders([normalizedProvider, ...providerCatalog]);

      try {
        await persistCatalog(resolvePersistedModels(), currentModel, currentProvider);
      } catch (error) {
        providerNameOverrides = previousOverrides;
        providerCatalog = previousProviderCatalog;
        return {
          ok: false,
          message:
            error instanceof Error
              ? `Failed to save provider name: ${error.message}`
              : `Failed to save provider name: ${String(error)}`,
        };
      }

      return {
        ok: true,
        message: trimmedName
          ? `Provider name set: ${normalizedProvider} => ${trimmedName}`
          : `Provider name cleared: ${normalizedProvider}`,
        provider: normalizedProvider,
        name: trimmedName || undefined,
      };
    },
    getProviderName: (provider?: string) => {
      const normalizedProvider = resolveProviderBaseUrl(
        provider ?? currentProvider ?? baseUrl
      );
      if (!normalizedProvider) {
        return null;
      }
      return getProviderNameOverride(normalizedProvider);
    },
    listProviderNames: () => ({ ...providerNameOverrides }),
    setModel: async (model: string) => {
      await modelInit;
      const next = model.trim();
      if (!next) {
        return {
          ok: false,
          message: "Model name cannot be empty.",
        };
      }
      if (availableModels.length === 0) {
        return {
          ok: false,
          message:
            initializationError ??
            "No available models. Run /model refresh to load catalog.",
        };
      }
      let manualModelMode = getProviderModelMode(currentProvider) === "manual";
      if (
        !manualModelMode &&
        !availableModels.includes(next) &&
        hasResolvedProviderModelMode(currentProvider) === false &&
        currentProvider
      ) {
        try {
          await refreshFromApi(next, currentProvider);
          manualModelMode = getProviderModelMode(currentProvider) === "manual";
        } catch {
          manualModelMode = false;
        }
      }
      if (!availableModels.includes(next) && !manualModelMode) {
        return {
          ok: false,
          message: `Model "${next}" is not in model catalog.`,
        };
      }
      const previousModel = currentModel;
      const previousModels = [...availableModels];
      if (!availableModels.includes(next)) {
        availableModels = [...availableModels, next];
      }
      currentModel = next;
      try {
        await persistCatalog(availableModels, next, currentProvider);
      } catch (error) {
        currentModel = previousModel;
        availableModels = previousModels;
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : String(error),
        };
      }
      return {
        ok: true,
        message: `Model switched to: ${currentModel}`,
      };
    },
    listModels: async () => {
      await modelInit;
      return [...availableModels];
    },
    listProviders: async () => {
      await modelInit;
      providerCatalog = dedupeProviders([
        ...providerCatalog,
        ...Object.keys(providerProfileOverrides),
        ...Object.keys(providerTypeOverrides),
        ...Object.keys(providerFormatOverrides),
        ...Object.keys(providerEndpointOverrides),
        ...Object.keys(providerNameOverrides),
        currentProvider,
      ]);
      return [...providerCatalog];
    },
    setProvider: async (provider: string) => {
      await modelInit;
      let nextProvider: string;
      try {
        nextProvider = normalizeProviderBaseUrl(provider.trim());
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const providerApiKey = resolveApiKeyForProvider(
        nextProvider,
        parsedEnv,
        resolveFamilyForProvider
      );
      if (!providerApiKey) {
        return {
          ok: false,
          message:
            "Missing API key for selected provider. Set CYRENE_API_KEY (or provider-specific key).",
        };
      }
      if (currentProvider === nextProvider) {
        providerCatalog = dedupeProviders([...providerCatalog, currentProvider]);
        return {
          ok: true,
          message: `Provider already active: ${nextProvider}`,
          currentProvider: nextProvider,
          providers: [...providerCatalog],
          models: [...availableModels],
        };
      }
      try {
        const models = await refreshFromApi(undefined, nextProvider);
        return {
          ok: true,
          message: `Provider switched to: ${nextProvider}\nCurrent model: ${currentModel}`,
          currentProvider: currentProvider ?? nextProvider,
          providers: [...providerCatalog],
          models,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message,
        };
      }
    },
    refreshModels: async () => {
      try {
        const models = await refreshFromApi(undefined, currentProvider);
        return {
          ok: true,
          message: `Model list refreshed: ${models.length} models`,
          models,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message,
        };
      }
    },
    requestStreamUrl: async query => {
      await modelInit;
      const normalizedInput = normalizeQueryInput(query);
      const targetProvider = currentProvider ?? resolveProviderBaseUrl(baseUrl);
      if (!targetProvider) {
        throw new Error(
          "Missing CYRENE_BASE_URL (or /provider) for HTTP transport."
        );
      }
      const targetApiKey = resolveApiKeyForProvider(
        targetProvider,
        parsedEnv,
        resolveFamilyForProvider
      );
      if (!targetApiKey) {
        throw new Error(
          "Missing API key for current provider. Use /login or set provider-specific key env."
        );
      }
      if (initializationError && availableModels.length === 0) {
        throw new Error(
          `Model initialization failed: ${initializationError}. Run /model refresh after fixing API/base URL.`
        );
      }
      const providerFamily = resolveFamilyForProvider(targetProvider);
      const providerFormat =
        resolveFormatForProvider(targetProvider, providerFamily) ??
        resolveDefaultFormatForProvider(targetProvider, providerFamily);
      if (
        normalizedInput.attachments.length > 0 &&
        !supportsImageAttachmentsForFormat(providerFormat)
      ) {
        throw new Error(
          `Current provider format ${providerFormat} does not support image attachments. Switch to a provider/model using Responses, Anthropic Messages, or Gemini Generate Content.`
        );
      }
      const modelForRequest =
        currentModel || resolveDefaultModelForFamily(providerFamily);
      const sessionId = crypto.randomUUID();
      sessionQueries.set(sessionId, {
        input: normalizedInput,
        provider: targetProvider,
        model: modelForRequest,
        apiKey: targetApiKey,
        family: providerFamily,
        format: providerFormat,
        endpointOverrides: getProviderEndpointOverrides(targetProvider),
        mcpTools: exposedMcpTools,
        systemPrompt:
          providerFormat === "anthropic_messages"
            ? anthropicToolUsageSystemPrompt
            : defaultToolUsageSystemPrompt,
      });
      return `openai://${sessionId}`;
    },
    stream: async function* (
      streamUrl: string,
      streamOptions?: QueryTransportStreamOptions
    ) {
      const sessionId = streamUrl.replace("openai://", "");
      const session = sessionQueries.get(sessionId);
      sessionQueries.delete(sessionId);

      if (!session) {
        throw new Error("Invalid HTTP stream session.");
      }

      if (session.format === "anthropic_messages") {
        for await (const event of streamSseAnthropic(
          session.provider,
          session.apiKey,
          session.model,
          session.input,
          {
            temperature: requestTemperature,
            endpointOverride: session.endpointOverrides.anthropic_messages,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
            appRoot,
            env: effectiveEnv,
            captureId: sessionId,
            debugAnthropicRequests: options?.debugAnthropicRequests,
            cacheSessionState: anthropicCacheSessionState,
            signal: streamOptions?.signal,
          }
        )) {
          yield event;
        }
        return;
      }

      if (session.format === "openai_responses") {
        for await (const event of streamSseOpenAIResponses(
          session.provider,
          session.apiKey,
          session.model,
          session.input,
          {
            temperature: requestTemperature,
            family: session.family,
            endpointOverride: session.endpointOverrides.responses,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
            appRoot,
            env: effectiveEnv,
            promptCacheCapabilities: openAiPromptCacheCapabilities,
            signal: streamOptions?.signal,
          }
        )) {
          yield event;
        }
        return;
      }

      if (session.format === "gemini_generate_content") {
        for await (const event of streamSseGeminiGenerateContent(
          session.provider,
          session.apiKey,
          session.model,
          session.input,
          {
            temperature: requestTemperature,
            endpointOverride: session.endpointOverrides.gemini_generate_content,
            mcpTools: session.mcpTools,
            systemPrompt: session.systemPrompt,
            appRoot,
            signal: streamOptions?.signal,
          }
        )) {
          yield event;
        }
        return;
      }

      for await (const event of streamSseOpenAI(
        session.provider,
        session.apiKey,
        session.model,
        session.input,
        {
          includeReasoning: includeReasoningInTranscript,
          temperature: requestTemperature,
          family: session.family,
          endpointOverride: session.endpointOverrides.chat_completions,
          mcpTools: session.mcpTools,
          systemPrompt: session.systemPrompt,
          appRoot,
          env: effectiveEnv,
          promptCacheCapabilities: openAiPromptCacheCapabilities,
          signal: streamOptions?.signal,
        }
      )) {
        yield event;
      }
    },
  };
};
