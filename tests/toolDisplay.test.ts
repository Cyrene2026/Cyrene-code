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

  test("leaves unknown names unchanged", () => {
    expect(normalizeToolDisplayText("Running something_else...", AMAP_TOOLS as any)).toBe(
      "Running something_else..."
    );
  });
});
