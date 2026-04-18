import type { McpConfiguredServer } from "../../loadMcpConfig";
import type {
  McpHandleResult,
  McpServerAdapter,
  McpServerDescriptor,
} from "../../runtimeTypes";
import type { PendingReviewItem } from "../../toolTypes";
import {
  buildRemoteToolDescriptors,
  formatRemoteToolCallResult,
  type RemoteMcpTool,
} from "../remote/mcpRemoteProtocol";

const AMAP_PACKAGE_NAME = "@amap/amap-maps-mcp-server";
const AMAP_SERVER_INFO = {
  name: "mcp-server/amap-maps-compatible",
  version: "0.1.0",
};
const AMAP_DISCOVERY_TAGS = [
  "amap",
  "高德",
  "高德地图",
  "地图",
  "路线规划",
  "路径规划",
  "导航",
  "地理编码",
  "逆地理编码",
  "天气",
  "poi",
];

const AMAP_TOOLS: RemoteMcpTool[] = [
  {
    name: "maps_regeocode",
    description: "Convert AMap longitude/latitude coordinates into an address.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Longitude,latitude" },
      },
      required: ["location"],
    },
  },
  {
    name: "maps_geo",
    description: "Convert a structured address into coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Structured address" },
        city: { type: "string", description: "Optional city hint" },
      },
      required: ["address"],
    },
  },
  {
    name: "maps_ip_location",
    description: "Locate an IP address.",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "IP address" },
      },
      required: ["ip"],
    },
  },
  {
    name: "maps_weather",
    description: "Fetch weather by city name or adcode.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name or adcode" },
      },
      required: ["city"],
    },
  },
  {
    name: "maps_search_detail",
    description: "Fetch POI detail by POI id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "POI id" },
      },
      required: ["id"],
    },
  },
  {
    name: "maps_bicycling",
    description: "Plan a bicycling route.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin longitude,latitude" },
        destination: { type: "string", description: "Destination longitude,latitude" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "maps_direction_walking",
    description: "Plan a walking route.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin longitude,latitude" },
        destination: { type: "string", description: "Destination longitude,latitude" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "maps_direction_driving",
    description: "Plan a driving route.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin longitude,latitude" },
        destination: { type: "string", description: "Destination longitude,latitude" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "maps_direction_transit_integrated",
    description: "Plan an integrated public transit route.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin longitude,latitude" },
        destination: { type: "string", description: "Destination longitude,latitude" },
        city: { type: "string", description: "Origin city" },
        cityd: { type: "string", description: "Destination city" },
      },
      required: ["origin", "destination", "city", "cityd"],
    },
  },
  {
    name: "maps_distance",
    description: "Measure distance between one or more origins and a destination.",
    inputSchema: {
      type: "object",
      properties: {
        origins: { type: "string", description: "Origin coordinates, pipe-separated" },
        destination: { type: "string", description: "Destination longitude,latitude" },
        type: { type: "string", description: "Distance type" },
      },
      required: ["origins", "destination"],
    },
  },
  {
    name: "maps_text_search",
    description: "Search POIs by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "Search keywords" },
        city: { type: "string", description: "Optional city filter" },
        types: { type: "string", description: "Optional POI type" },
        citylimit: { type: "boolean", description: "Limit to the specified city" },
      },
      required: ["keywords"],
    },
  },
  {
    name: "maps_around_search",
    description: "Search nearby POIs around a coordinate.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Center longitude,latitude" },
        radius: { type: "string", description: "Search radius in meters" },
        keywords: { type: "string", description: "Optional keywords" },
      },
      required: ["location"],
    },
  },
];

type FetchLike = typeof fetch;

const normalizeObjectInput = (input: unknown) =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

const getString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getBooleanString = (value: unknown) =>
  typeof value === "boolean" ? String(value) : getString(value);

const addParams = (
  url: URL,
  params: Record<string, string | undefined>,
  apiKey: string
) => {
  url.searchParams.set("key", apiKey);
  url.searchParams.set("source", "cyrene_compat");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
};

