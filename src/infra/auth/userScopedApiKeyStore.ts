import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveUserHomeDir } from "../config/appRoot";
import type { AuthPersistenceTarget } from "./types";

const AUTH_ENV_NAME = "CYRENE_API_KEY";
const MANAGED_BLOCK_START = "# >>> CYRENE API KEY >>>";
const MANAGED_BLOCK_END = "# <<< CYRENE API KEY <<<";
const WINDOWS_ENV_PATH = "HKCU\\Environment";

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
  read: () => Promise<string | undefined>;
  save: (apiKey: string) => Promise<AuthPersistenceTarget>;
  clear: () => Promise<AuthPersistenceTarget>;
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

const createManagedShellBlock = (apiKey: string) =>
  [
    MANAGED_BLOCK_START,
    `export ${AUTH_ENV_NAME}="${escapeDoubleQuotedShellValue(apiKey)}"`,
    MANAGED_BLOCK_END,
  ].join("\n");

const createManagedFishFile = (apiKey: string) =>
  [
    "# Managed by Cyrene",
    `set -gx ${AUTH_ENV_NAME} "${escapeDoubleQuotedShellValue(apiKey)}"`,
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

const upsertManagedBlock = (content: string, apiKey: string) => {
  const withoutManaged = removeManagedBlock(content).trimEnd();
  const block = createManagedShellBlock(apiKey);
  if (!withoutManaged) {
    return `${block}\n`;
  }
  return `${withoutManaged}\n\n${block}\n`;
};

const parseManagedBlockApiKey = (content: string) => {
  const blockMatch = content.match(
    new RegExp(
      `${MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    )
  );
  if (!blockMatch?.[1]) {
    return undefined;
  }
  const exportMatch = blockMatch[1].match(
    new RegExp(`export\\s+${AUTH_ENV_NAME}\\s*=\\s*"([\\s\\S]*)"`)
  );
  return exportMatch?.[1]
    ? unescapeDoubleQuotedShellValue(exportMatch[1])
    : undefined;
};

const parseManagedFishApiKey = (content: string) => {
  const lineMatch = content.match(
    new RegExp(`set\\s+-gx\\s+${AUTH_ENV_NAME}\\s+"([\\s\\S]*)"`)
  );
  return lineMatch?.[1]
    ? unescapeDoubleQuotedShellValue(lineMatch[1])
    : undefined;
};

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

  const readWindowsValue = async () => {
    const result = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$value = [Environment]::GetEnvironmentVariable('${AUTH_ENV_NAME}', 'User'); if ($null -ne $value) { [Console]::Out.Write($value) }`,
      ],
      {
        env,
      }
    );
    return trimNonEmpty(result.stdout.replace(/\r/g, ""));
  };

  const writeWindowsValue = async (apiKey: string | null) => {
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
          ? `[Environment]::SetEnvironmentVariable('${AUTH_ENV_NAME}', $null, 'User')`
          : `[Environment]::SetEnvironmentVariable('${AUTH_ENV_NAME}', $env:CYRENE_AUTH_VALUE, 'User')`,
      ],
      {
        env: mergedEnv,
      }
    );
  };

  return {
    getTarget,
    read: async () => {
      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        return await readWindowsValue();
      }

      try {
        const content = await readText(target.path);
        return target.kind === "fish_conf_d"
          ? parseManagedFishApiKey(content)
          : parseManagedBlockApiKey(content);
      } catch {
        return undefined;
      }
    },
    save: async (apiKey: string) => {
      const nextKey = trimNonEmpty(apiKey);
      if (!nextKey) {
        throw new Error("CYRENE_API_KEY cannot be empty.");
      }

      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        await writeWindowsValue(nextKey);
        return target;
      }

      if (target.kind === "fish_conf_d") {
        await mkdirp(join(homeDir, ".config", "fish", "conf.d"));
        await writeText(target.path, createManagedFishFile(nextKey));
        return target;
      }

      const existing = (await pathExists(target.path))
        ? await readText(target.path)
        : "";
      await writeText(target.path, upsertManagedBlock(existing, nextKey));
      return target;
    },
    clear: async () => {
      const target = await getTarget();
      if (target.kind === "windows_user_env") {
        await writeWindowsValue(null);
        return target;
      }

      if (!(await pathExists(target.path))) {
        return target;
      }

      if (target.kind === "fish_conf_d") {
        try {
          await unlinkPath(target.path);
        } catch {
          // Ignore missing managed file on logout.
        }
        return target;
      }

      const existing = await readText(target.path);
      const nextContent = removeManagedBlock(existing).trim();
      if (!nextContent) {
        await writeText(target.path, "");
        return target;
      }
      await writeText(target.path, `${nextContent}\n`);
      return target;
    },
  };
};

export const __internalUserScopedApiKeyStore = {
  AUTH_ENV_NAME,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  createManagedShellBlock,
  createManagedFishFile,
  parseManagedBlockApiKey,
  parseManagedFishApiKey,
  removeManagedBlock,
  upsertManagedBlock,
};
