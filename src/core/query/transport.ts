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
};

export type ProviderProfile = "openai" | "gemini" | "anthropic" | "custom";

export type ProviderProfileOverrideMap = Record<
  string,
  Exclude<ProviderProfile, "custom">
>;

export type ProviderNameOverrideMap = Record<string, string>;

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
  requestStreamUrl: (query: string) => Promise<string>;
  stream: (streamUrl: string) => AsyncGenerator<string>;
};
