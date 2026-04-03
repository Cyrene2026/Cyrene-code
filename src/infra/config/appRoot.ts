import { join, resolve } from "node:path";

type AppRootResolveOptions = {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

let configuredAppRoot: string | null = null;

const trimNonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed === "undefined" || trimmed === "null" ? undefined : trimmed;
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

export const getCyreneConfigDir = (appRoot = resolveAppRoot()) =>
  join(appRoot, ".cyrene");
