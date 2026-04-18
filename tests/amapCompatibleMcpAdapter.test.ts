import { describe, expect, test } from "bun:test";
import {
  AmapCompatibleMcpAdapter,
  isAmapCompatibleServer,
} from "../src/core/mcp/adapters/compat/amapCompatibleMcpAdapter";

describe("AmapCompatibleMcpAdapter", () => {
  test("detects the official amap npx package and exposes its tools", () => {
    const adapter = new AmapCompatibleMcpAdapter(
      {
        id: "amap-maps",
        transport: "stdio",
        label: "Amap",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@amap/amap-maps-mcp-server"],
        env: {
          AMAP_MAPS_API_KEY: "demo-key",
        },
        tools: [],
      },
      fetch as typeof fetch
    );

    expect(
      isAmapCompatibleServer({
        id: "amap-maps",
        transport: "stdio",
        label: "Amap",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@amap/amap-maps-mcp-server"],
        tools: [],
      })
    ).toBe(true);
    expect(adapter.descriptor.health).toBe("online");
    expect(adapter.descriptor.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "maps_direction_driving" }),
        expect.objectContaining({ name: "maps_weather" }),
      ])
    );
  });

  test("calls the AMap HTTP API through the compatibility layer", async () => {
    const fetchCalls: string[] = [];
    const adapter = new AmapCompatibleMcpAdapter(
      {
        id: "amap-maps",
        transport: "stdio",
        label: "Amap",
        enabled: true,
        aliases: [],
        command: "npx",
        args: ["-y", "@amap/amap-maps-mcp-server"],
        env: {
          AMAP_MAPS_API_KEY: "demo-key",
        },
        tools: [],
      },
      (async (input: string | URL | Request) => {
        fetchCalls.push(String(input));
        return new Response(
          JSON.stringify({
            status: "1",
            route: {
              paths: [{ distance: "1000", duration: "600" }],
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        );
      }) as typeof fetch
    );

    const result = await adapter.handleToolCall("maps_direction_driving", {
      origin: "116.4074,39.9042",
      destination: "121.4737,31.2304",
    });

    expect(fetchCalls[0]).toContain("/v3/direction/driving");
    expect(fetchCalls[0]).toContain("origin=116.4074%2C39.9042");
    expect(fetchCalls[0]).toContain("destination=121.4737%2C31.2304");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("paths");
  });
});
