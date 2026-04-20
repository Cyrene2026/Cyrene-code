const fs = require("fs");

const requestUrl = process.env.CACHE_PROBE_URL;
const apiKey = process.env.CACHE_PROBE_API_KEY;
const bodyPath = process.env.CACHE_PROBE_BODY;

if (!requestUrl || !apiKey || !bodyPath) {
  throw new Error("CACHE_PROBE_URL, CACHE_PROBE_API_KEY, CACHE_PROBE_BODY are required");
}

const requestBody = JSON.parse(fs.readFileSync(bodyPath, "utf8")).requestBody;

const headersToObject = headers => {
  const result = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const parseSse = text => {
  const chunks = text.split(/\n\n+/).filter(Boolean);
  const events = [];
  for (const raw of chunks) {
    const lines = raw.split("\n");
    const eventName = lines
      .filter(line => line.startsWith("event: "))
      .map(line => line.slice("event: ".length))
      .at(-1);
    const dataLines = lines
      .filter(line => line.startsWith("data: "))
      .map(line => line.slice("data: ".length));
    for (const data of dataLines) {
      try {
        const parsed = JSON.parse(data);
        events.push({
          event: eventName ?? "unknown",
          type: parsed?.type ?? null,
          keys: Object.keys(parsed ?? {}),
          hasMetadata:
            Object.prototype.hasOwnProperty.call(parsed ?? {}, "metadata") ||
            Object.prototype.hasOwnProperty.call(parsed?.message ?? {}, "metadata"),
          parsed,
        });
      } catch {
        events.push({
          event: eventName ?? "unknown",
          type: null,
          keys: [],
          hasMetadata: false,
          rawData: data,
        });
      }
    }
  }
  return events;
};

(async () => {
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  const raw = await response.text();
  const events = parseSse(raw);
  const hasMetadata = events.some(event => event.hasMetadata);
  const eventSummary = events.map(event => ({
    event: event.event,
    type: event.type,
    keys: event.keys,
    hasMetadata: event.hasMetadata,
  }));

  process.stdout.write(
    JSON.stringify(
      {
        status: response.status,
        headers: headersToObject(response.headers),
        eventCount: events.length,
        hasMetadata,
        eventSummary,
        rawPreview: raw.slice(0, 2000),
      },
      null,
      2
    )
  );
})();
