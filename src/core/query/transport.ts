export type QueryTransport = {
  getModel: () => string;
  setModel: (model: string) => void;
  requestStreamUrl: (query: string) => Promise<string>;
  stream: (streamUrl: string) => AsyncGenerator<string>;
};
