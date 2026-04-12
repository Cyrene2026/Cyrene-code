export type MatchRange = {
  start: number;
  end: number;
};

export type CommandArgumentHint = {
  label: string;
  optional: boolean;
};

export type CommandSpec = {
  command: string;
  description: string;
  group?: string;
  matchRanges?: MatchRange[];
};

export type CommandSuggestion = CommandSpec & {
  group: string;
  matchRanges: MatchRange[];
  baseCommand: string;
  template: string | null;
  argumentHints: CommandArgumentHint[];
  insertValue: string;
};

export const COMMAND_SPECS: CommandSpec[] = [
  { command: "/help", description: "show command list" },
  { command: "/login", description: "open HTTP login wizard" },
  {
    command: "/logout",
    description: "remove managed user auth and rebuild transport",
  },
  {
    command: "/auth",
    description: "show auth mode, source, and persistence target",
  },
  { command: "/provider", description: "open provider picker" },
  { command: "/provider refresh", description: "refresh current provider models" },
  {
    command: "/provider profile list",
    description: "list manual provider profile overrides",
  },
  {
    command: "/provider profile <openai|gemini|anthropic|custom> [url]",
    description: "override provider profile (custom clears override)",
  },
  {
    command: "/provider profile clear [url]",
    description: "clear manual provider profile override",
  },
  {
    command: "/provider name list",
    description: "list custom provider names",
  },
  {
    command: "/provider name <display_name>",
    description: "set a custom name for the current provider",
  },
  {
    command: "/provider name clear [url]",
    description: "clear custom provider name",
  },
  {
    command: "/provider <url>",
    description:
      "switch provider directly (also accepts openai/gemini/anthropic)",
  },
  { command: "/model", description: "open model picker" },
  { command: "/model refresh", description: "refresh available models" },
  { command: "/model <name>", description: "switch model directly" },
  { command: "/system", description: "show current system prompt" },
  { command: "/system <text>", description: "set system prompt for this runtime" },
  { command: "/system reset", description: "restore default system prompt" },
  { command: "/state", description: "show reducer/session state diagnostics" },
  { command: "/sessions", description: "open sessions panel" },
  { command: "/resume", description: "open session resume picker" },
  { command: "/resume <id>", description: "resume a session by id" },
  { command: "/new", description: "start a fresh session" },
  { command: "/cancel", description: "cancel the current running turn" },
  { command: "/undo", description: "undo last approved filesystem mutation" },
  {
    command: "/search-session <query>",
    description: "search sessions by id/title/content",
  },
  {
    command: "/search-session #<tag> [query]",
    description: "search sessions by tag + query",
  },
  { command: "/tag list", description: "list tags of current session" },
  { command: "/tag add <tag>", description: "add tag to current session" },
  { command: "/tag remove <tag>", description: "remove tag from current session" },
  { command: "/pin <note>", description: "pin important context" },
  { command: "/pins", description: "list pinned context" },
  { command: "/unpin <index>", description: "remove a pin" },
  { command: "/skills", description: "show skills runtime summary" },
  { command: "/skills list", description: "list available skills" },
  { command: "/skills show <id>", description: "show one skill details" },
  { command: "/skills enable <id>", description: "enable one skill in project config" },
  {
    command: "/skills disable <id>",
    description: "disable one skill in project config",
  },
  {
    command: "/skills remove <id>",
    description: "remove one skill via project remove_skills override",
  },
  { command: "/skills use <id>", description: "use one skill for the current session only" },
  { command: "/skills reload", description: "reload skills config from disk" },
  { command: "/extensions", description: "show extensions runtime summary" },
  { command: "/extensions list", description: "list managed skills and MCP servers" },
  { command: "/extensions skills", description: "list managed skills with scope/exposure" },
  { command: "/extensions mcp", description: "list managed MCP servers with trust/scope/exposure" },
  {
    command: "/extensions show <id|skill:<id>|mcp:<id>>",
    description: "inspect one managed skill or MCP server",
  },
  {
    command: "/extensions resolve <query>",
    description: "preview which extensions would be selected for a query",
  },
  {
    command: "/extensions enable <id|skill:<id>|mcp:<id>>",
    description: "enable one managed skill or MCP server",
  },
  {
    command: "/extensions disable <id|skill:<id>|mcp:<id>>",
    description: "disable one managed skill or MCP server",
  },
  {
    command: "/extensions exposure <hidden|hinted|scoped|full> <id|skill:<id>|mcp:<id>>",
    description: "set exposure policy for one managed skill or MCP server",
  },
  { command: "/mcp", description: "show MCP runtime summary" },
  { command: "/mcp servers", description: "list registered MCP servers" },
  { command: "/mcp server <id>", description: "inspect one MCP server" },
  { command: "/mcp tools", description: "list tools across registered MCP servers" },
  { command: "/mcp tools <server>", description: "list tools for one MCP server" },
  { command: "/mcp pending", description: "show pending MCP operations" },
  {
    command: "/mcp add stdio <id> <command...>",
    description: "add a stdio MCP server to project config",
  },
  {
    command: "/mcp add http <id> <url>",
    description: "add an HTTP MCP server to project config",
  },
  {
    command: "/mcp add filesystem <id> [workspace]",
    description: "add a filesystem MCP server to project config",
  },
  {
    command: "/mcp lsp list [filesystem-server]",
    description: "list configured LSP servers for filesystem MCP servers",
  },
  {
    command:
      "/mcp lsp add <filesystem-server> <preset>|<lsp-id> ...",
    description:
      "add one mainstream-language LSP preset or a custom LSP server config",
  },
  {
    command: "/mcp lsp remove <filesystem-server> <lsp-id>",
    description: "remove one LSP server config from a filesystem MCP server",
  },
  {
    command: "/mcp lsp doctor <filesystem-server> <path> [--lsp <lsp-id>]",
    description: "inspect LSP matching and startup for one file path",
  },
  {
    command: "/mcp lsp bootstrap <filesystem-server>",
    description: "auto-add mainstream-language LSP presets detected in the workspace",
  },
  { command: "/mcp remove <id>", description: "remove one MCP server from active project config" },
  { command: "/mcp enable <id>", description: "enable one MCP server in project config" },
  {
    command: "/mcp disable <id>",
    description: "disable one MCP server in project config",
  },
  { command: "/mcp reload", description: "reload MCP config from disk" },
  { command: "/review", description: "open approval queue" },
  { command: "/review <id>", description: "inspect one pending operation" },
  { command: "/approve [id]", description: "approve pending operation(s)" },
  { command: "/approve low", description: "approve all non-high-risk operations" },
  { command: "/approve all", description: "approve all pending operations" },
  { command: "/reject [id]", description: "reject pending operation(s)" },
  { command: "/reject all", description: "reject all pending operations" },
];