const buildRequest = (toolName: string, input: Record<string, unknown>, apiKey: string) => {
  const url = (() => {
    switch (toolName) {
      case "maps_regeocode": {
        const next = new URL("https://restapi.amap.com/v3/geocode/regeo");
        addParams(next, { location: getString(input.location) }, apiKey);
        return next;
      }
      case "maps_geo": {
        const next = new URL("https://restapi.amap.com/v3/geocode/geo");
        addParams(
          next,
          {
            address: getString(input.address),
            city: getString(input.city),
          },
          apiKey
        );
        return next;
      }
      case "maps_ip_location": {
        const next = new URL("https://restapi.amap.com/v3/ip");
        addParams(next, { ip: getString(input.ip) }, apiKey);
        return next;
      }
      case "maps_weather": {
        const next = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
        addParams(
          next,
          {
            city: getString(input.city),
            extensions: "all",
          },
          apiKey
        );
        return next;
      }
      case "maps_search_detail": {
        const next = new URL("https://restapi.amap.com/v3/place/detail");
        addParams(next, { id: getString(input.id) }, apiKey);
        return next;
      }
      case "maps_bicycling": {
        const next = new URL("https://restapi.amap.com/v4/direction/bicycling");
        addParams(
          next,
          {
            origin: getString(input.origin),
            destination: getString(input.destination),
          },
          apiKey
        );
        return next;
      }
      case "maps_direction_walking": {
        const next = new URL("https://restapi.amap.com/v3/direction/walking");
        addParams(
          next,
          {
            origin: getString(input.origin),
            destination: getString(input.destination),
          },
          apiKey
        );
        return next;
      }
      case "maps_direction_driving": {
        const next = new URL("https://restapi.amap.com/v3/direction/driving");
        addParams(
          next,
          {
            origin: getString(input.origin),
            destination: getString(input.destination),
          },
          apiKey
        );
        return next;
      }
      case "maps_direction_transit_integrated": {
        const next = new URL("https://restapi.amap.com/v3/direction/transit/integrated");
        addParams(
          next,
          {
            origin: getString(input.origin),
            destination: getString(input.destination),
            city: getString(input.city),
            cityd: getString(input.cityd),
          },
          apiKey
        );
        return next;
      }
      case "maps_distance": {
        const next = new URL("https://restapi.amap.com/v3/distance");
        addParams(
          next,
          {
            origins: getString(input.origins),
            destination: getString(input.destination),
            type: getString(input.type),
          },
          apiKey
        );
        return next;
      }
      case "maps_text_search": {
        const next = new URL("https://restapi.amap.com/v3/place/text");
        addParams(
          next,
          {
            keywords: getString(input.keywords),
            city: getString(input.city),
            types: getString(input.types),
            citylimit: getBooleanString(input.citylimit),
          },
          apiKey
        );
        return next;
      }
      case "maps_around_search": {
        const next = new URL("https://restapi.amap.com/v3/place/around");
        addParams(
          next,
          {
            location: getString(input.location),
            radius: getString(input.radius),
            keywords: getString(input.keywords),
          },
          apiKey
        );
        return next;
      }
      default:
        return null;
    }
  })();

  if (!url) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return url;
};

const validateApiResponse = (toolName: string, payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const result = payload as Record<string, unknown>;
  if (result.status === "0") {
    return {
      content: [
        {
          type: "text",
          text: `${toolName} failed: ${String(result.info ?? result.infocode ?? "unknown error")}`,
        },
      ],
      isError: true,
      structuredContent: payload,
    };
  }
  if (typeof result.errcode === "number" && result.errcode !== 0) {
    return {
      content: [
        {
          type: "text",
          text: `${toolName} failed: ${String(result.errmsg ?? result.errdetail ?? result.errcode)}`,
        },
      ],
      isError: true,
      structuredContent: payload,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: false,
  };
};

export const isAmapCompatibleServer = (server: McpConfiguredServer) =>
  server.transport === "stdio" &&
  Boolean(server.args?.some(arg => arg.trim() === AMAP_PACKAGE_NAME));

export class AmapCompatibleMcpAdapter implements McpServerAdapter {
  descriptor: McpServerDescriptor;

  constructor(
    private readonly server: McpConfiguredServer,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    const hasApiKey = Boolean(getString(server.env?.AMAP_MAPS_API_KEY));
    this.descriptor = {
      id: server.id,
      label: server.label,
      enabled: server.enabled,
      source: "local",
      health: !server.enabled ? "offline" : hasApiKey ? "online" : "error",
      transport: "stdio",
      aliases: [...server.aliases],
      exposure: server.exposure ?? "hinted",
      tags: Array.from(new Set([...(server.tags ?? []), ...AMAP_DISCOVERY_TAGS])),
      hint:
        server.hint ??
        `高德地图 MCP compatibility adapter for ${AMAP_PACKAGE_NAME}; supports 路线规划、地理编码、天气、POI 搜索.`,
      tools: buildRemoteToolDescriptors(server, AMAP_TOOLS),
    };
  }

  private getApiKey() {
    const apiKey = getString(this.server.env?.AMAP_MAPS_API_KEY);
    if (!apiKey) {
      throw new Error("AMAP_MAPS_API_KEY environment variable is not set");
    }
    return apiKey;
  }

  async handleToolCall(toolName: string, input: unknown): Promise<McpHandleResult> {
    if (!this.descriptor.enabled) {
      return {
        ok: false,
        message: `MCP server disabled: ${this.server.id}`,
      };
    }

    try {
      const apiKey = this.getApiKey();
      const url = buildRequest(toolName, normalizeObjectInput(input), apiKey);
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        throw new Error(`AMap request failed: ${response.status} ${response.statusText}`);
      }
      const payload = await response.json();
      this.descriptor.health = "online";
      return formatRemoteToolCallResult(toolName, validateApiResponse(toolName, payload));
    } catch (error) {
      this.descriptor.health = "error";
      return {
        ok: false,
        message: `[tool error] ${toolName}\n${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  listPending(): PendingReviewItem[] {
    return [];
  }

  async approve(id: string): Promise<McpHandleResult> {
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  reject(id: string): McpHandleResult {
    return {
      ok: false,
      message: `Pending operation not found: ${id}`,
    };
  }

  async undoLastMutation(): Promise<McpHandleResult> {
    return {
      ok: false,
      message: `Undo is not supported for MCP server: ${this.server.id}`,
    };
  }
}
