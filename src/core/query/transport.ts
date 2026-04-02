export type ModelRefreshResult = {
  ok: boolean;
  message: string;
  models?: string[];
};

export type ModelSetResult = {
  ok: boolean;
  message: string;
};

export type QueryTransport = {
  getModel: () => string;
  setModel: (model: string) => Promise<ModelSetResult>;
  listModels: () => Promise<string[]>;
  refreshModels: () => Promise<ModelRefreshResult>;
  requestStreamUrl: (query: string) => Promise<string>;
  stream: (streamUrl: string) => AsyncGenerator<string>;
};
