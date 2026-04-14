import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getCyreneConfigDir,
  getLegacyProjectCyreneDir,
  resolveAmbientAppRoot,
} from "../../infra/config/appRoot";
import {
  defaultSkillExposureMode,
  normalizeExtensionExposureMode,
} from "../extensions/metadata";
import { parseYamlDocument, stringifyYamlDocument } from "../mcp/simpleYaml";
import { BUILTIN_SKILLS } from "./builtinSkills";
import type { SkillDefinition, SkillSource } from "./types";

type SkillsConfigLoadContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type SkillConfigEntry = {
  id: string;
  label?: string;
  description?: string;
  prompt?: string;
  triggers?: string[];
  enabled?: boolean;
  exposure?: ReturnType<typeof normalizeExtensionExposureMode>;
  tags?: string[];
};

export type SkillsConfigPatch = {
  removeSkillIds: string[];
  skills: SkillConfigEntry[];
};

type LoadedPatchFile = {
  path: string;
  patch: SkillsConfigPatch;
};

export type LoadedSkillsConfig = {
  skills: SkillDefinition[];
  configPaths: string[];
  editableConfigPath: string;
  globalPatch: SkillsConfigPatch;
  projectPatch: SkillsConfigPatch;
  origins: Record<
    string,
    {
      source: SkillSource;
      configPath?: string;
    }
  >;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeString = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeStringArray = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeString(item))
      .filter((item): item is string => Boolean(item));
  }
  const single = normalizeString(value);
  return single ? [single] : [];
};

const normalizeSkillEntry = (value: unknown): SkillConfigEntry | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeString(value.id);
  if (!id) {
    return null;
  }

  return {
    id,
    label: normalizeString(value.label),
    description: normalizeString(value.description),
    prompt: normalizeString(value.prompt),
    triggers: normalizeStringArray(value.triggers),
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    exposure: normalizeExtensionExposureMode(value.exposure),
    tags: normalizeStringArray(value.tags),
  };
};

const parseSkillsConfigPatch = (raw: unknown): SkillsConfigPatch => {
  if (!isRecord(raw)) {
    return {
      removeSkillIds: [],
      skills: [],
    };
  }

  return {
    removeSkillIds: normalizeStringArray(
      raw.remove_skills ?? raw.removeSkills ?? raw.disabled_skills ?? raw.disabledSkills
    ),
    skills: Array.isArray(raw.skills)
      ? raw.skills
          .map(item => normalizeSkillEntry(item))
          .filter((item): item is SkillConfigEntry => Boolean(item))
      : [],
  };
};

const mergeSkillEntry = (
  base: SkillConfigEntry | undefined,
  patch: SkillConfigEntry
): SkillConfigEntry => ({
  id: patch.id,
  label: patch.label ?? base?.label,
  description: patch.description ?? base?.description,
  prompt: patch.prompt ?? base?.prompt,
  triggers:
    patch.triggers && patch.triggers.length > 0
      ? [...patch.triggers]
      : [...(base?.triggers ?? [])],
  enabled: patch.enabled ?? base?.enabled,
  exposure: patch.exposure ?? base?.exposure,
  tags:
    patch.tags && patch.tags.length > 0
      ? [...patch.tags]
      : [...(base?.tags ?? [])],
});

const mergeSkillsPatch = (
  base: SkillsConfigPatch,
  patch: SkillsConfigPatch
): SkillsConfigPatch => {
  const entries = new Map<string, SkillConfigEntry>();

  for (const skill of base.skills) {
    entries.set(skill.id, {
      ...skill,
      triggers: skill.triggers ? [...skill.triggers] : [],
    });
  }
  for (const skill of patch.skills) {
    entries.set(skill.id, mergeSkillEntry(entries.get(skill.id), skill));
  }

  return {
    removeSkillIds: Array.from(
      new Set([
        ...base.removeSkillIds.filter(id => !entries.has(id)),
        ...patch.removeSkillIds,
      ])
    ),
    skills: [...entries.values()],
  };
};

