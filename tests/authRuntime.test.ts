import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthRuntime } from "../src/infra/auth/authRuntime";
import type { UserScopedApiKeyStore } from "../src/infra/auth/userScopedApiKeyStore";
import type { QueryTransport } from "../src/core/query/transport";

const tempRoots: string[] = [];

const createTempRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "cyrene-auth-runtime-"));
  tempRoots.push(root);
  return root;
};

const createStubTransport = (
  model: string,
  provider: string
): QueryTransport => ({
  getModel: () => model,
  getProvider: () => provider,
  setModel: async nextModel => ({ ok: true, message: `model ${nextModel}` }),
  listModels: async () => [model],
  listProviders: async () => [provider],
  setProvider: async nextProvider => ({
    ok: true,
    message: `provider ${nextProvider}`,
    currentProvider: nextProvider,
    providers: [nextProvider],
    models: [model],
  }),
  refreshModels: async () => ({ ok: true, message: "refreshed", models: [model] }),
  requestStreamUrl: async query => `stream://${query}`,
  stream: async function* () {},
});

const createMemoryApiKeyStore = (
  initialValue?: string
): UserScopedApiKeyStore & { current: () => string | undefined } => {
  let value = initialValue;
  return {
    getTarget: async () => ({
      kind: "shell_rc_block",
      shell: "zsh",
      path: "/Users/test/.zshrc",
      label: "zsh profile",
      managedByCyrene: true,
    }),
    read: async () => value,
    save: async (apiKey: string) => {
      value = apiKey;
      return {
        kind: "shell_rc_block",
        shell: "zsh",
        path: "/Users/test/.zshrc",
        label: "zsh profile",
        managedByCyrene: true,
      };
    },
    clear: async () => {
      value = undefined;
      return {
        kind: "shell_rc_block",
        shell: "zsh",
        path: "/Users/test/.zshrc",
        label: "zsh profile",
        managedByCyrene: true,
      };
    },
    current: () => value,
  };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path =>
      rm(path, { recursive: true, force: true }).catch(() => undefined)
    )
  );
  mock.restore();
});

