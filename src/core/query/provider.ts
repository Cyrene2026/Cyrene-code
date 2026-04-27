export type ProviderProfile = "openai" | "gemini" | "anthropic" | "custom";
export type ManualProviderProfile = Exclude<ProviderProfile, "custom">;
export type ProviderFamily = ManualProviderProfile | "glm";

export const PROVIDER_ALIASES = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  anthropic: "https://api.anthropic.com",
  claude: "https://api.anthropic.com",
} as const;

export type ProviderAlias = keyof typeof PROVIDER_ALIASES;

export const PROVIDER_PROFILES = [
  "openai",
  "gemini",
  "anthropic",
  "custom",
] as const satisfies readonly ProviderProfile[];

export const MANUAL_PROVIDER_PROFILES = [
  "openai",
  "gemini",
  "anthropic",
] as const satisfies readonly ManualProviderProfile[];

export type TransportFormat =
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generate_content";

export const TRANSPORT_FORMATS = [
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
  "gemini_generate_content",
] as const satisfies readonly TransportFormat[];

export type ProviderType =
  | "openai-compatible"
  | "openai-responses"
  | "gemini"
  | "anthropic";

export const PROVIDER_TYPES = [
  "openai-compatible",
  "openai-responses",
  "gemini",
  "anthropic",
] as const satisfies readonly ProviderType[];

export const PROVIDER_ENDPOINT_KINDS = [
  "responses",
  "chat_completions",
  "models",
  "anthropic_messages",
  "gemini_generate_content",
] as const;

export type ProviderEndpointKind =
  (typeof PROVIDER_ENDPOINT_KINDS)[number];

export type ParsedProvider = {
  providerBaseUrl: string;
  family: ProviderFamily;
};

export const isProviderProfile = (value: string): value is ProviderProfile =>
  (PROVIDER_PROFILES as readonly string[]).includes(value);

export const isManualProviderProfile = (
  value: string
): value is ManualProviderProfile =>
  (MANUAL_PROVIDER_PROFILES as readonly string[]).includes(value);

export const isTransportFormat = (value: string): value is TransportFormat =>
  (TRANSPORT_FORMATS as readonly string[]).includes(value);

export const isProviderType = (value: string): value is ProviderType =>
  (PROVIDER_TYPES as readonly string[]).includes(value);

export const isProviderEndpointKind = (
  value: string
): value is ProviderEndpointKind =>
  (PROVIDER_ENDPOINT_KINDS as readonly string[]).includes(value);

export const trimProviderInput = (value: string) => value.trim();

export const repairCommonSchemeTypos = (value: string) => {
  const trimmed = value.trim();
  if (/^https\/\//i.test(trimmed)) {
    return `https://${trimmed.slice("https//".length)}`;
  }
  if (/^http\/\//i.test(trimmed)) {
    return `http://${trimmed.slice("http//".length)}`;
  }
  return trimmed;
};

export const resolveProviderAlias = (value: string) => {
  const normalizedKey = trimProviderInput(value).toLowerCase() as ProviderAlias;
  return PROVIDER_ALIASES[normalizedKey];
};

export const inferProviderFamilyFromHost = (host: string): ProviderFamily => {
  const normalizedHost = host.toLowerCase();
  return normalizedHost.includes("anthropic.com")
    ? "anthropic"
    : normalizedHost.includes("generativelanguage.googleapis.com")
      ? "gemini"
      : normalizedHost.includes("bigmodel.cn") ||
          normalizedHost.includes("zhipuai.cn")
        ? "glm"
        : "openai";
};

export const inferProviderFamilyFromBaseUrl = (
  providerBaseUrl: string
): ProviderFamily => {
  const normalized = normalizeProviderBaseUrl(providerBaseUrl);
  return inferProviderFamilyFromHost(new URL(normalized).hostname);
};

export const parseProviderBaseUrl = (provider: string): ParsedProvider => {
  const trimmed = repairCommonSchemeTypos(trimProviderInput(provider));
  if (!trimmed) {
    throw new Error("Provider cannot be empty.");
  }

  const aliased = resolveProviderAlias(trimmed);
  const candidate = aliased ?? trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    if (aliased) {
      parsed = new URL(aliased);
    } else {
      throw new Error(
        "Provider must be a valid URL or one of: openai, gemini, anthropic."
      );
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https.");
  }

  return {
    providerBaseUrl: parsed.toString().replace(/\/+$/, ""),
    family: inferProviderFamilyFromHost(parsed.hostname),
  };
};

export const normalizeProviderBaseUrl = (url: string) =>
  parseProviderBaseUrl(url).providerBaseUrl;

export const safeNormalizeProviderBaseUrl = (baseUrl: string | undefined) => {
  if (!baseUrl) {
    return undefined;
  }
  try {
    return normalizeProviderBaseUrl(baseUrl);
  } catch {
    return undefined;
  }
};

export const resolveProviderFamily = (providerBaseUrl: string): ProviderFamily =>
  parseProviderBaseUrl(providerBaseUrl).family;

export const resolveProviderTypeFamily = (
  type: ProviderType
): Extract<ProviderFamily, "openai" | "gemini" | "anthropic"> =>
  type === "gemini"
    ? "gemini"
    : type === "anthropic"
      ? "anthropic"
      : "openai";

export const resolveProviderTypeFormat = (
  type: ProviderType,
  provider?: string
): TransportFormat => {
  if (type === "anthropic") {
    return "anthropic_messages";
  }
  if (type === "gemini") {
    return provider?.includes("/openai")
      ? "openai_chat"
      : "gemini_generate_content";
  }
  return type === "openai-responses"
    ? "openai_responses"
    : "openai_chat";
};

export const inferProviderType = (options: {
  family: ProviderFamily;
  format: TransportFormat;
}): ProviderType | null => {
  if (options.family === "anthropic") {
    return "anthropic";
  }
  if (options.family === "gemini") {
    return "gemini";
  }
  if (options.family === "glm") {
    return null;
  }
  return options.format === "openai_responses"
    ? "openai-responses"
    : "openai-compatible";
};

export const supportsImageAttachmentsForFormat = (format: TransportFormat) =>
  format === "openai_responses" ||
  format === "anthropic_messages" ||
  format === "gemini_generate_content";
