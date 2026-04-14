import {
  defaultSkillExposureMode,
  normalizeExtensionExposureMode,
} from "../extensions/metadata";
import type {
  SkillCreationInput,
  SkillDefinition,
  SkillsRuntime,
  SkillsRuntimeMutationResult,
  SkillsRuntimeSummary,
} from "./types";
import type { ExtensionExposureMode } from "../extensions/metadata";
import {
  loadSkillsConfig,
  saveGlobalSkillsConfig,
  type LoadedSkillsConfig,
  type SkillsConfigPatch,
} from "./loadSkillsConfig";

type CreateSkillsRuntimeContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const clonePatch = (patch: SkillsConfigPatch): SkillsConfigPatch => ({
  removeSkillIds: [...patch.removeSkillIds],
  skills: patch.skills.map(skill => ({
    ...skill,
    triggers: skill.triggers ? [...skill.triggers] : undefined,
    tags: skill.tags ? [...skill.tags] : undefined,
  })),
});

const mergeSkillDefinition = (existing: SkillDefinition | undefined, enabled: boolean) => ({
  id: existing?.id ?? "",
  label: existing?.label ?? existing?.id ?? "",
  description: existing?.description,
  prompt: existing?.prompt ?? "",
  triggers: [...(existing?.triggers ?? [])],
  exposure: existing?.exposure ?? "scoped",
  tags: [...(existing?.tags ?? [])],
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

const canAutoSelectSkill = (skill: SkillDefinition) =>
  skill.exposure === "scoped" || skill.exposure === "full";

const canSelectSkillByExplicitMention = (skill: SkillDefinition) =>
  skill.exposure !== "hidden";

const formatMutationMessage = (
  action: string,
  skillId: string,
  configPath: string
) => `${action}: ${skillId}\nconfig: ${configPath}`;

const normalizeSkillId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

const normalizeStringArray = (values: string[] | undefined) =>
  Array.from(
    new Set(
      (values ?? [])
        .map(value => value.trim())
        .filter(Boolean)
    )
  );

const normalizeSkillCreationInput = (input: SkillCreationInput) => {
  const id = normalizeSkillId(input.id);
  const label = input.label.trim();
  const description = input.description?.trim() || undefined;
  const prompt = input.prompt.trim();
  const triggers = normalizeStringArray(input.triggers);
  const tags = normalizeStringArray(input.tags);
  const exposure =
    normalizeExtensionExposureMode(input.exposure) ?? defaultSkillExposureMode();
  const enabled = input.enabled ?? true;

  return {
    id,
    label,
    description,
    prompt,
    triggers,
    tags,
    exposure,
    enabled,
  };
};

const isProjectSkill = (skill: SkillDefinition) => skill.source === "project";

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
      if (
        direct &&
        canSelectSkillByExplicitMention(direct) &&
        !selectedById.has(direct.id)
      ) {
        selectedById.add(direct.id);
        result.push(direct);
      }
    }

    const scored = skills
      .map(skill => ({
        skill,
        score: scoreSkillByTrigger(queryLower, skill),
      }))
      .filter(
        item =>
          item.score > 0 &&
          canAutoSelectSkill(item.skill) &&
          !selectedById.has(item.skill.id)
      )
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

  async createSkill(input: SkillCreationInput): Promise<SkillsRuntimeMutationResult> {
    const normalized = normalizeSkillCreationInput(input);
    if (!normalized.id) {
      return {
        ok: false,
        message: "Skill id is required.",
      };
    }
    if (!normalized.label) {
      return {
        ok: false,
        message: `Skill label is required: ${normalized.id}`,
      };
    }
    if (!normalized.prompt) {
      return {
        ok: false,
        message: `Skill prompt is required: ${normalized.id}`,
      };
    }
    if (normalized.triggers.length === 0) {
      return {
        ok: false,
        message: `Skill triggers are required: ${normalized.id}`,
      };
    }

    const current = this.getConfig();
    if (current.skills.some(skill => skill.id === normalized.id)) {
      return {
        ok: false,
        message: `Skill already exists: ${normalized.id}`,
      };
    }

    const globalSkills = current.skills.filter(skill => skill.source === "global");
    const patch: SkillsConfigPatch = {
      removeSkillIds: [],
      skills: globalSkills
        .filter(skill => skill.id !== normalized.id)
        .map(skill => ({
          id: skill.id,
          label: skill.label,
          description: skill.description,
          prompt: skill.prompt,
          triggers: [...skill.triggers],
          exposure: skill.exposure,
          tags: [...skill.tags],
          enabled: skill.enabled,
        })),
    };
    patch.skills.push({
      id: normalized.id,
      label: normalized.label,
      description: normalized.description,
      prompt: normalized.prompt,
      triggers: normalized.triggers,
      exposure: normalized.exposure,
      tags: normalized.tags,
      enabled: normalized.enabled,
    });

    const saved = await saveGlobalSkillsConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: formatMutationMessage("Skill created", normalized.id, saved.path),
      skillId: normalized.id,
      configPath: saved.path,
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
    if (isProjectSkill(target)) {
      return {
        ok: false,
        message: `Skill is defined in project config and cannot be changed via global skills config: ${normalizedId}`,
      };
    }

    const patch = clonePatch(current.globalPatch);
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
      exposure: existingPatch?.exposure ?? merged.exposure,
      tags:
        existingPatch?.tags && existingPatch.tags.length > 0
          ? [...existingPatch.tags]
          : [...merged.tags],
      enabled,
    };
    patch.skills = patch.skills.filter(skill => skill.id !== normalizedId);
    patch.skills.push(nextPatchEntry);

    const saved = await saveGlobalSkillsConfig(this.appRoot, patch, this.context);
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

  async setSkillExposure(
    skillId: string,
    exposure: ExtensionExposureMode
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
    if (isProjectSkill(target)) {
      return {
        ok: false,
        message: `Skill is defined in project config and cannot be changed via global skills config: ${normalizedId}`,
      };
    }

    const patch = clonePatch(current.globalPatch);
    patch.removeSkillIds = patch.removeSkillIds.filter(id => id !== normalizedId);

    const existingPatch = patch.skills.find(skill => skill.id === normalizedId);
    const merged = mergeSkillDefinition(target, target.enabled);
    const nextPatchEntry = {
      id: normalizedId,
      label: existingPatch?.label ?? merged.label,
      description: existingPatch?.description ?? merged.description,
      prompt: existingPatch?.prompt ?? merged.prompt,
      triggers:
        existingPatch?.triggers && existingPatch.triggers.length > 0
          ? [...existingPatch.triggers]
          : [...merged.triggers],
      exposure,
      tags:
        existingPatch?.tags && existingPatch.tags.length > 0
          ? [...existingPatch.tags]
          : [...merged.tags],
      enabled: existingPatch?.enabled ?? merged.enabled,
    };
    patch.skills = patch.skills.filter(skill => skill.id !== normalizedId);
    patch.skills.push(nextPatchEntry);

    const saved = await saveGlobalSkillsConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: `Skill exposure updated: ${normalizedId}\nexposure: ${exposure}\nconfig: ${saved.path}`,
      skillId: normalizedId,
      configPath: saved.path,
    };
  }

  async removeSkill(skillId: string): Promise<SkillsRuntimeMutationResult> {
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
    if (isProjectSkill(target)) {
      return {
        ok: false,
        message: `Skill is defined in project config and cannot be removed via global skills config: ${normalizedId}`,
      };
    }

    const patch = clonePatch(current.globalPatch);
    patch.removeSkillIds = Array.from(
      new Set([...patch.removeSkillIds, normalizedId])
    );
    patch.skills = patch.skills.filter(skill => skill.id !== normalizedId);

    const saved = await saveGlobalSkillsConfig(this.appRoot, patch, this.context);
    await this.load();

    return {
      ok: true,
      message: formatMutationMessage("Skill removed", normalizedId, saved.path),
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