export const HELP_TEXT = [
  "Commands:",
  ...COMMAND_SPECS.map(spec => `${spec.command} - ${spec.description}`),
].join("\n");

export const AUTH_PROVIDER_PRESETS = {
  "1": {
    alias: "openai",
    label: "OpenAI",
  },
  "2": {
    alias: "gemini",
    label: "Gemini",
  },
  "3": {
    alias: "anthropic",
    label: "Anthropic",
  },
} as const;

const mergeMatchRanges = (ranges: MatchRange[]) => {
  if (ranges.length === 0) {
    return [];
  }

  const ordered = [...ranges].sort((left, right) =>
    left.start === right.start ? left.end - right.end : left.start - right.start
  );
  const merged: MatchRange[] = [];

  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
};

const collectOrderedMatchRanges = (text: string, tokens: string[]) => {
  if (tokens.length === 0) {
    return [];
  }

  const normalizedText = text.toLowerCase();
  const ranges: MatchRange[] = [];
  let searchStart = 0;

  for (const token of tokens) {
    if (!token) {
      continue;
    }
    const index = normalizedText.indexOf(token, searchStart);
    if (index < 0) {
      return null;
    }
    ranges.push({
      start: index,
      end: index + token.length,
    });
    searchStart = index + token.length;
  }

  return mergeMatchRanges(ranges);
};