describe("createAuthRuntime", () => {
  test("prefers explicit process env over managed user credentials", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore("user-key");
    const runtime = createAuthRuntime({
      appRoot,
      env: {
        CYRENE_API_KEY: "process-key",
        CYRENE_BASE_URL: "https://process-provider.test/v1",
        CYRENE_MODEL: "gpt-process",
      } as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: mock((_options?: unknown) =>
        createStubTransport("gpt-process", "https://process-provider.test/v1")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-stored"],
        defaultModel: "gpt-stored",
        lastUsedModel: "gpt-stored",
        providerBaseUrl: "https://stored-provider.test/v1",
        providers: ["https://stored-provider.test/v1"],
        providerProfiles: {},
      })),
    });

    const status = await runtime.getStatus();

    expect(status.mode).toBe("http");
    expect(status.credentialSource).toBe("process_env");
    expect(status.provider).toBe("https://process-provider.test/v1");
    expect(status.model).toBe("gpt-process");
  });

  test("boots directly into HTTP mode from user-scoped key plus stored provider metadata", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore("user-key");
    const createHttpTransport = mock((_options?: { env?: NodeJS.ProcessEnv }) =>
      createStubTransport("gpt-stored", "https://stored-provider.test/v1")
    );
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: createHttpTransport as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-stored"],
        defaultModel: "gpt-stored",
        lastUsedModel: "gpt-stored",
        providerBaseUrl: "https://stored-provider.test/v1",
        providers: ["https://stored-provider.test/v1"],
        providerProfiles: {},
      })),
    });

    const status = await runtime.getStatus();
    const transport = await runtime.buildTransport();

    expect(status.mode).toBe("http");
    expect(status.credentialSource).toBe("user_env");
    expect(status.provider).toBe("https://stored-provider.test/v1");
    expect(transport.getProvider()).toBe("https://stored-provider.test/v1");
    expect(createHttpTransport).toHaveBeenCalledTimes(1);
  });

  test("validateLoginInput rejects malformed provider URLs before remote validation", async () => {
    const appRoot = await createTempRoot();
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: createMemoryApiKeyStore(),
      fetchProviderModelCatalogImpl: mock(async () => ({
        providerBaseUrl: "https://unused.test/v1",
        models: ["gpt-test"],
        selectedModel: "gpt-test",
      })),
    });

    const result = await runtime.validateLoginInput({
      providerBaseUrl: "not a url",
      apiKey: "sk-test",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("URL");
  });

  test("validateLoginInput accepts provider presets and normalizes before validation", async () => {
    const appRoot = await createTempRoot();
    const fetchProviderModelCatalogImpl = mock(async (options: { baseUrl: string }) => {
      expect(options.baseUrl).toBe("https://api.anthropic.com");
      return {
        providerBaseUrl: "https://api.anthropic.com",
        models: ["claude-3-7-sonnet-latest"],
        selectedModel: "claude-3-7-sonnet-latest",
      };
    });
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: createMemoryApiKeyStore(),
      fetchProviderModelCatalogImpl: fetchProviderModelCatalogImpl as any,
    });

    const result = await runtime.validateLoginInput({
      providerBaseUrl: "anthropic",
      apiKey: "sk-test",
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedProviderBaseUrl).toBe("https://api.anthropic.com");
  });

  test("saveLogin persists provider metadata, saves the key, and switches to HTTP immediately", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    let savedModelState:
      | {
          models: string[];
          defaultModel?: string;
          lastUsedModel?: string;
          providerBaseUrl?: string;
          providers: string[];
          providerProfiles: Record<string, "openai" | "gemini" | "anthropic">;
        }
      | undefined;
    const saveModelYamlImpl = mock(
      async (
        models: string[],
        defaultModel: string,
        options?: {
          lastUsedModel?: string;
          providerBaseUrl?: string;
          providers?: string[];
          providerProfiles?: Record<
            string,
            "openai" | "gemini" | "anthropic"
          >;
        }
      ) => {
        savedModelState = {
          models,
          defaultModel,
          lastUsedModel: options?.lastUsedModel,
          providerBaseUrl: options?.providerBaseUrl,
          providers: options?.providers ?? [],
          providerProfiles: options?.providerProfiles ?? {},
        };
      }
    );
    const fetchProviderModelCatalogImpl = mock(async () => ({
      providerBaseUrl: "https://provider.test/v1",
      models: ["gpt-a", "gpt-b"],
      selectedModel: "gpt-b",
    }));
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: store,
      saveModelYamlImpl,
      fetchProviderModelCatalogImpl,
      createHttpTransport: mock((_options?: { env?: NodeJS.ProcessEnv }) =>
        createStubTransport("gpt-b", "https://provider.test/v1")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => {
        if (!savedModelState) {
          throw new Error("missing");
        }
        return savedModelState;
      }),
    });

    const result = await runtime.saveLogin({
      providerBaseUrl: "https://provider.test/v1",
      apiKey: "sk-live",
      model: "gpt-b",
    });

    expect(result.ok).toBe(true);
    expect(result.status.mode).toBe("http");
    expect(result.status.credentialSource).toBe("user_env");
    expect(store.current()).toBe("sk-live");
    expect(saveModelYamlImpl).toHaveBeenCalledWith(
      ["gpt-a", "gpt-b"],
      "gpt-b",
      expect.objectContaining({
        providerBaseUrl: "https://provider.test/v1",
        lastUsedModel: "gpt-b",
      }),
      appRoot,
      expect.any(Object)
    );
  });

  test("logout keeps explicit launch env active for the current run", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore("managed-key");
    const runtime = createAuthRuntime({
      appRoot,
      env: {
        CYRENE_API_KEY: "process-key",
        CYRENE_BASE_URL: "https://provider.test/v1",
        CYRENE_MODEL: "gpt-run",
      } as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: mock((_options?: { env?: NodeJS.ProcessEnv }) =>
        createStubTransport("gpt-run", "https://provider.test/v1")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-run"],
        defaultModel: "gpt-run",
        lastUsedModel: "gpt-run",
        providerBaseUrl: "https://provider.test/v1",
        providers: ["https://provider.test/v1"],
        providerProfiles: {},
      })),
    });

    const result = await runtime.logout();

    expect(result.ok).toBe(true);
    expect(result.status.mode).toBe("http");
    expect(result.status.credentialSource).toBe("process_env");
    expect(result.message).toContain("still active for this run");
    expect(store.current()).toBeUndefined();
  });
});
