import type { McpRuntimeLspServerInput } from "./runtimeTypes";

export type LspPreset = {
  id: string;
  aliases: string[];
  label: string;
  command: string;
  args?: string[];
  filePatterns: string[];
  rootMarkers?: string[];
  workspaceRoot?: string;
  env?: Record<string, string>;
  installHint?: string;
};

const LSP_PRESETS: LspPreset[] = [
  {
    id: "typescript",
    aliases: ["ts", "tsx", "javascript", "js"],
    label: "TypeScript / JavaScript",
    command: "typescript-language-server",
    args: ["--stdio"],
    filePatterns: [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx",
      "**/*.mts",
      "**/*.cts",
      "**/*.mjs",
      "**/*.cjs",
    ],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    installHint: "npm install -g typescript-language-server typescript",
  },
  {
    id: "python",
    aliases: ["py"],
    label: "Python",
    command: "pyright-langserver",
    args: ["--stdio"],
    filePatterns: ["**/*.py", "**/*.pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
    installHint: "npm install -g pyright",
  },
  {
    id: "rust",
    aliases: ["rs"],
    label: "Rust",
    command: "rust-analyzer",
    filePatterns: ["**/*.rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    installHint: "install rust-analyzer and ensure `rust-analyzer` is available in PATH",
  },
  {
    id: "go",
    aliases: ["golang"],
    label: "Go",
    command: "gopls",
    filePatterns: ["**/*.go"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "cpp",
    aliases: ["c", "cxx", "cc", "c++"],
    label: "C / C++",
    command: "clangd",
    filePatterns: [
      "**/*.c",
      "**/*.cc",
      "**/*.cpp",
      "**/*.cxx",
      "**/*.h",
      "**/*.hh",
      "**/*.hpp",
      "**/*.hxx",
    ],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", ".git"],
    installHint: "install clangd from LLVM and ensure `clangd` is available in PATH",
  },
  {
    id: "java",
    aliases: ["jdt"],
    label: "Java",
    command: "jdtls",
    filePatterns: ["**/*.java"],
    rootMarkers: [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      ".git",
    ],
    installHint: "install eclipse-jdtls and ensure `jdtls` is available in PATH",
  },
  {
    id: "csharp",
    aliases: ["cs", "c#"],
    label: "C#",
    command: "OmniSharp",
    args: ["--languageserver"],
    filePatterns: ["**/*.cs"],
    rootMarkers: ["*.sln", "*.csproj", "global.json", ".git"],
    installHint: "install OmniSharp and ensure `OmniSharp` is available in PATH",
  },
  {
    id: "php",
    aliases: [],
    label: "PHP",
    command: "intelephense",
    args: ["--stdio"],
    filePatterns: ["**/*.php"],
    rootMarkers: ["composer.json", ".git"],
    installHint: "npm install -g intelephense",
  },
  {
    id: "ruby",
    aliases: ["rb"],
    label: "Ruby",
    command: "solargraph",
    args: ["stdio"],
    filePatterns: ["**/*.rb", "**/*.rake", "**/*.gemspec", "**/Gemfile", "**/Rakefile"],
    rootMarkers: ["Gemfile", ".ruby-version", ".git"],
    installHint: "gem install solargraph",
  },
  {
    id: "lua",
    aliases: [],
    label: "Lua",
    command: "lua-language-server",
    filePatterns: ["**/*.lua"],
    rootMarkers: [".luarc.json", ".luarc.jsonc", ".git"],
    installHint: "install lua-language-server and ensure it is available in PATH",
  },
  {
    id: "html",
    aliases: ["htm"],
    label: "HTML",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    filePatterns: ["**/*.html", "**/*.htm"],
    rootMarkers: ["package.json", ".git"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    id: "css",
    aliases: ["scss", "less"],
    label: "CSS / SCSS / LESS",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    filePatterns: ["**/*.css", "**/*.scss", "**/*.less"],
    rootMarkers: ["package.json", ".git"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    id: "json",
    aliases: ["jsonc"],
    label: "JSON / JSONC",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    filePatterns: ["**/*.json", "**/*.jsonc"],
    rootMarkers: ["package.json", ".git"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    id: "yaml",
    aliases: ["yml"],
    label: "YAML",
    command: "yaml-language-server",
    args: ["--stdio"],
    filePatterns: ["**/*.yaml", "**/*.yml"],
    rootMarkers: [".git"],
    installHint: "npm install -g yaml-language-server",
  },
  {
    id: "bash",
    aliases: ["sh", "shell", "zsh"],
    label: "Bash / Shell",
    command: "bash-language-server",
    args: ["start"],
    filePatterns: ["**/*.sh", "**/*.bash", "**/*.zsh"],
    rootMarkers: [".git"],
    installHint: "npm install -g bash-language-server",
  },
];

const normalizeGlob = (value: string) => value.replace(/\\/g, "/").trim();

const globToRegExp = (pattern: string) => {
  const normalized = normalizeGlob(pattern);
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    const nextNext = normalized[index + 2] ?? "";
    if (char === "*" && next === "*" && nextNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += /[\\^$+?.()|{}\[\]]/.test(char) ? `\\${char}` : char;
  }

  source += "$";
  return new RegExp(source);
};

const normalizePresetName = (value: string) => value.trim().toLowerCase();

export const resolveLspPreset = (value: string): LspPreset | null => {
  const normalized = normalizePresetName(value);
  if (!normalized) {
    return null;
  }
  return (
    LSP_PRESETS.find(
      preset =>
        preset.id === normalized ||
        preset.aliases.some(alias => normalizePresetName(alias) === normalized)
    ) ?? null
  );
};

export const createLspInputFromPreset = (
  preset: LspPreset,
  overrideId?: string
): McpRuntimeLspServerInput => ({
  id: overrideId?.trim() || preset.id,
  command: preset.command,
  ...(preset.args && preset.args.length > 0 ? { args: [...preset.args] } : {}),
  filePatterns: [...preset.filePatterns],
  ...(preset.rootMarkers && preset.rootMarkers.length > 0
    ? { rootMarkers: [...preset.rootMarkers] }
    : {}),
  ...(preset.workspaceRoot ? { workspaceRoot: preset.workspaceRoot } : {}),
  ...(preset.env ? { env: { ...preset.env } } : {}),
});

export const formatLspPresetCatalog = () =>
  LSP_PRESETS.map(preset =>
    preset.aliases.length > 0
      ? `${preset.id} (${preset.aliases.join(", ")})`
      : preset.id
  ).join(", ");

export const listLspPresets = () => LSP_PRESETS.map(preset => ({ ...preset, aliases: [...preset.aliases] }));

export const getLspPresetInstallHint = (presetId: string) =>
  resolveLspPreset(presetId)?.installHint ?? null;

const arraysEqual = (left: string[] | undefined, right: string[] | undefined) => {
  const a = [...(left ?? [])];
  const b = [...(right ?? [])];
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
};

export const findLspPresetByInput = (input: McpRuntimeLspServerInput) =>
  LSP_PRESETS.find(
    preset =>
      preset.command === input.command &&
      arraysEqual(preset.args, input.args) &&
      arraysEqual(preset.filePatterns, input.filePatterns) &&
      arraysEqual(preset.rootMarkers, input.rootMarkers)
  ) ?? null;

type LspPresetConfigLike = {
  id?: string;
  command: string;
  args?: string[];
  filePatterns?: string[];
  rootMarkers?: string[];
};

export const resolveLspPresetForConfig = (config: LspPresetConfigLike) => {
  const exactMatch = LSP_PRESETS.find(
    preset =>
      preset.command === config.command &&
      arraysEqual(preset.args, config.args) &&
      arraysEqual(preset.filePatterns, config.filePatterns) &&
      arraysEqual(preset.rootMarkers, config.rootMarkers)
  );
  if (exactMatch) {
    return exactMatch;
  }

  const idMatch = config.id ? resolveLspPreset(config.id) : null;
  if (idMatch) {
    return idMatch;
  }

  const commandAndArgsMatch = LSP_PRESETS.find(
    preset =>
      preset.command === config.command &&
      arraysEqual(preset.args, config.args)
  );
  if (commandAndArgsMatch) {
    return commandAndArgsMatch;
  }

  return LSP_PRESETS.find(preset => preset.command === config.command) ?? null;
};

export const getLspInstallHintForConfig = (config: LspPresetConfigLike) =>
  resolveLspPresetForConfig(config)?.installHint ?? null;

export const matchesLspPresetPath = (preset: LspPreset, workspacePath: string) => {
  const normalized = normalizeGlob(workspacePath);
  return preset.filePatterns.some(pattern => globToRegExp(pattern).test(normalized));
};
