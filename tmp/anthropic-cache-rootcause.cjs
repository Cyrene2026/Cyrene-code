const fs = require("fs");

const requestUrl = process.env.CACHE_PROBE_URL;
const apiKey = process.env.CACHE_PROBE_API_KEY;
const bodyPath = process.env.CACHE_PROBE_BODY;

if (!requestUrl || !apiKey || !bodyPath) {
  throw new Error("CACHE_PROBE_URL, CACHE_PROBE_API_KEY, CACHE_PROBE_BODY are required");
}

const snapshot = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
const baseBody = snapshot.requestBody;

const clone = value => JSON.parse(JSON.stringify(value));

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
        // ignore malformed events
      }
    }
  }
  return usage;
};

const send = async body => {
  const payload = JSON.stringify(body);
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: payload,
  });
  const text = await response.text();
  const usageEvents = parseSseUsage(text);
  const last = usageEvents.at(-1)?.usage ?? {};
  return {
    status: response.status,
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    usage: {
      input_tokens: last.input_tokens ?? 0,
      output_tokens: last.output_tokens ?? 0,
      cache_read_input_tokens: last.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: last.cache_creation_input_tokens ?? 0,
      cache_creation: last.cache_creation ?? null,
    },
  };
};

const runPair = async (name, bodyA, bodyB) => ({
  name,
  first: await send(bodyA),
  second: await send(bodyB),
});

const normalizeTopLevelOrder = body => ({
  model: body.model,
  stream: body.stream,
  max_tokens: body.max_tokens,
  temperature: body.temperature,
  system: body.system,
  tools: body.tools,
  tool_choice: body.tool_choice,
  messages: body.messages,
});

const removeToolCacheControl = body => {
  const next = clone(body);
  next.tools = (next.tools || []).map(tool => {
    const copy = { ...tool };
    delete copy.cache_control;
    return copy;
  });
  return next;
};

const removeSystemCacheControl = body => {
  const next = clone(body);
  next.system = (next.system || []).map(block => {
    const copy = { ...block };
    delete copy.cache_control;
    return copy;
  });
  return next;
};

const shortMessage = (body, text) => {
  const next = clone(body);
  next.messages = [
    {
      role: "user",
      content: [{ type: "text", text }],
    },
  ];
  return next;
};

(async () => {
  const orderedBase = normalizeTopLevelOrder(baseBody);
  const orderedNoToolCache = normalizeTopLevelOrder(removeToolCacheControl(baseBody));
  const orderedNoSystemCache = normalizeTopLevelOrder(
    removeSystemCacheControl(baseBody)
  );
  const orderedShortMessage = normalizeTopLevelOrder(
    shortMessage(baseBody, "cache probe short message")
  );
  const orderedShortMessageNoTool = normalizeTopLevelOrder(
    shortMessage(removeToolCacheControl(baseBody), "cache probe short message")
  );

  const results = [];
  results.push(await runPair("baseline_exact", orderedBase, orderedBase));
  results.push(
    await runPair(
      "baseline_no_tool_cache",
      orderedNoToolCache,
      orderedNoToolCache
    )
  );
  results.push(
    await runPair(
      "baseline_no_system_cache",
      orderedNoSystemCache,
      orderedNoSystemCache
    )
  );
  results.push(
    await runPair(
      "short_message",
      orderedShortMessage,
      orderedShortMessage
    )
  );
  results.push(
    await runPair(
      "short_message_no_tool_cache",
      orderedShortMessageNoTool,
      orderedShortMessageNoTool
    )
  );

  process.stdout.write(
    JSON.stringify(
      {
        requestUrl,
        bodyPath,
        model: baseBody.model,
        results,
      },
      null,
      2
    )
  );
})();