const readExistingFile = async (path: string) => {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

const loadPatchFile = async (path: string): Promise<LoadedPatchFile | null> => {
  const content = await readExistingFile(path);
  if (!content) {
    return null;
  }
  return {
    path,
    patch: parseSkillsConfigPatch(parseYamlDocument(content)),
  };
};

const getProjectConfigCandidates = (projectDir: string) => [
  join(projectDir, "skills.yaml"),
  join(projectDir, "skills.yml"),
];

const getGlobalConfigCandidates = (globalDir: string) => [
  join(globalDir, "skills.yaml"),
  join(globalDir, "skills.yml"),
];

const resolveEditableConfigPath = (
  baseDir: string,
  files: LoadedPatchFile[],
  candidates: (dir: string) => string[]
) => files[0]?.path ?? candidates(baseDir)[0]!;

const serializeSkillEntry = (skill: SkillConfigEntry) => ({
  id: skill.id,
  ...(skill.label ? { label: skill.label } : {}),
  ...(skill.description ? { description: skill.description } : {}),
  ...(skill.prompt ? { prompt: skill.prompt } : {}),
  ...(skill.triggers && skill.triggers.length > 0
    ? { triggers: [...skill.triggers] }
    : {}),
  ...(skill.exposure ? { exposure: skill.exposure } : {}),
  ...(skill.tags && skill.tags.length > 0 ? { tags: [...skill.tags] } : {}),
  ...(typeof skill.enabled === "boolean" ? { enabled: skill.enabled } : {}),
});

const serializePatch = (patch: SkillsConfigPatch) =>
  stringifyYamlDocument({
    ...(patch.removeSkillIds.length > 0
      ? { remove_skills: [...patch.removeSkillIds] }
      : {}),
    skills: patch.skills.map(item => serializeSkillEntry(item)),
  });

export const saveProjectSkillsConfig = async (
  appRoot: string,
  patch: SkillsConfigPatch,
  context?: SkillsConfigLoadContext
) => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const projectDir = getLegacyProjectCyreneDir(resolvedAppRoot);
  const projectFiles = (
    await Promise.all(getProjectConfigCandidates(projectDir).map(path => loadPatchFile(path)))
  ).filter((entry): entry is LoadedPatchFile => Boolean(entry));
  const editableConfigPath = resolveEditableConfigPath(
    projectDir,
    projectFiles,
    getProjectConfigCandidates
  );

  await mkdir(dirname(editableConfigPath), { recursive: true });
  await writeFile(editableConfigPath, serializePatch(patch), "utf8");

  return {
    path: editableConfigPath,
  };
};

export const saveGlobalSkillsConfig = async (
  appRoot: string,
  patch: SkillsConfigPatch,
  context?: SkillsConfigLoadContext
) => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const globalDir = getCyreneConfigDir({
    cwd: resolvedAppRoot,
    env: context?.env,
  });
  const globalFiles = (
    await Promise.all(getGlobalConfigCandidates(globalDir).map(path => loadPatchFile(path)))
  ).filter((entry): entry is LoadedPatchFile => Boolean(entry));
  const editableConfigPath = resolveEditableConfigPath(
    globalDir,
    globalFiles,
    getGlobalConfigCandidates
  );

  await mkdir(dirname(editableConfigPath), { recursive: true });
  await writeFile(editableConfigPath, serializePatch(patch), "utf8");

  return {
    path: editableConfigPath,
  };
};

