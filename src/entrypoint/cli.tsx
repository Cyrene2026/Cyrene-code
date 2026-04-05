import React from "react";
import { render } from "ink";
import { ChatCliApp } from "../frontend/components/ChatCliApp";
import { loadCyreneConfig } from "../infra/config/loadCyreneConfig";
import { loadPromptPolicy } from "../infra/config/loadPromptPolicy";
import { configureAppRootFromArgs, getCyreneConfigDir } from "../infra/config/appRoot";
import { createFileSessionStore } from "../infra/session/createFileSessionStore";
import { FileMcpService } from "../core/tools/mcp/fileMcpService";
import { loadRuleConfig } from "../core/tools/mcp/loadRuleConfig";
import { createAuthRuntime } from "../infra/auth/authRuntime";
import { join } from "node:path";

const appRoot = configureAppRootFromArgs();
const cyreneConfig = await loadCyreneConfig(appRoot);
const authRuntime = createAuthRuntime({
  appRoot,
  requestTemperature: cyreneConfig.requestTemperature,
});
const initialAuthStatus = await authRuntime.getStatus();
const transport = await authRuntime.buildTransport();
const sessionStore = createFileSessionStore(join(getCyreneConfigDir(appRoot), "session"));
const promptPolicy = await loadPromptPolicy(cyreneConfig, appRoot);
const ruleConfig = await loadRuleConfig(appRoot);
const mcpService = new FileMcpService(ruleConfig);

render(
  <ChatCliApp
    transport={transport}
    initialAuthStatus={initialAuthStatus}
    authRuntime={authRuntime}
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
