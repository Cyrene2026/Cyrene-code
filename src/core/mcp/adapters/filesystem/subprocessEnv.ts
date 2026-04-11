const SAFE_SUBPROCESS_ENV_KEYS = new Set([
  "APPDATA",
  "COLORTERM",
  "ComSpec",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LOCALAPPDATA",
  "LOGNAME",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "Path",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);

const SAFE_SUBPROCESS_ENV_PREFIXES = [
  "LC_",
];

const shouldKeepEnvKey = (key: string) =>
  SAFE_SUBPROCESS_ENV_KEYS.has(key) ||
  SAFE_SUBPROCESS_ENV_PREFIXES.some(prefix => key.startsWith(prefix));

export const pickRestrictedSubprocessEnv = (
  source: NodeJS.ProcessEnv | undefined = process.env
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === "string" && shouldKeepEnvKey(key)) {
      env[key] = value;
    }
  }

  return env;
};

export const buildRestrictedSubprocessEnv = (
  ...sources: Array<NodeJS.ProcessEnv | undefined>
) => {
  const env = pickRestrictedSubprocessEnv(process.env);

  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") {
        env[key] = value;
      } else {
        delete env[key];
      }
    }
  }

  return env;
};

export const buildRestrictedSubprocessEnvFromBase = (
  baseEnv?: NodeJS.ProcessEnv,
  ...overrides: Array<NodeJS.ProcessEnv | undefined>
) => {
  const env = pickRestrictedSubprocessEnv(baseEnv);

  for (const source of overrides) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") {
        env[key] = value;
      } else {
        delete env[key];
      }
    }
  }

  return env;
};