export const loadSkillsConfig = async (
  appRoot?: string,
  context?: SkillsConfigLoadContext
): Promise<LoadedSkillsConfig> => {
  const resolvedAppRoot = appRoot ?? resolveAmbientAppRoot(context);
  const globalDir = getCyreneConfigDir({
    cwd: resolvedAppRoot,
    env: context?.env,
  });
  const projectDir = getLegacyProjectCyreneDir(resolvedAppRoot);
  const globalCandidates = getGlobalConfigCandidates(globalDir);
  const projectCandidates = getProjectConfigCandidates(projectDir);

  const globalFiles = (
    await Promise.all(globalCandidates.map(path => loadPatchFile(path)))
  ).filter((entry): entry is LoadedPatchFile => Boolean(entry));
  const projectFiles = (
    await Promise.all(projectCandidates.map(path => loadPatchFile(path)))
  ).filter((entry): entry is LoadedPatchFile => Boolean(entry));

  const globalPatch = globalFiles.reduce<SkillsConfigPatch>(
    (acc, file) => mergeSkillsPatch(acc, file.patch),
    {
      removeSkillIds: [],
      skills: [],
    }
  );
  const projectPatch = projectFiles.reduce<SkillsConfigPatch>(
    (acc, file) => mergeSkillsPatch(acc, file.patch),
    {
      removeSkillIds: [],
      skills: [],
    }
  );

  const skillMap = new Map<string, SkillDefinition>();
  const origins = new Map<
    string,
    {
      source: SkillSource;
      configPath?: string;
    }
  >();

  for (const skill of BUILTIN_SKILLS) {
    skillMap.set(skill.id, {
      ...skill,
      triggers: [...skill.triggers],
      tags: [...skill.tags],
      exposure: skill.exposure ?? defaultSkillExposureMode(),
    });
    origins.set(skill.id, { source: "built_in" });
  }

  for (const file of globalFiles) {
    for (const skill of file.patch.skills) {
      const base = skillMap.get(skill.id);
      skillMap.set(skill.id, {
        id: skill.id,
        label: skill.label ?? base?.label ?? skill.id,
        description: skill.description ?? base?.description,
        prompt: skill.prompt ?? base?.prompt ?? "",
        triggers:
          skill.triggers && skill.triggers.length > 0
            ? [...skill.triggers]
            : [...(base?.triggers ?? [])],
        enabled: skill.enabled ?? base?.enabled ?? true,
        exposure:
          skill.exposure ?? base?.exposure ?? defaultSkillExposureMode(),
        tags:
          skill.tags && skill.tags.length > 0
            ? [...skill.tags]
            : [...(base?.tags ?? [])],
        source: "global",
        configPath: file.path,
      });
      origins.set(skill.id, {
        source: "global",
        configPath: file.path,
      });
    }
  }

  for (const skillId of globalPatch.removeSkillIds) {
    skillMap.delete(skillId);
    origins.delete(skillId);
  }

  for (const file of projectFiles) {
    for (const skill of file.patch.skills) {
      const base = skillMap.get(skill.id);
      skillMap.set(skill.id, {
        id: skill.id,
        label: skill.label ?? base?.label ?? skill.id,
        description: skill.description ?? base?.description,
        prompt: skill.prompt ?? base?.prompt ?? "",
        triggers:
          skill.triggers && skill.triggers.length > 0
            ? [...skill.triggers]
            : [...(base?.triggers ?? [])],
        enabled: skill.enabled ?? base?.enabled ?? true,
        exposure:
          skill.exposure ?? base?.exposure ?? defaultSkillExposureMode(),
        tags:
          skill.tags && skill.tags.length > 0
            ? [...skill.tags]
            : [...(base?.tags ?? [])],
        source: "project",
        configPath: file.path,
      });
      origins.set(skill.id, {
        source: "project",
        configPath: file.path,
      });
    }
  }

  for (const skillId of projectPatch.removeSkillIds) {
    skillMap.delete(skillId);
    origins.delete(skillId);
  }

  const skills = [...skillMap.values()].filter(skill => Boolean(skill.prompt.trim()));

  return {
    skills,
    configPaths: [...globalFiles, ...projectFiles].map(file => file.path),
    editableConfigPath: resolveEditableConfigPath(
      globalDir,
      globalFiles,
      getGlobalConfigCandidates
    ),
    globalPatch,
    projectPatch,
    origins: Object.fromEntries(origins.entries()),
  };
};
