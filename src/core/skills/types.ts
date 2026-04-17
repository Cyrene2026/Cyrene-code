import type { ExtensionExposureMode } from "../extensions/metadata";

export type SkillSource = "built_in" | "global" | "project";

export type SkillDefinition = {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  triggers: string[];
  enabled: boolean;
  exposure: ExtensionExposureMode;
  tags: string[];
  source: SkillSource;
  configPath?: string;
};

export type SkillsRuntimeSummary = {
  skillCount: number;
  enabledSkillCount: number;
  configPaths: string[];
  editableConfigPath: string;
};

export type SkillsRuntimeMutationResult = {
  ok: boolean;
  message: string;
  skillId?: string;
  configPath?: string;
};

export type SkillCreationInput = {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  triggers: string[];
  enabled?: boolean;
  exposure?: ExtensionExposureMode;
  tags?: string[];
  scope?: "global" | "project";
};

export interface SkillsRuntime {
  listSkills(): SkillDefinition[];
  resolveForQuery(query: string): SkillDefinition[];
  describeRuntime?(): SkillsRuntimeSummary;
  reloadConfig?(): Promise<SkillsRuntimeMutationResult>;
  createSkill?(input: SkillCreationInput): Promise<SkillsRuntimeMutationResult>;
  setSkillEnabled?(
    skillId: string,
    enabled: boolean
  ): Promise<SkillsRuntimeMutationResult>;
  setSkillExposure?(
    skillId: string,
    exposure: ExtensionExposureMode
  ): Promise<SkillsRuntimeMutationResult>;
  removeSkill?(skillId: string): Promise<SkillsRuntimeMutationResult>;
}
