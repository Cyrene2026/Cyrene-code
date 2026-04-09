import type { AuthStatus } from "../../infra/auth/types";
import { clampCursorOffset } from "./multilineInput";

export type AuthPanelMode = "auto_onboarding" | "manual_login";
export type AuthPanelStep = "provider" | "api_key" | "model" | "confirm";

export type AuthPanelState = {
  active: boolean;
  mode: AuthPanelMode;
  step: AuthPanelStep;
  providerBaseUrl: string;
  apiKey: string;
  model: string;
  rememberedKeyAvailable: boolean;
  usingRememberedKey: boolean;
  cursorOffset: number;
  error: string | null;
  info: string | null;
  saving: boolean;
  persistenceTarget: AuthStatus["persistenceTarget"];
};

export const AUTH_PANEL_STEPS: AuthPanelStep[] = [
  "provider",
  "api_key",
  "model",
  "confirm",
];

export const getAuthPanelFieldValue = (panel: AuthPanelState) => {
  if (panel.step === "provider") {
    return panel.providerBaseUrl;
  }
  if (panel.step === "api_key") {
    return panel.apiKey;
  }
  return panel.model;
};

export const updateAuthPanelFieldValue = (
  panel: AuthPanelState,
  nextValue: string,
  nextCursorOffset: number
): AuthPanelState => {
  const sanitizedValue = nextValue.replace(/\r?\n/g, "");
  const cursorOffset = clampCursorOffset(sanitizedValue, nextCursorOffset);
  if (panel.step === "provider") {
    return {
      ...panel,
      providerBaseUrl: sanitizedValue,
      rememberedKeyAvailable:
        sanitizedValue === panel.providerBaseUrl
          ? panel.rememberedKeyAvailable
          : false,
      usingRememberedKey:
        sanitizedValue === panel.providerBaseUrl ? panel.usingRememberedKey : false,
      cursorOffset,
      error: null,
    };
  }
  if (panel.step === "api_key") {
    return {
      ...panel,
      apiKey: sanitizedValue,
      usingRememberedKey:
        sanitizedValue === panel.apiKey ? panel.usingRememberedKey : false,
      cursorOffset,
      error: null,
    };
  }
  return {
    ...panel,
    model: sanitizedValue,
    cursorOffset,
    error: null,
  };
};

export const transitionAuthPanelStep = (
  panel: AuthPanelState,
  step: AuthPanelStep
): AuthPanelState => ({
  ...panel,
  step,
  cursorOffset:
    step === "provider"
      ? panel.providerBaseUrl.length
      : step === "api_key"
        ? panel.apiKey.length
        : panel.model.length,
  error: null,
  info: null,
});

export const applyRememberedKeyToAuthPanel = (
  panel: AuthPanelState,
  options: {
    normalizedProviderBaseUrl: string;
    savedApiKey: string;
    infoPrefix?: string;
    preferredStep?: Exclude<AuthPanelStep, "confirm">;
    clearWhenMissing?: boolean;
  }
): AuthPanelState => {
  if (!panel.active || panel.saving) {
    return panel;
  }
  if (panel.providerBaseUrl.trim() !== options.normalizedProviderBaseUrl) {
    return panel;
  }
  const nextStep =
    options.savedApiKey.length > 0
      ? "model"
      : (options.preferredStep ?? panel.step);
  const infoLines = [
    options.infoPrefix?.trim(),
    options.savedApiKey
      ? "Using remembered API key for this provider. Press 4 at confirm to replace it."
      : "",
  ].filter(Boolean);
  return {
    ...panel,
    apiKey:
      options.savedApiKey.length > 0
        ? options.savedApiKey
        : options.clearWhenMissing
          ? ""
          : panel.apiKey,
    rememberedKeyAvailable: options.savedApiKey.length > 0,
    usingRememberedKey: options.savedApiKey.length > 0,
    step: nextStep,
    cursorOffset:
      nextStep === "provider"
        ? panel.providerBaseUrl.length
        : nextStep === "api_key"
          ? (options.savedApiKey.length > 0
              ? options.savedApiKey.length
              : options.clearWhenMissing
                ? 0
                : panel.apiKey.length)
          : panel.model.length,
    error: null,
    info: infoLines.length > 0 ? infoLines.join(" ") : null,
  };
};

export const startRememberedKeyReplacementState = (panel: AuthPanelState) => {
  if (
    !panel.active ||
    panel.saving ||
    !panel.rememberedKeyAvailable ||
    !panel.usingRememberedKey
  ) {
    return panel;
  }
  return {
    ...panel,
    step: "api_key" as const,
    apiKey: "",
    usingRememberedKey: false,
    cursorOffset: 0,
    error: null,
    info: "Enter a new API key. Saving will replace the remembered key for this provider.",
  };
};

export const applyAuthProviderPresetState = (
  panel: AuthPanelState,
  options: {
    providerBaseUrl: string;
    presetLabel: string;
  }
): AuthPanelState => {
  if (!panel.active || panel.step !== "provider" || panel.saving) {
    return panel;
  }
  return {
    ...panel,
    providerBaseUrl: options.providerBaseUrl,
    step: "api_key",
    apiKey: "",
    rememberedKeyAvailable: false,
    usingRememberedKey: false,
    cursorOffset: 0,
    error: null,
    info: `Preset selected: ${options.presetLabel} (${options.providerBaseUrl})`,
  };
};
