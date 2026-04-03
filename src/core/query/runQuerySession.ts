import { parseStreamChunk } from "./streamProtocol";
import {
  createQuerySessionState,
  querySessionReducer,
  type QuerySessionDispatch,
  type QuerySessionState,
} from "./sessionMachine";
import type { QueryTransport } from "./transport";

type RunQuerySessionParams = {
  query: string;
  originalTask?: string;
  queryMaxToolSteps?: number;
  transport: QueryTransport;
  onState: (state: QuerySessionState) => void;
  onTextDelta: (text: string) => void;
  onToolCall: (
    toolName: string,
    input: unknown
  ) =>
    | Promise<{ message: string; reviewMode?: "queue" | "block" }>
    | { message: string; reviewMode?: "queue" | "block" };
  onError: (message: string) => void;
};

export type RunQuerySessionResult =
  | { status: "completed" }
  | {
      status: "suspended";
      resume: (toolResultMessage: string) => Promise<RunQuerySessionResult>;
    };

const getToolAction = (toolName: string, input: unknown) => {
  if (
    input &&
    typeof input === "object" &&
    "action" in (input as Record<string, unknown>) &&
    typeof (input as Record<string, unknown>).action === "string"
  ) {
    return String((input as Record<string, unknown>).action);
  }
  return toolName;
};

const getToolPath = (input: unknown) => {
  if (
    input &&
    typeof input === "object" &&
    "path" in (input as Record<string, unknown>) &&
    typeof (input as Record<string, unknown>).path === "string"
  ) {
    return String((input as Record<string, unknown>).path);
  }
  return undefined;
};

const toRecord = (input: unknown): Record<string, unknown> | null =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : null;

const pickTrimmedString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const pickStringArray = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return Array.isArray(value) && value.every(item => typeof item === "string")
    ? (value as string[])
    : undefined;
};

const pickFiniteNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const pickBoolean = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

const MUTATING_FILE_ACTIONS = new Set([
  "create_dir",
  "create_file",
  "write_file",
  "edit_file",
  "delete_file",
  "copy_path",
  "move_path",
]);

const MUTATION_RESULT_MARKERS = [
  "Created file:",
  "Created directory:",
  "Wrote file:",
  "Edited file:",
  "Deleted file:",
  "Copied path:",
  "Moved path:",
];

const isExploratoryProbe = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "list_dir";

const isReadFileAction = (toolName: string, input: unknown) =>
  getToolAction(toolName, input) === "read_file";

const isCommandLikeAction = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return action === "run_command" || action === "run_shell";
};

const isFilesystemBoundFileAction = (toolName: string, input: unknown) =>
  toolName === "file" && !isCommandLikeAction(toolName, input);

const isMutatingFileAction = (toolName: string, input: unknown) =>
  MUTATING_FILE_ACTIONS.has(getToolAction(toolName, input));

