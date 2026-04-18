import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionManager } from "../src/core/extensions";
import { createMcpRuntime } from "../src/core/mcp";
import { createSkillsRuntime } from "../src/core/skills";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
});

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-extension-manager-"));
  tempRoots.push(root);
  await mkdir(join(root, ".cyrene"), { recursive: true });
  const cyreneHome = join(root, "user-home");
  await mkdir(cyreneHome, { recursive: true });
  return { root, cyreneHome };
};

describe("extension manager", () => {
  test("manages skill exposure without changing provider tool surface", async () => {
    const { root, cyreneHome } = await createWorkspace();

    await writeFile(
      join(root, ".cyrene", "skills.yaml"),
      [
        "skills:",
        "  - id: docs-hint",
        "    label: Docs Hint",
        "    prompt: Mention-only docs helper.",
        "    triggers: [docs]",
        "    exposure: hinted",
        "    tags: [documentation]",
        "  - id: repo-map",
        "    label: Repo Map",
        "    prompt: Repo structure helper.",
        "    triggers: [repo, structure]",
        "    exposure: scoped",
        "    tags: [architecture]",
        "  - id: hidden-memory",
        "    label: Hidden Memory",
        "    prompt: Hidden memory helper.",
        "    triggers: [memory]",
        "    exposure: hidden",
      ].join("\n"),
      "utf8"
    );

    const skillsRuntime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome },
    });
    const mcpRuntime = await createMcpRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome },
    });
    const manager = createExtensionManager(mcpRuntime, skillsRuntime);

    const triggerResolution = manager.resolveForQuery("explain this repo structure");
    expect(triggerResolution.skills.map(entry => entry.item.id)).toContain("repo-map");
    expect(triggerResolution.skills.map(entry => entry.item.id)).not.toContain("docs-hint");
    expect(triggerResolution.skills.map(entry => entry.item.id)).not.toContain("hidden-memory");

    const mentionResolution = manager.resolveForQuery("use $docs-hint and continue", {
      manualSkillIds: ["hidden-memory"],
    });
    expect(mentionResolution.skills.map(entry => entry.item.id)).toEqual(
      expect.arrayContaining(["docs-hint", "hidden-memory"])
    );

    mcpRuntime.dispose();
  });

  test("selects managed MCP servers by exposure and query match", async () => {
    const { root, cyreneHome } = await createWorkspace();

    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: docs-index",
        "    transport: filesystem",
        "    workspace_root: .",
        "    exposure: scoped",
        "    tags: [docs, api]",
        "    hint: External docs catalog",
        "    tools:",
        "      - name: fetch_docs",
        "        tags: [docs, reference]",
        "  - id: archive",
        "    transport: filesystem",
        "    enabled: true",
        "    workspace_root: .",
        "    exposure: hidden",
        "    tags: [memory]",
      ].join("\n"),
      "utf8"
    );

    const skillsRuntime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome },
    });
    const mcpRuntime = await createMcpRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome },
    });
    const manager = createExtensionManager(mcpRuntime, skillsRuntime);

    const servers = manager.listMcpServers();
    expect(servers.find(server => server.id === "filesystem")?.exposure).toBe("full");

    const matched = manager.resolveForQuery("need docs api reference");
    expect(matched.mcpServers.map(entry => entry.item.id)).toContain("filesystem");
    expect(matched.mcpServers.map(entry => entry.item.id)).toContain("docs-index");
    expect(matched.mcpServers.map(entry => entry.item.id)).not.toContain("archive");

    mcpRuntime.dispose();
  });

  test("selects amap compatibility server for Chinese map-routing queries", async () => {
    const { root, cyreneHome } = await createWorkspace();

    await writeFile(
      join(root, ".cyrene", "mcp.yaml"),
      [
        "servers:",
        "  - id: amap-maps",
        "    transport: stdio",
        "    trusted: true",
        "    command: npx",
        "    args:",
        "      - -y",
        "      - @amap/amap-maps-mcp-server",
        "    env:",
        "      AMAP_MAPS_API_KEY: demo-key",
      ].join("\n"),
      "utf8"
    );

    const skillsRuntime = await createSkillsRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome },
    });
    const mcpRuntime = await createMcpRuntime(root, {
      cwd: root,
      env: { CYRENE_HOME: cyreneHome },
    });
    const manager = createExtensionManager(mcpRuntime, skillsRuntime);

    const matched = manager.resolveForQuery("调用下高德地图mcp，规划北京到上海路线");
    expect(matched.mcpServers.map(entry => entry.item.id)).toContain("amap-maps");

    mcpRuntime.dispose();
  });
});
