import type { SkillDefinition, SkillsRuntime } from "../../core/skills";
import type { ChatItem } from "../../shared/types/chat";
import {
  formatSkillDetail,
  formatSkillLine,
  formatSkillsRuntimeSummary,
} from "./chatMcpSkillsFormatting";

type SystemMessageOptions = Pick<ChatItem, "color" | "kind" | "tone">;

type HandleSkillsCommandParams = {
  query: string;
  skillsService?: SkillsRuntime;
  activeSessionId: string | null;
  pushSystemMessage: (text: string, options?: SystemMessageOptions) => void;
  clearInput: () => void;
  getSkillDefinitionById: (skillId: string) => SkillDefinition | null;
  getSessionSkillUseIds: (sessionId: string | null) => string[];
  setSessionSkillUseIds: (sessionId: string | null, ids: string[]) => void;
};

const INFO_MESSAGE_OPTIONS = {
  kind: "system_hint",
  tone: "info",
  color: "cyan",
} satisfies SystemMessageOptions;

const ERROR_MESSAGE_OPTIONS = {
  kind: "error",
  tone: "danger",
  color: "red",
} satisfies SystemMessageOptions;

const pushMutationResult = (
  pushSystemMessage: HandleSkillsCommandParams["pushSystemMessage"],
  result: { ok: boolean; message: string }
) => {
  pushSystemMessage(
    result.message,
    result.ok ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
  );
};

export const handleSkillsCommand = async ({
  query,
  skillsService,
  activeSessionId,
  pushSystemMessage,
  clearInput,
  getSkillDefinitionById,
  getSessionSkillUseIds,
  setSessionSkillUseIds,
}: HandleSkillsCommandParams) => {
  if (query === "/skills") {
    if (!skillsService?.describeRuntime) {
      pushSystemMessage(
        "Skills runtime is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    pushSystemMessage(
      formatSkillsRuntimeSummary(skillsService.describeRuntime()),
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/skills list") {
    if (!skillsService) {
      pushSystemMessage("Skills runtime is unavailable in this build.", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const skills = skillsService.listSkills();
    pushSystemMessage(
      skills.length > 0
        ? ["Skills", ...skills.map(formatSkillLine)].join("\n")
        : "No skills available.",
      INFO_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query.startsWith("/skills show ")) {
    if (!skillsService) {
      pushSystemMessage("Skills runtime is unavailable in this build.", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const skillId = query.slice("/skills show ".length).trim();
    if (!skillId) {
      pushSystemMessage("Usage: /skills show <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const skill = skillsService.listSkills().find(item => item.id === skillId) ?? null;
    pushSystemMessage(
      skill ? formatSkillDetail(skill) : `Skill not found: ${skillId}`,
      skill ? INFO_MESSAGE_OPTIONS : ERROR_MESSAGE_OPTIONS
    );
    clearInput();
    return true;
  }

  if (query === "/skills reload") {
    if (!skillsService?.reloadConfig) {
      pushSystemMessage(
        "Skills runtime reload is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const result = await skillsService.reloadConfig();
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/skills enable ")) {
    if (!skillsService?.setSkillEnabled) {
      pushSystemMessage(
        "Skills runtime management is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const skillId = query.slice("/skills enable ".length).trim();
    if (!skillId) {
      pushSystemMessage("Usage: /skills enable <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await skillsService.setSkillEnabled(skillId, true);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/skills disable ")) {
    if (!skillsService?.setSkillEnabled) {
      pushSystemMessage(
        "Skills runtime management is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const skillId = query.slice("/skills disable ".length).trim();
    if (!skillId) {
      pushSystemMessage("Usage: /skills disable <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await skillsService.setSkillEnabled(skillId, false);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/skills remove ")) {
    if (!skillsService?.removeSkill) {
      pushSystemMessage(
        "Skills runtime remove is unavailable in this build.",
        ERROR_MESSAGE_OPTIONS
      );
      clearInput();
      return true;
    }
    const skillId = query.slice("/skills remove ".length).trim();
    if (!skillId) {
      pushSystemMessage("Usage: /skills remove <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const result = await skillsService.removeSkill(skillId);
    pushMutationResult(pushSystemMessage, result);
    clearInput();
    return true;
  }

  if (query.startsWith("/skills use ")) {
    if (!skillsService) {
      pushSystemMessage("Skills runtime is unavailable in this build.", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }
    const skillId = query.slice("/skills use ".length).trim();
    if (!skillId) {
      pushSystemMessage("Usage: /skills use <id>", ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const skill = getSkillDefinitionById(skillId);
    if (!skill) {
      pushSystemMessage(`Skill not found: ${skillId}`, ERROR_MESSAGE_OPTIONS);
      clearInput();
      return true;
    }

    const targetSessionId = activeSessionId;
    const currentSkillIds = getSessionSkillUseIds(targetSessionId);
    const alreadyActive = currentSkillIds.some(id => id === skill.id);
    if (alreadyActive) {
      pushSystemMessage(
        targetSessionId
          ? `Session skill already active: ${skill.id} (session ${targetSessionId})`
          : `Session skill already queued for next session: ${skill.id}`
      );
      clearInput();
      return true;
    }

    setSessionSkillUseIds(targetSessionId, [...currentSkillIds, skill.id]);
    pushSystemMessage(
      targetSessionId
        ? `Session skill activated: ${skill.id} (${skill.label})\nscope: session ${targetSessionId}`
        : `Session skill activated: ${skill.id} (${skill.label})\nscope: next new session`
    );
    clearInput();
    return true;
  }

  return false;
};
