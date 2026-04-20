const requestUrl = process.env.CACHE_PROBE_URL;
const apiKey = process.env.CACHE_PROBE_API_KEY;
const model = process.env.CACHE_PROBE_MODEL || "claude-sonnet-4-6";

if (!requestUrl || !apiKey) {
  throw new Error("CACHE_PROBE_URL and CACHE_PROBE_API_KEY are required");
}

const deepClone = value => JSON.parse(JSON.stringify(value));

const parseSseUsage = text => {
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
        const usageCandidate = parsed?.usage ?? parsed?.message?.usage ?? null;
        if (usageCandidate) {
          usage.push({
            type: parsed?.type ?? "unknown",
            usage: usageCandidate,
          });
        }
      } catch {
        // ignore malformed event line
      }
    }
  }
  return usage;
};

const send = async body => {
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
  const usageEvents = parseSseUsage(text);
  const lastUsage = usageEvents.at(-1)?.usage ?? {};
  return {
    status: response.status,
    usage: {
      input_tokens: lastUsage.input_tokens ?? 0,
      output_tokens: lastUsage.output_tokens ?? 0,
      cache_read_input_tokens: lastUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: lastUsage.cache_creation_input_tokens ?? 0,
      cache_creation: lastUsage.cache_creation ?? null,
    },
  };
};

const runPair = async (name, body1, body2) => {
  const first = await send(body1);
  const second = await send(body2);
  return {
    name,
    first,
    second,
  };
};

const baseSystem = [
  {
    type: "text",
    text:
      "SYSTEM PROMPT (highest priority):\n" +
      "You are a deterministic cache probe. Keep behavior stable.\n" +
      "Only answer with plain text.",
    cache_control: {
      type: "ephemeral",
    },
  },
];

const baseMessage = text => [
  {
    role: "user",
    content: [
      {
        type: "text",
        text,
      },
    ],
  },
];

const oneTool = [
  {
    name: "probe_tool",
    description: "A stable synthetic tool for cache probing.",
    input_schema: {
      type: "object",
      properties: {
        input: {
          type: "string",
        },
      },
      required: ["input"],
    },
    cache_control: {
      type: "ephemeral",
    },
  },
];

const buildBody = options => {
  const body = {
    model,
    stream: true,
    max_tokens: 128,
    temperature: 0.2,
    system: deepClone(baseSystem),
    messages: baseMessage(options.messageText),
  };
  if (options.tools) {
    body.tools = deepClone(oneTool);
    body.tool_choice = { type: "auto" };
  }
  return body;
};

(async () => {
  const simpleA = buildBody({ messageText: "hello", tools: false });
  const simpleB = buildBody({ messageText: "hello", tools: false });
  const simpleChanged = buildBody({ messageText: "hello changed suffix", tools: false });

  const withToolsA = buildBody({ messageText: "hello", tools: true });
  const withToolsB = buildBody({ messageText: "hello", tools: true });
  const withToolsChanged = buildBody({
    messageText: "hello changed suffix",
    tools: true,
  });

  const results = [];
  results.push(await runPair("simple_same", simpleA, simpleB));
  results.push(await runPair("simple_suffix_changed", simpleA, simpleChanged));
  results.push(await runPair("tools_same", withToolsA, withToolsB));
  results.push(
    await runPair("tools_suffix_changed", withToolsA, withToolsChanged)
  );

  process.stdout.write(
    JSON.stringify(
      {
        requestUrl,
        model,
        results,
      },
      null,
      2
    )
  );
})();
