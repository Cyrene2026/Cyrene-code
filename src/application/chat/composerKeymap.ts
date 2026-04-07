export type ComposerKeymap = "standard" | "compat";

type EnvLike = Record<string, string | undefined>;

export const STANDARD_COMPOSER_HINT =
  "Enter send  |  Ctrl+J newline  |  Shift+Enter if terminal supports it  |  / commands  |  @ files  |  !shell";

export const COMPAT_COMPOSER_HINT =
  "Ctrl+D send  |  Enter/Ctrl+J newline  |  / commands  |  @ files  |  !shell";

const isKnownEnhancedKeyboardTerminal = (env: EnvLike) =>
  env.TERM === "xterm-kitty" ||
  env.KITTY_WINDOW_ID !== undefined ||
  env.TERM_PROGRAM === "WezTerm" ||
  env.TERM_PROGRAM === "ghostty" ||
  env.GHOSTTY_BIN_DIR !== undefined ||
  env.GHOSTTY_RESOURCES_DIR !== undefined;

const isWindowsTerminalChain = (env: EnvLike) => env.WT_SESSION !== undefined;

export const resolveComposerKeymap = (
  env: EnvLike = process.env
): ComposerKeymap => {
  const forced = env.CYRENE_COMPOSER_KEYS?.trim().toLowerCase();

  if (forced === "standard" || forced === "compat") {
    return forced;
  }

  if (isKnownEnhancedKeyboardTerminal(env)) {
    return "standard";
  }

  if (isWindowsTerminalChain(env)) {
    return "compat";
  }

  return "standard";
};

export const getComposerHint = (keymap: ComposerKeymap) =>
  keymap === "compat" ? COMPAT_COMPOSER_HINT : STANDARD_COMPOSER_HINT;
