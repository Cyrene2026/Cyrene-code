const fs = require("fs");

const requestUrl = process.env.CACHE_PROBE_URL;
const apiKey = process.env.CACHE_PROBE_API_KEY;
const bodyPath = process.env.CACHE_PROBE_BODY;

if (!requestUrl || !apiKey || !bodyPath) {
  throw new Error("CACHE_PROBE_URL, CACHE_PROBE_API_KEY, CACHE_PROBE_BODY are required");
}

const snapshot = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
const baseBody = snapshot.requestBody;

const readSseUsage = async body => {
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const events = text.split(/\n\n+/).filter(Boolean);
  const usage = [];
  for (const rawEvent of events) {
    const dataLines = rawEvent
      .split("\n")
      .filter(line => line.startsWith("data: "))
      .map(line => line.slice(6));
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line);
        const usageCandidate =
          parsed?.usage ?? parsed?.message?.usage ?? null;
        if (usageCandidate) {
          usage.push({
            type: parsed?.type ?? "unknown",
            usage: usageCandidate,
          });
        }
      } catch {}
    }
  }

  return {
    status: response.status,
    usage,
  };
};

const clone = value => JSON.parse(JSON.stringify(value));

const mutateMessageSuffix = (body, suffix) => {
  const next = clone(body);
  const content = next.messages?.[0]?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("expected messages[0].content");
  }
  const lastTextIndex = [...content]
    .map((block, index) => ({ block, index }))
    .reverse()
    .find(entry => entry.block?.type === "text")?.index;
  if (typeof lastTextIndex !== "number") {
    throw new Error("expected at least one text block");
  }
  content[lastTextIndex].text = `${content[lastTextIndex].text}\n${suffix}`;
  return next;
};

const summarize = result => {
  const last = result.usage.at(-1)?.usage ?? {};
  return {
    status: result.status,
    input_tokens: last.input_tokens ?? 0,
    cache_read_input_tokens: last.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: last.cache_creation_input_tokens ?? 0,
    cache_creation: last.cache_creation ?? null,
    output_tokens: last.output_tokens ?? 0,
  };
};

(async () => {
  const exact1 = await readSseUsage(baseBody);
  const exact2 = await readSseUsage(baseBody);

  const variantA = mutateMessageSuffix(baseBody, "[probe variant A]");
  const variantB = mutateMessageSuffix(baseBody, "[probe variant B]");
  const suffix1 = await readSseUsage(variantA);
  const suffix2 = await readSseUsage(variantB);

  process.stdout.write(
    JSON.stringify(
      {
        requestUrl,
        bodyPath,
        exact_same: [summarize(exact1), summarize(exact2)],
        suffix_changed: [summarize(suffix1), summarize(suffix2)],
      },
      null,
      2
    )
  );
})();
