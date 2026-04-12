import { describe, expect, mock, test } from "bun:test";
import type { ExtensionManager } from "../src/core/extensions";
import type { McpRuntimeMutationResult } from "../src/core/mcp";
import type { SkillsRuntimeMutationResult } from "../src/core/skills";
import { handleExtensionsCommand } from "../src/application/chat/chatExtensionsCommandHandler";

const createExtensionManager = (): ExtensionManager => ({
  listSkills: () => [
    {
      id: "repo-map",
      label: "Repo Map",
      description: "Repo structure helper",
      prompt: "full prompt should not leak here",
      triggers: ["repo"],
      enabled: true,
      exposure: "scoped",
      tags: ["architecture"],
      source: "project",
      configPath: "/tmp/.cyrene/skills.yaml",
      matchTokens: ["repo"],
    },
  ],
  listMcpServers: () => [
    {
      id: "filesystem",
      label: "Filesystem",
      enabled: true,
      source: "built_in",
      health: "online",
      transport: "filesystem",
      aliases: ["file"],
      exposure: "full",
      tags: ["workspace"],
      hint: "Core workspace operations.",
      scope: "default",
      trusted: true,
      tools: [],
      matchTokens: ["filesystem", "workspace"],
    },
  ],
  resolveForQuery: (_query, options) => ({
    skills: [
      {
        item: {
          id: "repo-map",
          label: "Repo Map",
          description: "Repo structure helper",
          prompt: "full prompt should not leak here",
          triggers: ["repo"],
          enabled: true,
          exposure: "scoped",
          tags: ["architecture"],
          source: "project",
          configPath: "/tmp/.cyrene/skills.yaml",
          matchTokens: ["repo"],
        },
        reason:
          options?.manualSkillIds?.includes("repo-map") ? "manual" : "trigger_match",
        score: 9,
      },
    ],
    mcpServers: [
      {
        item: {
          id: "filesystem",
          label: "Filesystem",
          enabled: true,
          source: "built_in",
          health: "online",
          transport: "filesystem",
          aliases: ["file"],
          exposure: "full",
          tags: ["workspace"],
          hint: "Core workspace operations.",
          scope: "default",
          trusted: true,
          tools: [],
          matchTokens: ["filesystem", "workspace"],
        },
        reason: "always_visible",
        score: 0,
      },
    ],
  }),
  describeRuntime: () => ({
    skillCount: 1,
    enabledSkillCount: 1,
    mcpServerCount: 1,
    enabledMcpServerCount: 1,
    exposureCounts: {
      hidden: 0,
      hinted: 0,
      scoped: 1,
      full: 1,
    },
  }),
});

describe("handleExtensionsCommand", () => {
  test("shows extensions runtime summary", async () => {
    const pushSystemMessage = mock((_text?: string) => {});

    const handled = await handleExtensionsCommand({
      query: "/extensions",
      extensionManager: createExtensionManager(),
      activeSessionId: null,
      getSessionSkillUseIds: () => [],
      pushSystemMessage,
      clearInput: () => {},
    });

    expect(handled).toBe(true);
    expect(pushSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining("Extensions runtime"),
      expect.any(Object)
    );
  });

  test("resolves extensions using current session manual skill ids", async () => {
    const messages: string[] = [];
    const pushSystemMessage = mock((text?: string) => {
      if (typeof text === "string") {
        messages.push(text);
      }
    });

    const handled = await handleExtensionsCommand({
      query: "/extensions resolve explain repo layout",
      extensionManager: createExtensionManager(),
      activeSessionId: "session-1",
      getSessionSkillUseIds: sessionId =>
        sessionId === "session-1" ? ["repo-map"] : [],
      pushSystemMessage,
      clearInput: () => {},
    });

    expect(handled).toBe(true);
    const message = messages[0] ?? "";
    expect(message).toContain("Resolved extensions");
    expect(message).toContain("reason manual");
    expect(message).toContain("scope project");
    expect(message).toContain("trust trusted");
  });

  test("mutates exposure through unified extensions command", async () => {
    const messages: string[] = [];
    const pushSystemMessage = mock((text?: string) => {
      if (typeof text === "string") {
        messages.push(text);
      }
    });
    const skillsService = {
      setSkillExposure: mock(
        async (_id: string, exposure: string): Promise<SkillsRuntimeMutationResult> => ({
          ok: true,
          message: `Skill exposure updated\nexposure: ${exposure}`,
        })
      ),
    };

    const handled = await handleExtensionsCommand({
      query: "/extensions exposure hinted skill:repo-map",
      extensionManager: createExtensionManager(),
      skillsService: skillsService as any,
      mcpService: undefined,
      activeSessionId: null,
      getSessionSkillUseIds: () => [],
      pushSystemMessage,
      clearInput: () => {},
    });

    expect(handled).toBe(true);
    expect(skillsService.setSkillExposure).toHaveBeenCalledWith("repo-map", "hinted");
    expect(messages[0]).toContain("exposure: hinted");
  });

  test("mutates mcp enable state through unified extensions command", async () => {
    const messages: string[] = [];
    const pushSystemMessage = mock((text?: string) => {
      if (typeof text === "string") {
        messages.push(text);
      }
    });
    const mcpService = {
      setServerEnabled: mock(
        async (_id: string, enabled: boolean): Promise<McpRuntimeMutationResult> => ({
          ok: true,
          message: `MCP server ${enabled ? "enabled" : "disabled"}`,
        })
      ),
    };

    const handled = await handleExtensionsCommand({
      query: "/extensions disable mcp:filesystem",
      extensionManager: createExtensionManager(),
      skillsService: undefined,
      mcpService: mcpService as any,
      activeSessionId: null,
      getSessionSkillUseIds: () => [],
      pushSystemMessage,
      clearInput: () => {},
    });

    expect(handled).toBe(true);
    expect(mcpService.setServerEnabled).toHaveBeenCalledWith("filesystem", false);
    expect(messages[0]).toContain("disabled");
  });
});
