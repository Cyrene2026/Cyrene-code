import {
  loadSkillsConfig,
  saveProjectSkillsConfig,
  type LoadedSkillsConfig,
  type SkillsConfigPatch,
} from "./loadSkillsConfig";
import type {
  SkillDefinition,
  SkillsRuntime,
  SkillsRuntimeMutationResult,
  SkillsRuntimeSummary,
} from "./types";

type CreateSkillsRuntimeContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const clonePatch = (patch: SkillsConfigPatch): SkillsConfigPatch => ({
  removeSkillIds: [...patch.removeSkillIds],
  skills: patch.skills.map(skill => ({
    ...skill,
    triggers: skill.triggers ? [...skill.triggers] : undefined,
  })),
});

const mergeSkillDefinition = (existing: SkillDefinition | undefined, enabled: boolean) => ({
  id: existing?.id ?? "",
  label: existing?.label ?? existing?.id ?? "",
  description: existing?.description,
  prompt: existing?.prompt ?? "",
  triggers: [...(existing?.triggers ?? [])],
  enabled,
});

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

const scoreSkillByTrigger = (queryLower: string, skill: SkillDefinition) => {
  let score = 0;
  for (const trigger of skill.triggers) {
    const normalized = trigger.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (queryLower.includes(normalized)) {
      score = Math.max(score, normalized.length);
    }
  }
  return score;
};

const formatMutationMessage = (
  action: string,
  skillId: string,
  configPath: string
) => `${action}: ${skillId}\nconfig: ${configPath}`;

class ManagedSkillsRuntime implements SkillsRuntime {
  private config: LoadedSkillsConfig | null = null;

  constructor(
    private readonly appRoot: string,
    private readonly context?: CreateSkillsRuntimeContext
  ) {}

  private getConfig() {
    if (!this.config) {
      throw new Error("Skills runtime not initialized.");
    }
    return this.config;
  }

  async load(config?: LoadedSkillsConfig) {
    this.config = config ?? (await loadSkillsConfig(this.appRoot, this.context));
  }

  listSkills() {
    return [...this.getConfig().skills].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  resolveForQuery(query: string) {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const queryLower = normalized.toLowerCase();
    const skills = this.listSkills().filter(skill => skill.enabled);
    const explicitMentions = getExplicitSkillMentions(normalized);

    const selectedById = new Set<string>();
    const result: SkillDefinition[] = [];

    for (const mention of explicitMentions) {
      const direct = skills.find(skill => skill.id.toLowerCase() === mention);
      if (direct && !selectedById.has(direct.id)) {
        selectedById.add(direct.id);
        result.push(direct);
      }
    }

    const scored = skills
      .map(skill => ({
        skill,
        score: scoreSkillByTrigger(queryLower, skill),
      }))
      .filter(item => item.score > 0 && !selectedById.has(item.skill.id))
      .sort((left, right) =>
        left.score === right.score
          ? left.skill.id.localeCompare(right.skill.id)
          : right.score - left.score
      );

    for (const item of scored) {
      result.push(item.skill);
    }

    return result.slice(0, 4);
  }

  describeRuntime(): SkillsRuntimeSummary {
    const config = this.getConfig();
    return {
      skillCount: config.skills.length,
      enabledSkillCount: config.skills.filter(skill => skill.enabled).length,
      configPaths: [...config.configPaths],
      editableConfigPath: config.editableConfigPath,
    };
  }

  async reloadConfig(): Promise<SkillsRuntimeMutationResult> {
    await this.load();
    const summary = this.describeRuntime();
    return {
      ok: true,
      message: `Skills config reloaded\nskills: ${summary.skillCount} total | ${summary.enabledSkillCount} enabled\nconfig: ${summary.editableConfigPath}`,
      configPath: summary.editableConfigPath,
    };
  }

  async setSkillEnabled(
    skillId: string,
    enabled: boolean
  ): Promise<SkillsRuntimeMutationResult> {
    const normalizedId = skillId.trim();
    if (!normalizedId) {
      return {
        ok: false,
        message: "Skill id is required.",
      };
    }

    const current = this.getConfig();
    const target = current.skills.find(skill => skill.id === normalizedId);
    if (!target) {
      return {
        ok: false,
        message: `Skill not found: ${normalizedId}`,
      };
    }

    const patch = clonePatch(current.projectPatch);
    patch.removeSkillIds = patch.removeSkillIds.filter(id => id !== normalizedId);

    const existingPatch = patch.skills.find(skill => skill.id === normalizedId);
    const merged = mergeSkillDefinition(target, enabled);
    const nextPatchEntry = {
      id: normalizedId,
      label: existingPatch?.label ?? merged.label,
      description: existingPatch?.description ?? merged.description,
      prompt: existingPatch?.prompt ?? merged.prompt,
      triggers:
        existingPatch?.triggers && existingPatch.triggers.length > 0
          ? [...existingPatch.triggers]
          : [...merged.triggers],
      enabled,
    };
    patch.skills = patch.skills.filter(skill => skill.id !== normalizedId);
    patch.skills.push(nextPatchEntry);

    const saved = await saveProjectSkillsConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: formatMutationMessage(
        enabled ? "Skill enabled" : "Skill disabled",
        normalizedId,
        saved.path
      ),
      skillId: normalizedId,
      configPath: saved.path,
    };
  }
}

export const createSkillsRuntimeFromConfig = async (
  appRoot: string,
  config: LoadedSkillsConfig,
  context?: CreateSkillsRuntimeContext
): Promise<SkillsRuntime> => {
  const runtime = new ManagedSkillsRuntime(appRoot, context);
  await runtime.load(config);
  return runtime;
};

export const createSkillsRuntime = async (
  appRoot: string,
  context?: CreateSkillsRuntimeContext
) =>
  createSkillsRuntimeFromConfig(
    appRoot,
    await loadSkillsConfig(appRoot, context),
    context
  );
