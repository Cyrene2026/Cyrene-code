import { describe, expect, mock, test } from "bun:test";
import { handleProviderModelCommand } from "../src/application/chat/chatProviderModelCommandHandler";
import type { QueryTransport } from "../src/core/query/transport";

describe("handleProviderModelCommand", () => {
  test("supports explicit custom model ids via /model custom <id>", async () => {
    const pushed: string[] = [];
    const synced: Array<{ providerBaseUrl?: string; model?: string } | undefined> = [];
    let currentModel = "gpt-start";
    const queued: Array<() => Promise<void> | void> = [];
    const transport: QueryTransport = {
      getModel: () => currentModel,
      getProvider: () => "https://provider.test/v1",
      setModel: mock(async (model: string) => {
        currentModel = model;
        return {
          ok: true,
          message: `Model switched to: ${model}`,
        };
      }),
      listModels: async () => [],
      listProviders: async () => [],
      setProvider: async () => ({
        ok: true,
        message: "provider switched",
      }),
      refreshModels: async () => ({
        ok: true,
        message: "refreshed",
        models: [],
      }),
      requestStreamUrl: async () => "stream://test",
      stream: async function* () {},
    };

    const handled = handleProviderModelCommand({
      query: "/model custom provider-only-custom-id",
      transport,
      currentProviderKeySource: "CYRENE_API_KEY",
      pushSystemMessage: text => {
        if (typeof text === "string") {
          pushed.push(text);
        }
      },
      clearInput: () => undefined,
      enqueueTask: task => {
        queued.push(task);
      },
      isRepeatedActionInteraction: () => false,
      updateCurrentProviderState: () => undefined,
      updateCurrentModelState: () => undefined,
      syncAuthSelection: async input => {
        synced.push(input);
      },
      resolveProviderKeySource: () => "CYRENE_API_KEY",
      listManualProviderProfileOverrides: () => ({}),
      resolveProviderProfile: () => "custom",
      resolveProviderProfileSource: () => "none" as any,
      openProviderPicker: () => undefined,
      openModelPicker: () => undefined,
    });

    expect(handled).toBe(true);
    expect(queued).toHaveLength(1);

    await queued[0]?.();

    expect(transport.setModel).toHaveBeenCalledWith("provider-only-custom-id");
    expect(currentModel).toBe("provider-only-custom-id");
    expect(synced).toEqual([
      {
        providerBaseUrl: "https://provider.test/v1",
        model: "provider-only-custom-id",
      },
    ]);
    expect(pushed).toEqual(["Model switched to: provider-only-custom-id"]);
  });
});