const getCommandGroup = (command: string) => {
  if (
    command.startsWith("/login") ||
    command.startsWith("/logout") ||
    command.startsWith("/auth")
  ) {
    return "Auth";
  }
  if (command.startsWith("/provider") || command.startsWith("/model")) {
    return "Model & provider";
  }
  if (
    command.startsWith("/sessions") ||
    command.startsWith("/resume") ||
    command === "/new" ||
    command === "/cancel"
  ) {
    return "Session";
  }
  if (command.startsWith("/system") || command === "/state") {
    return "Prompt & state";
  }
  if (
    command.startsWith("/search-session") ||
    command.startsWith("/tag") ||
    command.startsWith("/pin") ||
    command.startsWith("/pins") ||
    command.startsWith("/unpin")
  ) {
    return "Context";
  }
  if (command.startsWith("/skills")) {
    return "Skills";
  }
  if (command.startsWith("/extensions")) {
    return "Extensions";
  }
  if (command.startsWith("/mcp")) {
    return "MCP";
  }
  if (
    command === "/undo" ||
    command.startsWith("/review") ||
    command.startsWith("/approve") ||
    command.startsWith("/reject")
  ) {
    return "Review";
  }
  return "General";
};

const getSlashInsertValue = (command: string) => {
  switch (command) {
    case "/provider <url>":
      return "/provider ";
    case "/provider profile <openai|gemini|anthropic|custom> [url]":
      return "/provider profile ";
    case "/provider profile clear [url]":
      return "/provider profile clear ";
    case "/provider name <display_name>":
      return "/provider name ";
    case "/provider name clear [url]":
      return "/provider name clear ";
    case "/model <name>":
      return "/model ";
    case "/system <text>":
      return "/system ";
    case "/resume <id>":
      return "/resume ";
    case "/search-session <query>":
      return "/search-session ";
    case "/search-session #<tag> [query]":
      return "/search-session #";
    case "/tag add <tag>":
      return "/tag add ";
    case "/tag remove <tag>":
      return "/tag remove ";
    case "/pin <note>":
      return "/pin ";
    case "/unpin <index>":
      return "/unpin ";
    case "/skills enable <id>":
      return "/skills enable ";
    case "/skills disable <id>":
      return "/skills disable ";
    case "/skills remove <id>":
      return "/skills remove ";
    case "/skills use <id>":
      return "/skills use ";
    case "/skills show <id>":
      return "/skills show ";
    case "/extensions show <id|skill:<id>|mcp:<id>>":
      return "/extensions show ";
    case "/extensions resolve <query>":
      return "/extensions resolve ";
    case "/extensions enable <id|skill:<id>|mcp:<id>>":
      return "/extensions enable ";
    case "/extensions disable <id|skill:<id>|mcp:<id>>":
      return "/extensions disable ";
    case "/extensions exposure <hidden|hinted|scoped|full> <id|skill:<id>|mcp:<id>>":
      return "/extensions exposure ";
    case "/mcp server <id>":
      return "/mcp server ";
    case "/mcp tools <server>":
      return "/mcp tools ";
    case "/mcp add stdio <id> <command...>":
      return "/mcp add stdio ";
    case "/mcp add http <id> <url>":
      return "/mcp add http ";
    case "/mcp add filesystem <id> [workspace]":
      return "/mcp add filesystem ";
    case "/mcp lsp list [filesystem-server]":
      return "/mcp lsp list ";
    case "/mcp lsp add <filesystem-server> <lsp-id> --command <cmd> [--arg <arg>]... --pattern <glob> [--pattern <glob>]... [--root <marker>]... [--workspace <path>] [--env KEY=VALUE]...":
      return "/mcp lsp add ";
    case "/mcp lsp remove <filesystem-server> <lsp-id>":
      return "/mcp lsp remove ";
    case "/mcp lsp doctor <filesystem-server> <path> [--lsp <lsp-id>]":
      return "/mcp lsp doctor ";
    case "/mcp remove <id>":
      return "/mcp remove ";
    case "/mcp enable <id>":
      return "/mcp enable ";
    case "/mcp disable <id>":
      return "/mcp disable ";
    case "/review <id>":
      return "/review ";
    case "/approve [id]":
      return "/approve ";
    case "/reject [id]":
      return "/reject ";
    default:
      return command;
  }
};

