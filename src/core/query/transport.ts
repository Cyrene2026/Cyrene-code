export type QueryTransport = {
  requestStreamUrl: (query: string) => Promise<string>;
  stream: (streamUrl: string) => AsyncGenerator<string>;
};