const didApplyFileMutation = (
  toolName: string,
  input: unknown,
  message: string
) =>
  isMutatingFileAction(toolName, input) &&
  MUTATION_RESULT_MARKERS.some(marker => message.includes(marker));

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort();
    return `{${keys
      .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const getNormalizedLoopInput = (toolName: string, input: unknown): unknown => {
  const record = toRecord(input);
  if (!record) {
    return input ?? null;
  }

  if (toolName !== "file") {
    return record;
  }

  const action = getToolAction(toolName, input);
  const path = pickTrimmedString(record, "path");

  switch (action) {
    case "read_file":
    case "list_dir":
    case "create_dir":
    case "create_file":
    case "write_file":
    case "delete_file":
    case "stat_path":
      return { action, path };
    case "edit_file":
      return {
        action,
        path,
        find: typeof record.find === "string" ? record.find : undefined,
        replace: typeof record.replace === "string" ? record.replace : undefined,
      };
    case "find_files":
      return {
        action,
        path: path ?? ".",
        pattern: pickTrimmedString(record, "pattern"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        caseSensitive: pickBoolean(record, "caseSensitive"),
      };
    case "search_text":
      return {
        action,
        path: path ?? ".",
        query: pickTrimmedString(record, "query"),
        maxResults: pickFiniteNumber(record, "maxResults"),
        caseSensitive: pickBoolean(record, "caseSensitive"),
      };
    case "copy_path":
    case "move_path":
      return {
        action,
        path,
        destination: pickTrimmedString(record, "destination"),
      };
    case "run_command":
      return {
        action,
        command: pickTrimmedString(record, "command"),
        args: pickStringArray(record, "args") ?? [],
        cwd: pickTrimmedString(record, "cwd"),
      };
    case "run_shell":
      return {
        action,
        path: path ?? ".",
        command: pickTrimmedString(record, "command"),
        cwd: pickTrimmedString(record, "cwd"),
      };
    default:
      return {
        action,
        ...record,
      };
  }
};

const getLoopDisplayName = (toolName: string, input: unknown) => {
  const action = getToolAction(toolName, input);
  return toolName === "file" && action ? action : toolName;
};

const getLoopSignature = (
  toolName: string,
  input: unknown,
  filesystemMutationRevision: number
) => {
  const scope = isFilesystemBoundFileAction(toolName, input)
    ? `fs:${filesystemMutationRevision}`
    : "global";
  return `${toolName}:${scope}:${stableSerialize(getNormalizedLoopInput(toolName, input))}`;
};

const normalizeForIntent = (text: string) => text.toLowerCase();

const taskSuggestsWriting = (task: string) =>
  /(create|write|add|append|fill|implement|fix|update|modify|patch|save|generate|补|写|创建|修复|更新|修改|实现|填充|补充|写入)/i.test(
    task
  );

const taskMentionsEmptyOrMissingContent = (task: string) =>
  /(empty|blank|missing content|no content|didn'?t write|not written|空|为空|空的|没写|没有写|未写入|内容为空|没内容)/i.test(
    task
  );

const buildHeuristicNudges = (originalTask: string, toolResults: string[]) => {
  if (toolResults.length === 0) {
    return "";
  }

  const recentResults = toolResults.slice(-6).join("\n\n");
  const normalizedTask = normalizeForIntent(originalTask);
  const wantsWrite = taskSuggestsWriting(normalizedTask);
  const mentionsEmptyIssue = taskMentionsEmptyOrMissingContent(normalizedTask);
  const nudges: string[] = [
    "Continue from the confirmed facts in the tool results above. Do not restart exploration from scratch.",
  ];

  if (wantsWrite && recentResults.includes("[confirmed directory state]")) {
    nudges.push(
      "Stop exploring and start writing: the relevant directory state is already confirmed."
    );
  }

  if ((wantsWrite || mentionsEmptyIssue) && recentResults.includes("(empty file)")) {
    nudges.push(
      "The next action should be write_file/create_file/edit_file, not read_file again, because the file was already confirmed empty."
    );
  }

  if (
    recentResults.includes("[tool result] find_files ") ||
    recentResults.includes("[tool result] search_text ") ||
    recentResults.includes("[tool result] stat_path ")
  ) {
    nudges.push(
      "Use the discovered path or search hit directly; do not rediscover it with more list_dir/find_files/search_text calls."
    );
  }

  if (
    (recentResults.includes("[tool result] run_command ") ||
      recentResults.includes("[tool result] run_shell ")) &&
    /status:\s*(failed|timed_out)/i.test(recentResults)
  ) {
    nudges.push(
      "The same process or shell command already failed. Do not rerun it unchanged unless you are changing args, cwd, command text, or the plan."
    );
  }

  return nudges.map((nudge, index) => `${index + 1}. ${nudge}`).join("\n");
};

const buildRoundPrompt = (
  originalTask: string,
  toolResults: string[],
  loopCorrection: string
) => {
  const heuristicNudges = buildHeuristicNudges(originalTask, toolResults);
  return [
    "Original user task:",
    originalTask,
    "",
    "Continue based on tool results while staying strictly on the original task.",
    "Do not inspect unrelated files unless required for the task.",
    "Treat a confirmed directory state as authoritative until a mutation changes it.",
    "Do not call list_dir again for the same path immediately after it was already confirmed.",
    "Treat `(empty file)` from read_file as a confirmed result and do not re-read the same file unless something changed it.",
    heuristicNudges ? `Heuristic nudges:\n${heuristicNudges}` : "",
    loopCorrection ? `\n${loopCorrection}\n` : "",
    "Tool results:",
    toolResults.join("\n\n") || "(none)",
    "If more tool usage is needed, call tools again. Otherwise provide final answer.",
  ].join("\n\n");
};

const isFailedCommandResult = (message: string) =>
  /status:\s*(failed|timed_out)/i.test(message) ||
  /exit:\s*(?!0\b)[^\s]+/i.test(message);

export const runQuerySession = async ({
  query,
  originalTask,
  queryMaxToolSteps = 24,
  transport,
  onState,
  onTextDelta,
  onToolCall,
  onError,
}: RunQuerySessionParams): Promise<RunQuerySessionResult> => {
  let state = createQuerySessionState();
  const task = originalTask ?? query;
  let filesystemMutationRevision = 0;
  const maxToolSteps =
    Number.isFinite(queryMaxToolSteps) && queryMaxToolSteps > 0
      ? Math.floor(queryMaxToolSteps)
      : 24;
  const dispatch: QuerySessionDispatch = event => {
    state = querySessionReducer(state, event);
    onState(state);
  };

  const runRounds = async (
    roundPrompt: string,
    repeatedToolCallCount: Map<string, number>,
    loopCorrection: string,
    accumulatedToolResults: string[],
    toolStepsUsed: number
  ): Promise<RunQuerySessionResult> => {
    dispatch({ type: "start" });

    const streamUrl = await transport.requestStreamUrl(roundPrompt);
    let completed = false;
    let sawToolCall = false;
    const toolResults: string[] = [];

    for await (const chunk of transport.stream(streamUrl)) {
      const events = parseStreamChunk(chunk);
      for (const event of events) {
        if (event.type === "text_delta") {
          dispatch({ type: "text_delta", text: event.text });
          onTextDelta(event.text);
          continue;
        }

        if (event.type === "tool_call") {
          if (toolStepsUsed >= maxToolSteps) {
            onTextDelta(
              `\n[tool budget exhausted] Used ${toolStepsUsed}/${maxToolSteps} tool steps. Stopping to avoid runaway execution. Split the task or raise query_max_tool_steps to continue.\n`
            );
            dispatch({ type: "complete" });
            return { status: "completed" };
          }
          toolStepsUsed += 1;
          sawToolCall = true;
          const signature = getLoopSignature(
            event.toolName,
            event.input,
            filesystemMutationRevision
          );
          const displayName = getLoopDisplayName(event.toolName, event.input);
          const seen = (repeatedToolCallCount.get(signature) ?? 0) + 1;
          repeatedToolCallCount.set(signature, seen);
          if (seen >= 2 && isExploratoryProbe(event.toolName, event.input)) {
            const repeatedPath = getToolPath(event.input) ?? ".";
            loopCorrection = [
              "Repeated directory probe warning:",
              `Directory state for ${repeatedPath} was already confirmed.`,
              "Do NOT call list_dir for the same path again unless a write or directory mutation happened.",
              "Choose the next concrete action toward the original task.",
            ].join("\n");
          } else if (seen >= 2 && isCommandLikeAction(event.toolName, event.input)) {
            const action = getToolAction(event.toolName, event.input);
            const commandKind = action === "run_shell" ? "shell command" : "bounded command";
            loopCorrection = [
              `Repeated ${commandKind} warning:`,
              `Command call was repeated: ${displayName} ${stableSerialize(
                getNormalizedLoopInput(event.toolName, event.input)
              )}`,
              `Do NOT rerun the same ${action} unchanged unless the prior result shows a concrete new reason.`,
              "Prefer the next concrete fix, file edit, or adjusted command.",
            ].join("\n");
          } else if (seen >= 2) {
            loopCorrection = [
              "Loop warning:",
              `Tool call was repeated: ${displayName} ${stableSerialize(
                getNormalizedLoopInput(event.toolName, event.input)
              )}`,
              "Do NOT call the same tool with the same input again.",
              "Choose the next concrete step toward completing the original task.",
            ].join("\n");
          }
          if (seen >= 3 && isExploratoryProbe(event.toolName, event.input)) {
            const repeatedPath = getToolPath(event.input) ?? ".";
            onTextDelta(
              `\n[tool loop detected] list_dir ${repeatedPath} was called repeatedly after directory state was already confirmed. Stopping to prevent infinite loop.\n`
            );
            dispatch({ type: "complete" });
            return { status: "completed" };
          }
          if (seen >= 3 && isCommandLikeAction(event.toolName, event.input)) {
            const action = getToolAction(event.toolName, event.input);
            onTextDelta(
              `\n[tool loop detected] ${action} was called repeatedly with the same command signature. Stopping to prevent infinite loop.\n`
            );
            dispatch({ type: "complete" });
            return { status: "completed" };
          }
          if (seen >= 4) {
            onTextDelta(
              `\n[tool loop detected] ${displayName} was called repeatedly with same input. Stopping to prevent infinite loop.\n`
            );
            dispatch({ type: "complete" });
            return { status: "completed" };
          }
          dispatch({
            type: "tool_call",
            toolName: event.toolName,
            input: event.input,
          });
          const toolResult = await onToolCall(event.toolName, event.input);
          if (
            seen >= 2 &&
            isReadFileAction(event.toolName, event.input) &&
            toolResult.message.includes("(empty file)")
          ) {
            const repeatedPath = getToolPath(event.input) ?? ".";
            onTextDelta(
              `\n[tool loop detected] read_file ${repeatedPath} was repeated even though the file was already confirmed empty. Stopping to prevent infinite loop.\n`
            );
            dispatch({ type: "complete" });
            return { status: "completed" };
          }
          if (
            seen >= 2 &&
            isCommandLikeAction(event.toolName, event.input) &&
            isFailedCommandResult(toolResult.message)
          ) {
            const action = getToolAction(event.toolName, event.input);
            onTextDelta(
              `\n[tool loop detected] ${action} was retried after the same command already failed. Stop rerunning it unchanged and choose a new concrete step.\n`
            );
            dispatch({ type: "complete" });
            return { status: "completed" };
          }
          if (didApplyFileMutation(event.toolName, event.input, toolResult.message)) {
            filesystemMutationRevision += 1;
            loopCorrection = "";
          }
          if (toolResult.reviewMode) {
            dispatch({ type: "suspended" });
            return {
              status: "suspended",
              resume: async (toolResultMessage: string) => {
                if (didApplyFileMutation(event.toolName, event.input, toolResultMessage)) {
                  filesystemMutationRevision += 1;
                  loopCorrection = "";
                }
                const nextToolResults = [
                  ...accumulatedToolResults,
                  ...toolResults,
                  `[tool_result] ${event.toolName}\n${toolResultMessage}`.trim(),
                ];
                const nextPrompt = buildRoundPrompt(
                  task,
                  nextToolResults,
                  loopCorrection
                );
                return runRounds(
                  nextPrompt,
                  repeatedToolCallCount,
                  loopCorrection,
                  nextToolResults,
                  toolStepsUsed
                );
              },
            };
          }
          toolResults.push(
            `[tool_result] ${event.toolName}\n${toolResult.message}`.trim()
          );
          continue;
        }

        if (event.type === "usage") {
          dispatch({
            type: "usage",
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
          });
          continue;
        }

        if (event.type === "done") {
          completed = true;
          break;
        }
      }

      if (completed) {
        break;
      }
    }

    if (!sawToolCall) {
      dispatch({ type: "complete" });
      return { status: "completed" };
    }

    accumulatedToolResults = [...accumulatedToolResults, ...toolResults];
    const nextPrompt = buildRoundPrompt(task, accumulatedToolResults, loopCorrection);
    return runRounds(
      nextPrompt,
      repeatedToolCallCount,
      loopCorrection,
      accumulatedToolResults,
      toolStepsUsed
    );
  };

  try {
    return await runRounds(query, new Map<string, number>(), "", [], 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatch({ type: "fail", message });
    onError(message);
    return { status: "completed" };
  }
};
