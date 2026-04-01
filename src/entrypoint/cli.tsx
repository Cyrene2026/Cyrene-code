import React from "react";
import { render } from "ink";
import { ChatCliApp } from "../frontend/components/ChatCliApp";
import { createHttpQueryTransport } from "../infra/http/createHttpQueryTransport";
import { loadCyreneConfig } from "../infra/config/loadCyreneConfig";
import { loadPromptPolicy } from "../infra/config/loadPromptPolicy";
import { createLocalCoreTransport } from "../infra/local/createLocalCoreTransport";
import { createFileSessionStore } from "../infra/session/createFileSessionStore";

const transport =
  process.env.CYRENE_BASE_URL && process.env.CYRENE_API_KEY
    ? createHttpQueryTransport()
    : createLocalCoreTransport();
const sessionStore = createFileSessionStore();
const cyreneConfig = await loadCyreneConfig();
const promptPolicy = await loadPromptPolicy(cyreneConfig);

render(
  <ChatCliApp
    transport={transport}
    sessionStore={sessionStore}
    defaultSystemPrompt={promptPolicy.systemPrompt}
    projectPrompt={promptPolicy.projectPrompt}
    pinMaxCount={cyreneConfig.pinMaxCount}
  />
);
