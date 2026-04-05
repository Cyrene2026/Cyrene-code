import { homedir } from "node:os";
import { join, resolve } from "node:path";

type AppRootResolveOptions = {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type CyreneDirResolveOptions = Pick<AppRootResolveOptions, "cwd" | "env">;

let configuredAppRoot: string | null = null;

const trimNonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed === "undefined" || trimmed === "null" ? undefined : trimmed;
};

const resolveHomeFromEnv = (env: NodeJS.ProcessEnv) => {
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
  const envHome = resolveHomeFromEnv(env);
  return envHome ? resolve(cwd, envHome) : homedir();
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
  const explicitCyreneHome = trimNonEmpty(env.CYRENE_HOME);
  if (explicitCyreneHome) {
    return resolve(cwd, explicitCyreneHome);
  }
  return join(resolveUserHomeDir(options), ".cyrene");
};
