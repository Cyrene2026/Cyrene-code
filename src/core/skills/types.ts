export type SkillSource = "built_in" | "global" | "project";

export type SkillDefinition = {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  triggers: string[];
  enabled: boolean;
  source: SkillSource;
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

export interface SkillsRuntime {
  listSkills(): SkillDefinition[];
  resolveForQuery(query: string): SkillDefinition[];
  describeRuntime?(): SkillsRuntimeSummary;
  reloadConfig?(): Promise<SkillsRuntimeMutationResult>;
  setSkillEnabled?(
    skillId: string,
    enabled: boolean
  ): Promise<SkillsRuntimeMutationResult>;
}
