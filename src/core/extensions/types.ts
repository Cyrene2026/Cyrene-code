import type { McpServerDescriptor } from "../mcp";
import type { SkillDefinition } from "../skills";
import type { ExtensionExposureMode } from "./metadata";

export type ManagedMcpServer = McpServerDescriptor & {
  matchTokens: string[];
};

export type ManagedSkill = SkillDefinition & {
  matchTokens: string[];
};

export type ExtensionSelectionReason =
  | "manual"
  | "explicit_mention"
  | "trigger_match"
  | "server_match"
  | "always_visible";

export type ResolvedExtension<T> = {
  item: T;
  reason: ExtensionSelectionReason;
  score: number;
};

export type ExtensionQueryResolution = {
  skills: ResolvedExtension<ManagedSkill>[];
  mcpServers: ResolvedExtension<ManagedMcpServer>[];
};

export type ExtensionManagerSummary = {
  skillCount: number;
  enabledSkillCount: number;
  mcpServerCount: number;
  enabledMcpServerCount: number;
  exposureCounts: Record<ExtensionExposureMode, number>;
};

export interface ExtensionManager {
  listSkills(): ManagedSkill[];
  listMcpServers(): ManagedMcpServer[];
  resolveForQuery(
    query: string,
    options?: { manualSkillIds?: string[] }
  ): ExtensionQueryResolution;
  describeRuntime(): ExtensionManagerSummary;
}
