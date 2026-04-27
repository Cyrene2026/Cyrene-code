import type {
  ProviderEndpointKind,
  ProviderProfile,
  ProviderType,
  TransportFormat,
} from "./provider";

export type ModelRefreshResult = {
  ok: boolean;
  message: string;
  models?: string[];
};

export {
  MANUAL_PROVIDER_PROFILES,
  PROVIDER_ALIASES,
  PROVIDER_ENDPOINT_KINDS,
  PROVIDER_PROFILES,
  PROVIDER_TYPES,
  TRANSPORT_FORMATS,
  inferProviderFamilyFromBaseUrl,
  inferProviderFamilyFromHost,
  inferProviderType,
  isManualProviderProfile,
  isProviderEndpointKind,
  isProviderProfile,
  isProviderType,
  isTransportFormat,
  normalizeProviderBaseUrl,
  parseProviderBaseUrl,
  repairCommonSchemeTypos,
  resolveProviderAlias,
  resolveProviderFamily,
  resolveProviderTypeFamily,
  resolveProviderTypeFormat,
  safeNormalizeProviderBaseUrl,
  supportsImageAttachmentsForFormat,
  trimProviderInput,
  type ManualProviderProfile,
  type ParsedProvider,
  type ProviderAlias,
  type ProviderEndpointKind,
  type ProviderFamily,
  type ProviderProfile,
  type ProviderType,
  type TransportFormat,
} from "./provider";

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

export type ProviderProfileOverrideMap = Record<
  string,
  Exclude<ProviderProfile, "custom">
>;
export type ProviderModelCatalogMode = "api" | "manual";
export type ProviderModelCatalogModeMap = Record<string, ProviderModelCatalogMode>;

export type ProviderNameOverrideMap = Record<string, string>;
export type ProviderTypeOverrideMap = Record<string, ProviderType>;
export type ProviderFormatOverrideMap = Record<string, TransportFormat>;

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
