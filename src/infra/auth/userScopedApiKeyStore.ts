import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveUserHomeDir } from "../config/appRoot";
import type { AuthPersistenceTarget } from "./types";

const AUTH_ENV_NAME = "CYRENE_API_KEY";
const PROVIDER_AUTH_ENV_NAMES = [
  "CYRENE_OPENAI_API_KEY",
  "CYRENE_GEMINI_API_KEY",
  "CYRENE_ANTHROPIC_API_KEY",
] as const;
export const MANAGED_AUTH_ENV_NAMES = [
  AUTH_ENV_NAME,
  ...PROVIDER_AUTH_ENV_NAMES,
] as const;
export type ManagedAuthEnvName = (typeof MANAGED_AUTH_ENV_NAMES)[number];
const MANAGED_BLOCK_START = "# >>> CYRENE API KEY >>>";
const MANAGED_BLOCK_END = "# <<< CYRENE API KEY <<<";
const WINDOWS_ENV_PATH = "HKCU\\Environment";
type ManagedAuthEnvValues = Partial<Record<ManagedAuthEnvName, string>>;

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type UserScopedApiKeyStoreOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathExists?: (path: string) => Promise<boolean>;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, content: string) => Promise<void>;
  unlinkPath?: (path: string) => Promise<void>;
  mkdirp?: (path: string) => Promise<void>;
  execFile?: (
    file: string,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
    }
  ) => Promise<ExecFileResult>;
};

export type UserScopedApiKeyStore = {
  getTarget: () => Promise<AuthPersistenceTarget>;
  read: (envName?: ManagedAuthEnvName) => Promise<string | undefined>;
  readAll?: () => Promise<ManagedAuthEnvValues>;
  save: (
    apiKey: string,
    envName?: ManagedAuthEnvName
  ) => Promise<AuthPersistenceTarget>;
  clear: (envName?: ManagedAuthEnvName) => Promise<AuthPersistenceTarget>;
};

const trimNonEmpty = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const defaultPathExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const escapeDoubleQuotedShellValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");

