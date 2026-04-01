import axios from "axios";
import { z } from "zod";
import type { QueryTransport } from "../../core/query/transport";

const envSchema = z.object({
  QUERY_BASE_URL: z.string().url().optional(),
});

const responseSchema = z.object({
  streamUrl: z.string().url(),
});

const parseSseEventData = (rawEvent: string): string | null => {
  const lines = rawEvent.split("\n");
  const dataLines = lines
    .filter(line => line.startsWith("data:"))
    .map(line => line.replace(/^data:\s?/, ""));

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join("\n");
};

async function* streamSse(streamUrl: string): AsyncGenerator<string> {
  const response = await fetch(streamUrl, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Stream error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const data = parseSseEventData(rawEvent);
      if (data) {
        if (data === "[DONE]") {
          return;
        }

        yield data;
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    const data = parseSseEventData(buffer);
    if (data && data !== "[DONE]") {
      yield data;
    }
  }
}

export const createHttpQueryTransport = (): QueryTransport => {
  const env = envSchema.safeParse({
    QUERY_BASE_URL: process.env.QUERY_BASE_URL,
  });

  const baseURL = env.success
    ? env.data.QUERY_BASE_URL ?? "https://example.invalid"
    : "https://example.invalid";

  const client = axios.create({ baseURL });

  return {
    requestStreamUrl: async (query: string) => {
      const response = await client.post("/query", { query });
      return responseSchema.parse(response.data).streamUrl;
    },
    stream: (streamUrl: string) => streamSse(streamUrl),
  };
};
