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

export type QueryTransport = {
  getModel: () => string;
  getProvider: () => string;
  setModel: (model: string) => Promise<ModelSetResult>;
  listModels: () => Promise<string[]>;
  listProviders: () => Promise<string[]>;
  setProvider: (provider: string) => Promise<ProviderSetResult>;
  refreshModels: () => Promise<ModelRefreshResult>;
  requestStreamUrl: (query: string) => Promise<string>;
  stream: (streamUrl: string) => AsyncGenerator<string>;
};