const unescapeDoubleQuotedShellValue = (value: string) =>
  value
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"')
    .replace(/\\\$/g, "$")
    .replace(/\\`/g, "`");

const getShellName = (env: NodeJS.ProcessEnv) => {
  const rawShell = trimNonEmpty(env.SHELL)?.toLowerCase();
  const normalized = rawShell ? basename(rawShell) : "";
  if (normalized.includes("fish")) {
    return "fish" as const;
  }
  if (normalized.includes("zsh")) {
    return "zsh" as const;
  }
  if (normalized.includes("bash")) {
    return "bash" as const;
  }
  return "posix" as const;
};

const normalizeManagedAuthEnvValues = (
  values: ManagedAuthEnvValues
): ManagedAuthEnvValues =>
  Object.fromEntries(
    Object.entries(values)
      .map(([envName, value]) => [
        envName,
        trimNonEmpty(value),
      ] as const)
      .filter(
        (entry): entry is [ManagedAuthEnvName, string] =>
          Boolean(entry[1]) &&
          (MANAGED_AUTH_ENV_NAMES as readonly string[]).includes(entry[0])
      )
  ) as ManagedAuthEnvValues;

const createManagedShellBlock = (values: ManagedAuthEnvValues) =>
  [
    MANAGED_BLOCK_START,
    ...MANAGED_AUTH_ENV_NAMES.flatMap(envName =>
      values[envName]
        ? [`export ${envName}="${escapeDoubleQuotedShellValue(values[envName]!)}"`]
        : []
    ),
    MANAGED_BLOCK_END,
  ].join("\n");

const createManagedFishFile = (values: ManagedAuthEnvValues) =>
  [
    "# Managed by Cyrene",
    ...MANAGED_AUTH_ENV_NAMES.flatMap(envName =>
      values[envName]
        ? [`set -gx ${envName} "${escapeDoubleQuotedShellValue(values[envName]!)}"`]
        : []
    ),
    "",
  ].join("\n");

const removeManagedBlock = (content: string) =>
  content
    .replace(
      new RegExp(
        `(?:\\r?\\n)?${MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\r?\\n)?`,
        "g"
      ),
      ""
    )
    .replace(/\n{3,}/g, "\n\n");

const upsertManagedBlock = (content: string, values: ManagedAuthEnvValues) => {
  const withoutManaged = removeManagedBlock(content).trimEnd();
  const block = createManagedShellBlock(values);
  if (!withoutManaged) {
    return `${block}\n`;
  }
  return `${withoutManaged}\n\n${block}\n`;
};

const parseManagedBlockApiKeys = (content: string) => {
  const blockMatch = content.match(
    new RegExp(
      `${MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    )
  );
  if (!blockMatch?.[1]) {
    return {};
  }
  const values: ManagedAuthEnvValues = {};
  for (const envName of MANAGED_AUTH_ENV_NAMES) {
    const exportMatch = blockMatch[1].match(
      new RegExp(`export\\s+${envName}\\s*=\\s*"([\\s\\S]*?)"`)
    );
    if (exportMatch?.[1]) {
      values[envName] = unescapeDoubleQuotedShellValue(exportMatch[1]);
    }
  }
  return normalizeManagedAuthEnvValues(values);
};

const parseManagedBlockApiKey = (
  content: string,
  envName: ManagedAuthEnvName = AUTH_ENV_NAME
) => parseManagedBlockApiKeys(content)[envName];

const parseManagedFishApiKeys = (content: string) => {
  const values: ManagedAuthEnvValues = {};
  for (const envName of MANAGED_AUTH_ENV_NAMES) {
    const lineMatch = content.match(
      new RegExp(`set\\s+-gx\\s+${envName}\\s+"([\\s\\S]*?)"`)
    );
    if (lineMatch?.[1]) {
      values[envName] = unescapeDoubleQuotedShellValue(lineMatch[1]);
    }
  }
  return normalizeManagedAuthEnvValues(values);
};

const parseManagedFishApiKey = (
  content: string,
  envName: ManagedAuthEnvName = AUTH_ENV_NAME
) => parseManagedFishApiKeys(content)[envName];

const runDefaultExecFile = async (
  file: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
  }
) => {
  const { execFile } = await import("node:child_process");
  return await new Promise<ExecFileResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        env: options?.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
        });
      }
    );
  });
};

export const createUserScopedApiKeyStore = (
  options: UserScopedApiKeyStoreOptions = {}
): UserScopedApiKeyStore => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? resolveUserHomeDir({ env });
  const pathExists = options.pathExists ?? defaultPathExists;
  const readText =
    options.readText ??
    (async (path: string) => {
      return await readFile(path, "utf8");
    });
  const writeText =
    options.writeText ??
    (async (path: string, content: string) => {
      await writeFile(path, content, "utf8");
    });
  const unlinkPath =
    options.unlinkPath ??
    (async (path: string) => {
      await unlink(path);
    });
  const mkdirp =
    options.mkdirp ??
    (async (path: string) => {
      await mkdir(path, { recursive: true });
    });
  const execFile = options.execFile ?? runDefaultExecFile;

  const getTarget = async (): Promise<AuthPersistenceTarget> => {
    if (platform === "win32") {
      return {
        kind: "windows_user_env",
        shell: "windows",
        path: WINDOWS_ENV_PATH,
        label: "Windows user environment",
        managedByCyrene: true,
      };
    }

    const shell = getShellName(env);
    if (shell === "fish") {
      return {
        kind: "fish_conf_d",
        shell,
        path: join(homeDir, ".config", "fish", "conf.d", "cyrene-auth.fish"),
        label: "fish user config",
        managedByCyrene: true,
      };
    }

    if (shell === "zsh") {
      return {
        kind: "shell_rc_block",
        shell,
        path: join(homeDir, ".zshrc"),
        label: "zsh profile",
        managedByCyrene: true,
      };
    }

    if (shell === "bash") {
      const bashRc = join(homeDir, ".bashrc");
      if (await pathExists(bashRc)) {
        return {
          kind: "shell_rc_block",
          shell,
          path: bashRc,
          label: "bash profile",
          managedByCyrene: true,
        };
      }
      const bashProfile = join(homeDir, ".bash_profile");
      if (await pathExists(bashProfile)) {
        return {
          kind: "shell_rc_block",
          shell,
          path: bashProfile,
          label: "bash login profile",
          managedByCyrene: true,
        };
      }
      return {
        kind: "shell_rc_block",
        shell,
        path: bashRc,
        label: "bash profile",
        managedByCyrene: true,
      };
    }

    return {
      kind: "shell_rc_block",
      shell: "posix",
      path: join(homeDir, ".profile"),
      label: "POSIX profile",
      managedByCyrene: true,
    };
  };

  const readWindowsValue = async (envName: ManagedAuthEnvName = AUTH_ENV_NAME) => {
    const result = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$value = [Environment]::GetEnvironmentVariable('${envName}', 'User'); if ($null -ne $value) { [Console]::Out.Write($value) }`,
      ],
      {
        env,
      }
    );
    return trimNonEmpty(result.stdout.replace(/\r/g, ""));
  };

  const readWindowsValues = async () => {
    const entries = await Promise.all(
      MANAGED_AUTH_ENV_NAMES.map(async envName => {
        const value = await readWindowsValue(envName);
        return value ? ([envName, value] as const) : null;
      })
    );
    return Object.fromEntries(
      entries.filter((entry): entry is [ManagedAuthEnvName, string] => Boolean(entry))
    ) as ManagedAuthEnvValues;
  };

  const writeWindowsValue = async (
    apiKey: string | null,
    envName: ManagedAuthEnvName = AUTH_ENV_NAME
  ) => {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...env,
      CYRENE_AUTH_VALUE: apiKey ?? "",
    };
    await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        apiKey === null
          ? `[Environment]::SetEnvironmentVariable('${envName}', $null, 'User')`
          : `[Environment]::SetEnvironmentVariable('${envName}', $env:CYRENE_AUTH_VALUE, 'User')`,
      ],
      {
        env: mergedEnv,
      }
    );
  };

  return {
    getTarget,
    read: async (envName = AUTH_ENV_NAME) => {
      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        return await readWindowsValue(envName);
      }

      try {
        const content = await readText(target.path);
        return target.kind === "fish_conf_d"
          ? parseManagedFishApiKey(content, envName)
          : parseManagedBlockApiKey(content, envName);
      } catch {
        return undefined;
      }
    },
    readAll: async () => {
      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        return await readWindowsValues();
      }

      try {
        const content = await readText(target.path);
        return target.kind === "fish_conf_d"
          ? parseManagedFishApiKeys(content)
          : parseManagedBlockApiKeys(content);
      } catch {
        return {};
      }
    },
    save: async (apiKey: string, envName = AUTH_ENV_NAME) => {
      const nextKey = trimNonEmpty(apiKey);
      if (!nextKey) {
        throw new Error(`${envName} cannot be empty.`);
      }

      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        await writeWindowsValue(nextKey, envName);
        return target;
      }

      const existingValues =
        target.kind === "fish_conf_d" || (await pathExists(target.path))
          ? await (async () => {
              try {
                const content = await readText(target.path);
                return target.kind === "fish_conf_d"
                  ? parseManagedFishApiKeys(content)
                  : parseManagedBlockApiKeys(content);
              } catch {
                return {} as ManagedAuthEnvValues;
              }
            })()
          : ({} as ManagedAuthEnvValues);
      const nextValues = normalizeManagedAuthEnvValues({
        ...existingValues,
        [envName]: nextKey,
      });

      if (target.kind === "fish_conf_d") {
        await mkdirp(join(homeDir, ".config", "fish", "conf.d"));
        await writeText(target.path, createManagedFishFile(nextValues));
        return target;
      }

      const existing = (await pathExists(target.path))
        ? await readText(target.path)
        : "";
      await writeText(target.path, upsertManagedBlock(existing, nextValues));
      return target;
    },
    clear: async (envName?: ManagedAuthEnvName) => {
      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        if (envName) {
          await writeWindowsValue(null, envName);
        } else {
          await Promise.all(
            MANAGED_AUTH_ENV_NAMES.map(name => writeWindowsValue(null, name))
          );
        }
        return target;
      }

      if (!(await pathExists(target.path))) {
        return target;
      }

      if (target.kind === "fish_conf_d") {
        if (!envName) {
          try {
            await unlinkPath(target.path);
          } catch {
            // Ignore missing managed file on logout.
          }
          return target;
        }
        const existingValues = parseManagedFishApiKeys(await readText(target.path));
        const nextValues = normalizeManagedAuthEnvValues(
          Object.fromEntries(
            Object.entries(existingValues).filter(([name]) => name !== envName)
          ) as ManagedAuthEnvValues
        );
        if (Object.keys(nextValues).length === 0) {
          try {
            await unlinkPath(target.path);
          } catch {
            // Ignore missing managed file on logout.
          }
          return target;
        }
        await writeText(target.path, createManagedFishFile(nextValues));
        return target;
      }

      const existing = await readText(target.path);
      if (!envName) {
        const nextContent = removeManagedBlock(existing).trim();
        if (!nextContent) {
          await writeText(target.path, "");
          return target;
        }
        await writeText(target.path, `${nextContent}\n`);
        return target;
      }

      const existingValues = parseManagedBlockApiKeys(existing);
      const nextValues = normalizeManagedAuthEnvValues(
        Object.fromEntries(
          Object.entries(existingValues).filter(([name]) => name !== envName)
        ) as ManagedAuthEnvValues
      );
      if (Object.keys(nextValues).length === 0) {
        try {
          const nextContent = removeManagedBlock(existing).trim();
          if (!nextContent) {
            await writeText(target.path, "");
            return target;
          }
          await writeText(target.path, `${nextContent}\n`);
          return target;
        } catch {
          return target;
        }
      }
      await writeText(target.path, upsertManagedBlock(existing, nextValues));
      return target;
    },
  };
};

export const __internalUserScopedApiKeyStore = {
  AUTH_ENV_NAME,
  MANAGED_AUTH_ENV_NAMES,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  createManagedShellBlock,
  createManagedFishFile,
  parseManagedBlockApiKeys,
  parseManagedBlockApiKey,
  parseManagedFishApiKeys,
  parseManagedFishApiKey,
  removeManagedBlock,
  upsertManagedBlock,
};
