export type ModelRefreshResult = {
  ok: boolean;
  message: string;
  models?: string[];
};

export type ModelSetResult = {
  ok: boolean;
  message: string;
};

export type ProviderSetResult = {
  ok: boolean;
  message: string;
  providers?: string[];
  currentProvider?: string;
  models?: string[];
};

export type ProviderRuntimeInfo = {
  provider: string;
  vendor: "openai" | "gemini" | "anthropic" | "custom" | "local" | "none";
  keySource: string;
  type?: ProviderType;
  format?: TransportFormat;
};

export type QueryAttachment = {
  id: string;
  kind: "image";
  path: string;
  name: string;
  mimeType: string;
};

export type QueryInput = {
  text: string;
  attachments?: QueryAttachment[];
};

export const normalizeQueryInput = (
  input: string | QueryInput
): { text: string; attachments: QueryAttachment[] } => {
  if (typeof input === "string") {
    return {
      text: input,
      attachments: [],
    };
  }
  return {
    text: input.text,
    attachments: [...(input.attachments ?? [])],
  };
};

export type ProviderProfile = "openai" | "gemini" | "anthropic" | "custom";
export type TransportFormat =
  | "openai_chat"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generate_content";
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
] as const;
export const isProviderType = (value: string): value is ProviderType =>
  (PROVIDER_TYPES as readonly string[]).includes(value);
export const resolveProviderTypeFamily = (
  type: ProviderType
): "openai" | "gemini" | "anthropic" =>
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
  family: "openai" | "gemini" | "anthropic" | "glm";
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

export type ProviderProfileOverrideMap = Record<
  string,
  Exclude<ProviderProfile, "custom">
>;
export type ProviderModelCatalogMode = "api" | "manual";
export type ProviderModelCatalogModeMap = Record<string, ProviderModelCatalogMode>;

export type ProviderNameOverrideMap = Record<string, string>;
export type ProviderTypeOverrideMap = Record<string, ProviderType>;
export type ProviderFormatOverrideMap = Record<string, TransportFormat>;
export const PROVIDER_ENDPOINT_KINDS = [
  "responses",
  "chat_completions",
  "models",
  "anthropic_messages",
  "gemini_generate_content",
] as const;
export type ProviderEndpointKind =
  (typeof PROVIDER_ENDPOINT_KINDS)[number];

export type ProviderEndpointOverrideEntry = Partial<
  Record<ProviderEndpointKind, string>
>;
export type ProviderEndpointOverrideMap = Record<
  string,
  ProviderEndpointOverrideEntry
>;

export type ProviderProfileSetResult = {
  ok: boolean;
  message: string;
  provider?: string;
  profile?: ProviderProfile;
};

export type ProviderNameSetResult = {
  ok: boolean;
  message: string;
  provider?: string;
  name?: string;
};

export type ProviderTypeSetResult = {
  ok: boolean;
  message: string;
  provider?: string;
  type?: ProviderType;
};

export type ProviderFormatSetResult = {
  ok: boolean;
  message: string;
  provider?: string;
  format?: TransportFormat;
};

export type ProviderEndpointSetResult = {
  ok: boolean;
  message: string;
  provider?: string;
  kind?: ProviderEndpointKind;
  endpoint?: string;
};

export type QueryTransportStreamOptions = {
  signal?: AbortSignal;
};

export type QueryTransport = {
  getModel: () => string;
  getProvider: () => string;
  describeProvider?: (provider?: string) => ProviderRuntimeInfo;
  setProviderProfile?: (
    provider: string,
    profile: ProviderProfile
  ) => Promise<ProviderProfileSetResult>;
  getProviderProfile?: (provider?: string) => ProviderProfile | null;
  listProviderProfiles?: () => ProviderProfileOverrideMap;
  setProviderType?: (
    provider: string,
    type: ProviderType | null
  ) => Promise<ProviderTypeSetResult>;
  getProviderType?: (provider?: string) => ProviderType | null;
  listProviderTypes?: () => ProviderTypeOverrideMap;
  setProviderFormat?: (
    provider: string,
    format: TransportFormat | null
  ) => Promise<ProviderFormatSetResult>;
  getProviderFormat?: (provider?: string) => TransportFormat | null;
  listProviderFormats?: () => ProviderFormatOverrideMap;
  setProviderEndpoint?: (
    provider: string,
    kind: ProviderEndpointKind,
    endpoint: string | null
  ) => Promise<ProviderEndpointSetResult>;
  getProviderEndpoint?: (
    provider: string | undefined,
    kind: ProviderEndpointKind
  ) => string | null;
  listProviderEndpoints?: () => ProviderEndpointOverrideMap;
  setProviderName?: (
    provider: string,
    name: string | null
  ) => Promise<ProviderNameSetResult>;
  getProviderName?: (provider?: string) => string | null;
  listProviderNames?: () => ProviderNameOverrideMap;
  setModel: (model: string) => Promise<ModelSetResult>;
  listModels: () => Promise<string[]>;
  listProviders: () => Promise<string[]>;
  setProvider: (provider: string) => Promise<ProviderSetResult>;
  refreshModels: () => Promise<ModelRefreshResult>;
  requestStreamUrl: (query: string | QueryInput) => Promise<string>;
  stream: (
    streamUrl: string,
    options?: QueryTransportStreamOptions
  ) => AsyncGenerator<string>;
};
