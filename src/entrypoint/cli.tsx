import React from "react";
import { render } from "ink";
import { ChatCliApp } from "../frontend/components/ChatCliApp";
import { createHttpQueryTransport } from "../infra/http/createHttpQueryTransport";
import { loadCyreneConfig } from "../infra/config/loadCyreneConfig";
import { loadPromptPolicy } from "../infra/config/loadPromptPolicy";
import { createLocalCoreTransport } from "../infra/local/createLocalCoreTransport";
import { createFileSessionStore } from "../infra/session/createFileSessionStore";
import { FileMcpService } from "../core/tools/mcp/fileMcpService";
import { loadRuleConfig } from "../core/tools/mcp/loadRuleConfig";

const transport =
  process.env.CYRENE_BASE_URL && process.env.CYRENE_API_KEY
    ? createHttpQueryTransport()
    : createLocalCoreTransport();
const sessionStore = createFileSessionStore();
const cyreneConfig = await loadCyreneConfig();
const promptPolicy = await loadPromptPolicy(cyreneConfig);
const ruleConfig = await loadRuleConfig();
const mcpService = new FileMcpService(ruleConfig);

render(
  <ChatCliApp
    transport={transport}
    sessionStore={sessionStore}
    defaultSystemPrompt={promptPolicy.systemPrompt}
    projectPrompt={promptPolicy.projectPrompt}
    pinMaxCount={cyreneConfig.pinMaxCount}
    mcpService={mcpService}
  />
);