export function getCommandTemplateMeta(command: string): {
  baseCommand: string;
  template: string | null;
  argumentHints: CommandArgumentHint[];
  insertValue: string;
} {
  const [baseCommand = command, ...rest] = command.trim().split(/\s+/);
  const template = rest.length > 0 ? rest.join(" ") : null;
  const argumentHints: CommandArgumentHint[] = [];
  const argumentPattern = /#?<([^>]+)>|\[([^\]]+)\]/g;

  let match: RegExpExecArray | null = null;
  while ((match = argumentPattern.exec(template ?? "")) !== null) {
    const label = (match[1] ?? match[2] ?? "").trim().replace(/^#/, "");
    if (!label) {
      continue;
    }
    argumentHints.push({
      label,
      optional: Boolean(match[2]),
    });
  }

  return {
    baseCommand,
    template,
    argumentHints,
    insertValue: getSlashInsertValue(command),
  };
}

export const getSlashSuggestions = (rawInput: string): CommandSuggestion[] => {
  const value = rawInput.trimStart();
  if (!value.startsWith("/")) {
    return [];
  }

  const normalized = value.toLowerCase();
  const primaryToken = normalized.split(/\s+/, 1)[0] ?? normalized;
  const queryTokens = normalized.split(/\s+/).filter(Boolean);

  const matches: Array<CommandSuggestion & { score: number }> = [];
  for (const spec of COMMAND_SPECS) {
    const specNormalized = spec.command.toLowerCase();
    const compactCommand = specNormalized.replace(/\s+<.*$/, "");
    const matchRanges = collectOrderedMatchRanges(spec.command, queryTokens);
    const startsWithNormalized = specNormalized.startsWith(normalized);
    const startsWithPrimary = specNormalized.startsWith(primaryToken);
    const directCommand = normalized.startsWith(compactCommand);
    if (
      !startsWithNormalized &&
      !startsWithPrimary &&
      !directCommand &&
      matchRanges === null
    ) {
      continue;
    }

    const exact = specNormalized === normalized ? 1 : 0;
    const rangePenalty = matchRanges?.[0]?.start ?? specNormalized.length;
    const score =
      exact * 400 +
      (startsWithNormalized ? 220 : 0) +
      (directCommand ? 180 : 0) +
      (startsWithPrimary ? 80 : 0) +
      Math.max(0, 40 - Math.min(rangePenalty, 40)) +
      queryTokens.length * 4;

    matches.push({
      ...spec,
      group: spec.group ?? getCommandGroup(spec.command),
      matchRanges: matchRanges ?? [],
      ...getCommandTemplateMeta(spec.command),
      score,
    });
  }

  matches.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const leftNormalized = left.command.toLowerCase();
    const rightNormalized = right.command.toLowerCase();

    if (leftNormalized.includes(" ") !== rightNormalized.includes(" ")) {
      return leftNormalized.includes(" ") ? -1 : 1;
    }

    if (leftNormalized.length !== rightNormalized.length) {
      return rightNormalized.length - leftNormalized.length;
    }

    return leftNormalized.localeCompare(rightNormalized);
  });

  return matches.slice(0, 8).map(({ score: _score, ...spec }) => spec);
};
