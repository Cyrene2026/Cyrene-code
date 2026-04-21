import { describe, expect, test } from "bun:test";
import {
  canonicalizeToolNameForDisplay,
  normalizeToolDisplayText,
} from "../src/frontend/components/v2/toolDisplay";

const AMAP_TOOLS = [
  {
    id: "amap-maps.maps_direction_transit_integrated",
    name: "maps_direction_transit_integrated",
    label: "maps_direction_transit_integrated",
  },
  {
    id: "amap-maps.maps_geo",
    name: "maps_geo",
    label: "maps_geo",
  },
] as const;

describe("toolDisplay", () => {
  test("canonicalizes fuzzy MCP tool names for display", () => {
    expect(
      canonicalizeToolNameForDisplay("mapsdirectiontransit_integrated", AMAP_TOOLS as any)
    ).toBe("maps_direction_transit_integrated");
  });

  test("normalizes running tool status text", () => {
    expect(
      normalizeToolDisplayText(
        "Running mapsdirectiontransit_integrated...",
        AMAP_TOOLS as any
      )
    ).toBe("Running maps_direction_transit_integrated...");
  });

  test("normalizes running builtin tool aliases", () => {
    expect(normalizeToolDisplayText("Running outlinefile | cli.py...", [] as any)).toBe(
      "Running outline_file | cli.py..."
    );
  });

  test("normalizes every loose tool status line", () => {
    expect(
      normalizeToolDisplayText(
        [
          "Tool: readrange agent/promptbuilder.py | range content hidden",
          "Tool: outlinefile cli.py | Outline for cli.py",
          "❯ Tool:readrange cli.py | range content hidden",
        ].join("\n"),
        [] as any
      )
    ).toBe(
      [
        "Tool: read_range agent/promptbuilder.py | range content hidden",
        "Tool: outline_file cli.py | Outline for cli.py",
        "❯ Tool: read_range cli.py | range content hidden",
      ].join("\n")
    );
  });

  test("normalizes tool result header text", () => {
    expect(
      normalizeToolDisplayText(
        [
          "[tool result] mapsdirectiontransit_integrated",
          "{",
          '  "ok": true',
          "}",
        ].join("\n"),
        AMAP_TOOLS as any
      )
    ).toBe(
      [
        "[tool result] maps_direction_transit_integrated",
        "{",
        '  "ok": true',
        "}",
      ].join("\n")
    );
  });

  test("normalizes summarized tool lines with builtin canonical names", () => {
    expect(
      normalizeToolDisplayText(
        "Tool: outlinefile runagent.py | Outline for run_agent.py",
        [] as any
      )
    ).toBe("Tool: outline_file runagent.py | Outline for run_agent.py");
  });

  test("normalizes summarized tool error lines with builtin canonical names", () => {
    expect(
      normalizeToolDisplayText(
        "Tool error: lspdocumentsymbols src/entrypoints/cli.tsx | LSP config error",
        [] as any
      )
    ).toBe(
      "Tool error: lsp_document_symbols src/entrypoints/cli.tsx | LSP config error"
    );
  });

  test("leaves unknown names unchanged", () => {
    expect(normalizeToolDisplayText("Running something_else...", AMAP_TOOLS as any)).toBe(
      "Running something_else..."
    );
  });
});
