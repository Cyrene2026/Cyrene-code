import type { McpRuntime, McpServerDescriptor } from "../mcp";
import type { SkillDefinition, SkillsRuntime } from "../skills";
import type { ExtensionExposureMode } from "./metadata";
import type {
  ExtensionManager,
  ExtensionManagerSummary,
  ExtensionQueryResolution,
  ManagedMcpServer,
  ManagedSkill,
  ResolvedExtension,
} from "./types";

const tokenize = (parts: Array<string | undefined>) =>
  Array.from(
    new Set(
      parts
        .flatMap(part => (part ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff._-]+/))
        .map(token => token.trim())
        .filter(token => token.length >= 2)
    )
  );

const includesToken = (queryLower: string, token: string) =>
  token.length > 0 && queryLower.includes(token);

const getExplicitSkillMentions = (query: string) => {
  const mentions: string[] = [];
  const pattern = /(?:^|\s)\$([a-z0-9._-]+)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(query)) !== null) {
    const id = (match[1] ?? "").trim().toLowerCase();
    if (id && !mentions.includes(id)) {
      mentions.push(id);
    }
  }
  return mentions;
};

const scoreByTokens = (queryLower: string, tokens: string[]) =>
  tokens.reduce((score, token) => (includesToken(queryLower, token) ? Math.max(score, token.length) : score), 0);

const canAutoSelectSkill = (exposure: ExtensionExposureMode) =>
  exposure === "scoped" || exposure === "full";

const canMentionSelectSkill = (exposure: ExtensionExposureMode) =>
  exposure !== "hidden";

const canSurfaceServer = (exposure: ExtensionExposureMode) => exposure !== "hidden";

const isAlwaysVisibleServer = (exposure: ExtensionExposureMode) => exposure === "full";

const toManagedSkill = (skill: SkillDefinition): ManagedSkill => ({
  ...skill,
  triggers: [...skill.triggers],
  tags: [...skill.tags],
  matchTokens: tokenize([skill.id, skill.label, skill.description, ...skill.triggers, ...skill.tags]),
});

const toManagedMcpServer = (server: McpServerDescriptor): ManagedMcpServer => ({
  ...server,
  aliases: [...(server.aliases ?? [])],
  tags: [...server.tags],
  tools: server.tools.map(tool => ({
    ...tool,
    capabilities: [...tool.capabilities],
    tags: [...tool.tags],
  })),
  matchTokens: tokenize([
    server.id,
    server.label,
    server.hint,
    ...(server.aliases ?? []),
    ...server.tags,
    ...server.tools.flatMap(tool => [tool.name, tool.label, tool.description, ...tool.tags]),
  ]),
});

class DefaultExtensionManager implements ExtensionManager {
  constructor(
    private readonly mcpRuntime: McpRuntime,
    private readonly skillsRuntime: SkillsRuntime
  ) {}

  listSkills() {
    return this.skillsRuntime.listSkills().map(skill => toManagedSkill(skill));
  }

  listMcpServers() {
    return this.mcpRuntime.listServers().map(server => toManagedMcpServer(server));
  }

  resolveForQuery(
    query: string,
    options?: { manualSkillIds?: string[] }
  ): ExtensionQueryResolution {
    const normalized = query.trim();
    if (!normalized) {
      return {
        skills: [],
        mcpServers: this.listMcpServers()
          .filter(server => server.enabled && isAlwaysVisibleServer(server.exposure))
          .map(server => ({
            item: server,
            reason: "always_visible",
            score: 0,
          })),
      };
    }

    const queryLower = normalized.toLowerCase();
    const manualSkillIds = new Set(
      (options?.manualSkillIds ?? []).map(item => item.trim().toLowerCase()).filter(Boolean)
    );
    const explicitMentions = new Set(getExplicitSkillMentions(normalized));

    const skills = this.listSkills()
      .filter(skill => skill.enabled)
      .map<ResolvedExtension<ManagedSkill> | null>(skill => {
        if (manualSkillIds.has(skill.id.toLowerCase())) {
          return { item: skill, reason: "manual", score: Number.MAX_SAFE_INTEGER };
        }
        if (explicitMentions.has(skill.id.toLowerCase()) && canMentionSelectSkill(skill.exposure)) {
          return { item: skill, reason: "explicit_mention", score: 10_000 };
        }
        const triggerScore = canAutoSelectSkill(skill.exposure)
          ? scoreByTokens(queryLower, [...skill.triggers.map(item => item.toLowerCase()), ...skill.tags])
          : 0;
        return triggerScore > 0
          ? { item: skill, reason: "trigger_match", score: triggerScore }
          : null;
      })
      .filter((item): item is ResolvedExtension<ManagedSkill> => Boolean(item))
      .sort((left, right) =>
        left.score === right.score
          ? left.item.id.localeCompare(right.item.id)
          : right.score - left.score
      )
      .slice(0, 4);

    const mcpServers = this.listMcpServers()
      .filter(server => server.enabled && canSurfaceServer(server.exposure))
      .map<ResolvedExtension<ManagedMcpServer> | null>(server => {
        if (isAlwaysVisibleServer(server.exposure)) {
          return { item: server, reason: "always_visible", score: 0 };
        }
        const score = scoreByTokens(queryLower, server.matchTokens);
        return score > 0 ? { item: server, reason: "server_match", score } : null;
      })
      .filter((item): item is ResolvedExtension<ManagedMcpServer> => Boolean(item))
      .sort((left, right) =>
        left.score === right.score
          ? left.item.id.localeCompare(right.item.id)
          : right.score - left.score
      );

    return {
      skills,
      mcpServers,
    };
  }

  describeRuntime(): ExtensionManagerSummary {
    const skills = this.skillsRuntime.listSkills();
    const servers = this.mcpRuntime.listServers();
    const exposureCounts: Record<ExtensionExposureMode, number> = {
      hidden: 0,
      hinted: 0,
      scoped: 0,
      full: 0,
    };
    for (const skill of skills) {
      exposureCounts[skill.exposure] += 1;
    }
    for (const server of servers) {
      exposureCounts[server.exposure] += 1;
    }
    return {
      skillCount: skills.length,
      enabledSkillCount: skills.filter(skill => skill.enabled).length,
      mcpServerCount: servers.length,
      enabledMcpServerCount: servers.filter(server => server.enabled).length,
      exposureCounts,
    };
  }
}

export const createExtensionManager = (
  mcpRuntime: McpRuntime,
  skillsRuntime: SkillsRuntime
): ExtensionManager => new DefaultExtensionManager(mcpRuntime, skillsRuntime);

export const buildManagedMcpServer = (server: McpServerDescriptor) => toManagedMcpServer(server);
export const buildManagedSkill = (skill: SkillDefinition) => toManagedSkill(skill);
