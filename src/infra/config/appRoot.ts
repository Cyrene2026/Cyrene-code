import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

type AppRootResolveOptions = {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

type CyreneDirResolveOptions = Pick<AppRootResolveOptions, "cwd" | "env" | "platform">;

let configuredAppRoot: string | null = null;

const trimNonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed === "undefined" || trimmed === "null" ? undefined : trimmed;
};

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE_PATH = /^\\\\[^\\]/;

const isWindowsStyleAbsolutePath = (value: string) =>
  WINDOWS_DRIVE_ABSOLUTE_PATH.test(value) ||
  WINDOWS_UNC_ABSOLUTE_PATH.test(value);

const pathApiForPlatform = (platform?: NodeJS.Platform) =>
  platform === "win32" ? win32 : posix;

const joinCyreneDir = (homeDir: string, platform?: NodeJS.Platform) => {
  if (platform === "win32") {
    const trimmed = homeDir.replace(/[\\/]+$/, "");
    const separator = trimmed.includes("/") ? "/" : "\\";
    return `${trimmed}${separator}.cyrene`;
  }
  return posix.join(homeDir, ".cyrene");
};

const resolveHomeFromEnv = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
) => {
  if (platform !== "win32") {
    const home = trimNonEmpty(env.HOME);
    if (home) {
      return home;
    }
  }

  const userProfile = trimNonEmpty(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }

  const home = trimNonEmpty(env.HOME);
  if (home) {
    return home;
  }

  const homeDrive = trimNonEmpty(env.HOMEDRIVE);
  const homePath = trimNonEmpty(env.HOMEPATH);
  if (homeDrive && homePath) {
    return `${homeDrive}${homePath}`;
  }

  return undefined;
};

export const parseRootArg = (argv: string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const token = trimNonEmpty(argv[index]);
    if (!token) {
      continue;
    }

    if (token === "--root" || token === "-r") {
      return trimNonEmpty(argv[index + 1]);
    }

    if (token.startsWith("--root=")) {
      return trimNonEmpty(token.slice("--root=".length));
    }
  }

  return undefined;
};

export const resolveAppRoot = (options?: AppRootResolveOptions) => {
  const cwd = options?.cwd ?? process.cwd();
  const envRoot = trimNonEmpty((options?.env ?? process.env).CYRENE_ROOT);
  return configuredAppRoot ?? resolve(cwd, envRoot ?? ".");
};

export const resolveAmbientAppRoot = (
  options?: Pick<AppRootResolveOptions, "cwd" | "env">
) => {
  const cwd = options?.cwd ?? process.cwd();
  const envRoot = trimNonEmpty((options?.env ?? process.env).CYRENE_ROOT);
  return resolve(cwd, envRoot ?? ".");
};

export const configureAppRootFromArgs = (options?: AppRootResolveOptions) => {
  const cwd = options?.cwd ?? process.cwd();
  const cliRoot = parseRootArg(options?.argv ?? process.argv.slice(2));
  const envRoot = trimNonEmpty((options?.env ?? process.env).CYRENE_ROOT);
  configuredAppRoot = resolve(cwd, cliRoot ?? envRoot ?? ".");
  return configuredAppRoot;
};

export const setConfiguredAppRoot = (appRoot: string, cwd = process.cwd()) => {
  configuredAppRoot = resolve(cwd, appRoot);
  return configuredAppRoot;
};

export const resetConfiguredAppRoot = () => {
  configuredAppRoot = null;
};

export const resolveUserHomeDir = (options?: CyreneDirResolveOptions) => {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const pathApi = pathApiForPlatform(options?.platform);
  const envHome = resolveHomeFromEnv(env, options?.platform);
  if (!envHome) {
    return homedir();
  }

  if (isWindowsStyleAbsolutePath(envHome)) {
    return envHome;
  }

  if (isAbsolute(envHome)) {
    return pathApi.resolve(envHome);
  }

  return pathApi.resolve(cwd, envHome);
};

export const getLegacyProjectCyreneDir = (appRoot = resolveAppRoot()) =>
  join(appRoot, ".cyrene");

export const getCyreneConfigDir = (
  appRootOrOptions?: string | CyreneDirResolveOptions,
  maybeOptions?: CyreneDirResolveOptions
) => {
  const options =
    typeof appRootOrOptions === "string" ? maybeOptions : appRootOrOptions;
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const pathApi = pathApiForPlatform(options?.platform);
  const explicitCyreneHome = trimNonEmpty(env.CYRENE_HOME);
  if (explicitCyreneHome) {
    if (isWindowsStyleAbsolutePath(explicitCyreneHome)) {
      return explicitCyreneHome;
    }
    if (isAbsolute(explicitCyreneHome)) {
      return pathApi.resolve(explicitCyreneHome);
    }
    return pathApi.resolve(cwd, explicitCyreneHome);
  }
  return joinCyreneDir(resolveUserHomeDir(options), options?.platform);
};
