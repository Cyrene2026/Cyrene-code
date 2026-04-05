import React from "react";
import { render } from "ink";
import { ChatCliApp } from "../frontend/components/ChatCliApp";
import { createHttpQueryTransport } from "../infra/http/createHttpQueryTransport";
import { loadCyreneConfig } from "../infra/config/loadCyreneConfig";
import { loadPromptPolicy } from "../infra/config/loadPromptPolicy";
import { configureAppRootFromArgs, getCyreneConfigDir } from "../infra/config/appRoot";
import { createLocalCoreTransport } from "../infra/local/createLocalCoreTransport";
import { createFileSessionStore } from "../infra/session/createFileSessionStore";
import { FileMcpService } from "../core/tools/mcp/fileMcpService";
import { loadRuleConfig } from "../core/tools/mcp/loadRuleConfig";
import { join } from "node:path";

const transport =
  process.env.CYRENE_BASE_URL && process.env.CYRENE_API_KEY
    ? createHttpQueryTransport()
    : createLocalCoreTransport();
const appRoot = configureAppRootFromArgs();
const sessionStore = createFileSessionStore(join(getCyreneConfigDir(appRoot), "session"));
const cyreneConfig = await loadCyreneConfig(appRoot);
const promptPolicy = await loadPromptPolicy(cyreneConfig, appRoot);
const ruleConfig = await loadRuleConfig(appRoot);
const mcpService = new FileMcpService(ruleConfig);

render(
  <ChatCliApp
    transport={transport}
    sessionStore={sessionStore}
    defaultSystemPrompt={promptPolicy.systemPrompt}
    projectPrompt={promptPolicy.projectPrompt}
    pinMaxCount={cyreneConfig.pinMaxCount}
    autoSummaryRefresh={cyreneConfig.autoSummaryRefresh}
    queryMaxToolSteps={cyreneConfig.queryMaxToolSteps}
    mcpService={mcpService}
    appRoot={appRoot}
  />,
  {
    exitOnCtrlC: false,
  }
);
