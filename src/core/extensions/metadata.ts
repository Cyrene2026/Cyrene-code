export type ExtensionExposureMode = "hidden" | "hinted" | "scoped" | "full";

export const EXTENSION_EXPOSURE_MODES: ExtensionExposureMode[] = [
  "hidden",
  "hinted",
  "scoped",
  "full",
];

export const normalizeExtensionExposureMode = (
  value: unknown
): ExtensionExposureMode | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return EXTENSION_EXPOSURE_MODES.includes(normalized as ExtensionExposureMode)
    ? (normalized as ExtensionExposureMode)
    : undefined;
};

export const defaultSkillExposureMode = (): ExtensionExposureMode => "scoped";

export const defaultMcpServerExposureMode = (options: {
  transport?: string;
  enabled?: boolean;
}): ExtensionExposureMode => {
  if (options.transport === "filesystem") {
    return "full";
  }
  if (options.enabled === false) {
    return "hidden";
  }
  return "hinted";
};

export const defaultMcpToolExposureMode = (
  serverExposure: ExtensionExposureMode
): ExtensionExposureMode => {
  if (serverExposure === "full") {
    return "full";
  }
  if (serverExposure === "hidden") {
    return "hidden";
  }
  return "scoped";
};
