import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthRuntime } from "../src/infra/auth/authRuntime";
import type {
  ManagedAuthEnvName,
  UserScopedApiKeyStore,
} from "../src/infra/auth/userScopedApiKeyStore";
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
): UserScopedApiKeyStore & {
  current: (envName?: ManagedAuthEnvName) => string | undefined;
  currentAll: () => Partial<Record<ManagedAuthEnvName, string>>;
} => {
  const values: Partial<Record<ManagedAuthEnvName, string>> = initialValue
    ? { CYRENE_API_KEY: initialValue }
    : {};
  return {
    getTarget: async () => ({
      kind: "shell_rc_block",
      shell: "zsh",
      path: "/Users/test/.zshrc",
      label: "zsh profile",
      managedByCyrene: true,
    }),
    read: async (envName = "CYRENE_API_KEY") => values[envName],
    readAll: async () => ({ ...values }),
    save: async (apiKey: string, envName = "CYRENE_API_KEY") => {
      values[envName] = apiKey;
      return {
        kind: "shell_rc_block",
        shell: "zsh",
        path: "/Users/test/.zshrc",
        label: "zsh profile",
        managedByCyrene: true,
      };
    },
    clear: async (envName?: ManagedAuthEnvName) => {
      if (envName) {
        delete values[envName];
      } else {
        for (const key of Object.keys(values) as ManagedAuthEnvName[]) {
          delete values[key];
        }
      }
      return {
        kind: "shell_rc_block",
        shell: "zsh",
        path: "/Users/test/.zshrc",
        label: "zsh profile",
        managedByCyrene: true,
      };
    },
    current: (envName = "CYRENE_API_KEY") => values[envName],
    currentAll: () => ({ ...values }),
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

  test("validateLoginInput rejects quoted api keys and hidden whitespace", async () => {
    const appRoot = await createTempRoot();
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: createMemoryApiKeyStore(),
    });

    const quoted = await runtime.validateLoginInput({
      providerBaseUrl: "https://provider.test/v1",
      apiKey: `"sk-test"`,
    });
    expect(quoted.ok).toBe(false);
    expect(quoted.message).toContain("surrounding quotes");

    const spaced = await runtime.validateLoginInput({
      providerBaseUrl: "https://provider.test/v1",
      apiKey: "sk-test \n next",
    });
    expect(spaced.ok).toBe(false);
    expect(spaced.message).toContain("control characters");
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
    expect(store.current("CYRENE_OPENAI_API_KEY")).toBe("sk-live");
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

  test("saveLogin persists the normalized api key, matching the validated value", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    const fetchProviderModelCatalogImpl = mock(
      async (options: { apiKey: string }) => {
        expect(options.apiKey).toBe("k-ant-oat01-demo_key-XYZ123");
        return {
          providerBaseUrl: "https://api.anthropic.com",
          models: ["claude-3-7-sonnet-latest"],
          selectedModel: "claude-3-7-sonnet-latest",
        };
      }
    );
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: store,
      fetchProviderModelCatalogImpl: fetchProviderModelCatalogImpl as any,
      createHttpTransport: mock((_options?: { env?: NodeJS.ProcessEnv }) =>
        createStubTransport("claude-3-7-sonnet-latest", "https://api.anthropic.com")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["claude-3-7-sonnet-latest"],
        defaultModel: "claude-3-7-sonnet-latest",
        lastUsedModel: "claude-3-7-sonnet-latest",
        providerBaseUrl: "https://api.anthropic.com",
        providers: ["https://api.anthropic.com"],
        providerProfiles: {},
      })),
    });

    const result = await runtime.saveLogin({
      providerBaseUrl: "anthropic",
      apiKey: "  k-ant-oat01-demo_key-XYZ123  ",
      model: "claude-3-7-sonnet-latest",
    });

    expect(result.ok).toBe(true);
    expect(store.current("CYRENE_ANTHROPIC_API_KEY")).toBe(
      "k-ant-oat01-demo_key-XYZ123"
    );
    expect(await runtime.getSavedApiKey("https://api.anthropic.com")).toBe(
      "k-ant-oat01-demo_key-XYZ123"
    );
  });

  test("saveLogin uses provider profile overrides to validate relays and bind remembered keys", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    const fetchProviderModelCatalogImpl = mock(
      async (options: { baseUrl: string; familyOverride?: string }) => {
        expect(options.baseUrl).toBe("https://relay.test/v1");
        expect(options.familyOverride).toBe("anthropic");
        return {
          providerBaseUrl: "https://relay.test/v1",
          models: ["claude-relay"],
          selectedModel: "claude-relay",
        };
      }
    );
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: store,
      fetchProviderModelCatalogImpl: fetchProviderModelCatalogImpl as any,
      createHttpTransport: mock((_options?: { env?: NodeJS.ProcessEnv }) =>
        createStubTransport("claude-relay", "https://relay.test/v1")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["claude-relay"],
        defaultModel: "claude-relay",
        lastUsedModel: "claude-relay",
        providerBaseUrl: "https://relay.test/v1",
        providers: ["https://relay.test/v1"],
        providerProfiles: {
          "https://relay.test/v1": "anthropic" as const,
        },
      })),
    });

    const result = await runtime.saveLogin({
      providerBaseUrl: "https://relay.test/v1",
      apiKey: "relay-anthropic-key",
      model: "claude-relay",
    });

    expect(result.ok).toBe(true);
    expect(store.current("CYRENE_ANTHROPIC_API_KEY")).toBe(
      "relay-anthropic-key"
    );
    expect(await runtime.getSavedApiKey("https://relay.test/v1")).toBe(
      "relay-anthropic-key"
    );
  });

  test("saveLogin overrides explicit launch env for the current run", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore("persisted-old-key");
    const createHttpTransport = mock((options?: { env?: NodeJS.ProcessEnv }) =>
      createStubTransport(
        options?.env?.CYRENE_MODEL ?? "gpt-next",
        options?.env?.CYRENE_BASE_URL ?? "https://next-provider.test/v1"
      )
    );
    const runtime = createAuthRuntime({
      appRoot,
      env: {
        CYRENE_API_KEY: "launch-key",
        CYRENE_BASE_URL: "https://launch-provider.test/v1",
        CYRENE_MODEL: "gpt-launch",
      } as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: createHttpTransport as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      fetchProviderModelCatalogImpl: mock(async () => ({
        providerBaseUrl: "https://next-provider.test/v1",
        models: ["gpt-next"],
        selectedModel: "gpt-next",
      })),
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-next"],
        defaultModel: "gpt-next",
        lastUsedModel: "gpt-next",
        providerBaseUrl: "https://next-provider.test/v1",
        providers: ["https://next-provider.test/v1"],
        providerProfiles: {},
      })),
    });

    const result = await runtime.saveLogin({
      providerBaseUrl: "https://next-provider.test/v1",
      apiKey: "new-key",
      model: "gpt-next",
    });

    expect(result.ok).toBe(true);
    expect(result.status.mode).toBe("http");
    expect(result.status.credentialSource).toBe("user_env");
    expect(result.status.provider).toBe("https://next-provider.test/v1");
    expect(result.status.model).toBe("gpt-next");
    expect(result.message).toContain("Switched the current run to the newly saved credential");
    expect(result.message).toContain(
      "Future launches from this same shell may still use CYRENE_BASE_URL, CYRENE_MODEL"
    );
    expect(createHttpTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CYRENE_OPENAI_API_KEY: "new-key",
          CYRENE_BASE_URL: "https://next-provider.test/v1",
          CYRENE_MODEL: "gpt-next",
        }),
      })
    );
  });

  test("saveLogin warns when a stale provider-specific launch key would shadow the saved login on relaunch", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    const runtime = createAuthRuntime({
      appRoot,
      env: {
        CYRENE_BASE_URL: "https://provider.test/v1",
        CYRENE_MODEL: "gpt-4o-mini",
        CYRENE_OPENAI_API_KEY: "old-key",
      } as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: mock((_options?: { env?: NodeJS.ProcessEnv }) =>
        createStubTransport("gpt-4.1", "https://provider.test/v1")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      fetchProviderModelCatalogImpl: mock(async () => ({
        providerBaseUrl: "https://provider.test/v1",
        models: ["gpt-4o-mini", "gpt-4.1"],
        selectedModel: "gpt-4.1",
      })),
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-4o-mini", "gpt-4.1"],
        defaultModel: "gpt-4o-mini",
        lastUsedModel: "gpt-4o-mini",
        providerBaseUrl: "https://provider.test/v1",
        providers: ["https://provider.test/v1"],
        providerProfiles: {},
      })),
    });

    const result = await runtime.saveLogin({
      providerBaseUrl: "https://provider.test/v1",
      apiKey: "new-key",
      model: "gpt-4.1",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain(
      "Future launches from this same shell may still use CYRENE_MODEL, CYRENE_OPENAI_API_KEY"
    );
  });

  test("syncSelection keeps auth status and rebuilt transports aligned with provider/model switches", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    await store.save("openai-user-key", "CYRENE_OPENAI_API_KEY");
    await store.save("anthropic-user-key", "CYRENE_ANTHROPIC_API_KEY");
    const createHttpTransport = mock((options?: { env?: NodeJS.ProcessEnv }) =>
      createStubTransport(
        options?.env?.CYRENE_MODEL ?? "claude-3-7-sonnet-latest",
        options?.env?.CYRENE_BASE_URL ?? "https://api.anthropic.com"
      )
    );
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: createHttpTransport as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-4o-mini", "claude-3-7-sonnet-latest"],
        defaultModel: "gpt-4o-mini",
        lastUsedModel: "gpt-4o-mini",
        providerBaseUrl: "https://api.openai.com/v1",
        providers: ["https://api.openai.com/v1", "https://api.anthropic.com"],
        providerProfiles: {},
      })),
    });

    expect(await runtime.getStatus()).toMatchObject({
      provider: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      credentialSource: "user_env",
    });

    const nextStatus = await runtime.syncSelection({
      providerBaseUrl: "https://api.anthropic.com",
      model: "claude-3-7-sonnet-latest",
    });

    expect(nextStatus).toMatchObject({
      provider: "https://api.anthropic.com",
      model: "claude-3-7-sonnet-latest",
      credentialSource: "user_env",
    });

    await runtime.buildTransport();
    expect(createHttpTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CYRENE_BASE_URL: "https://api.anthropic.com",
          CYRENE_MODEL: "claude-3-7-sonnet-latest",
          CYRENE_ANTHROPIC_API_KEY: "anthropic-user-key",
        }),
      })
    );
  });

  test("buildTransport includes remembered provider-specific keys so provider switching can reuse them", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    await store.save("openai-key", "CYRENE_OPENAI_API_KEY");
    await store.save("anthropic-key", "CYRENE_ANTHROPIC_API_KEY");
    const createHttpTransport = mock((_options?: { env?: NodeJS.ProcessEnv }) =>
      createStubTransport("gpt-openai", "https://api.openai.com/v1")
    );
    const runtime = createAuthRuntime({
      appRoot,
      env: {
        CYRENE_BASE_URL: "https://api.openai.com/v1",
        CYRENE_MODEL: "gpt-openai",
      } as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: createHttpTransport as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["gpt-openai"],
        defaultModel: "gpt-openai",
        lastUsedModel: "gpt-openai",
        providerBaseUrl: "https://api.openai.com/v1",
        providers: ["https://api.openai.com/v1", "https://api.anthropic.com"],
        providerProfiles: {},
      })),
    });

    await runtime.buildTransport();

    expect(createHttpTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CYRENE_OPENAI_API_KEY: "openai-key",
          CYRENE_ANTHROPIC_API_KEY: "anthropic-key",
        }),
      })
    );
    expect(await runtime.getSavedApiKey("https://api.anthropic.com")).toBe(
      "anthropic-key"
    );
  });

  test("status resolves relay remembered keys from provider profile overrides", async () => {
    const appRoot = await createTempRoot();
    const store = createMemoryApiKeyStore();
    await store.save("relay-key", "CYRENE_ANTHROPIC_API_KEY");
    const runtime = createAuthRuntime({
      appRoot,
      env: {} as NodeJS.ProcessEnv,
      apiKeyStore: store,
      createHttpTransport: mock((_options?: { env?: NodeJS.ProcessEnv }) =>
        createStubTransport("claude-relay", "https://relay.test/v1")
      ) as any,
      createLocalTransport: mock(() => createStubTransport("local-core", "local-core")) as any,
      loadModelYamlImpl: mock(async () => ({
        models: ["claude-relay"],
        defaultModel: "claude-relay",
        lastUsedModel: "claude-relay",
        providerBaseUrl: "https://relay.test/v1",
        providers: ["https://relay.test/v1"],
        providerProfiles: {
          "https://relay.test/v1": "anthropic" as const,
        },
      })),
    });

    const status = await runtime.getStatus();

    expect(status.mode).toBe("http");
    expect(status.credentialSource).toBe("user_env");
    expect(status.provider).toBe("https://relay.test/v1");
    expect(await runtime.getSavedApiKey("https://relay.test/v1")).toBe(
      "relay-key"
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
    expect(result.message).toContain("Reverted to the explicit CYRENE_API_KEY");
    expect(store.currentAll()).toEqual({});
  });
});
