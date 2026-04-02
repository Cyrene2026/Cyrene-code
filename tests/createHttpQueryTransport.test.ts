import { describe, expect, test } from "bun:test";
import {
  FILE_TOOL,
  TOOL_USAGE_SYSTEM_PROMPT,
} from "../src/infra/http/createHttpQueryTransport";

describe("createHttpQueryTransport tool exposure", () => {
  test("exports expanded file tool schema", () => {
    const actionEnum = FILE_TOOL.function.parameters.properties.action.enum;

    expect(actionEnum).toContain("run_command");
    expect(actionEnum).toContain("stat_path");
    expect(actionEnum).toContain("find_files");
    expect(actionEnum).toContain("search_text");
    expect(actionEnum).toContain("copy_path");
    expect(actionEnum).toContain("move_path");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("pattern");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("query");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("destination");
    expect(FILE_TOOL.function.parameters.properties).toHaveProperty("command");
  });

  test("system prompt teaches model about search and command actions", () => {
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("find_files");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("search_text");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("stat_path");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("run_command");
    expect(TOOL_USAGE_SYSTEM_PROMPT).toContain("Avoid repetitive list_dir/read_file probing");
  });
});
