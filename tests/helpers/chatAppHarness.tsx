import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { compressContext } from "../../src/core/session/contextCompression";
import {
  createEmptyMemoryIndex,
  createMessageMemoryInputs,
  deriveFocusFromMemoryIndex,
  getPromptContextFromMemoryIndex,
  rebuildMemoryLookup,
  removePinMemoryEntry,
  upsertMemoryEntries,
  type SessionMemoryIndex,
  type SessionMemoryInput,
} from "../../src/core/session/memoryIndex";
import type { SessionStore } from "../../src/core/session/store";
import type {
  SessionListItem,
  SessionMessage,
  SessionRecord,
} from "../../src/core/session/types";
import type {
  ModelRefreshResult,
  ModelSetResult,
  ProviderSetResult,
  QueryTransport,
} from "../../src/core/query/transport";

export type ChatAppHarnessResult<T> = {
  getLatest: () => T;
  renderer: ReactTestRenderer;
  rerender: () => void;
  cleanup: () => void;
};

export type TestSessionStore = SessionStore & {
  __getRecord: (id: string) => SessionRecord | undefined;
  __listRecords: () => SessionRecord[];
  __getMemoryIndex: (id: string) => SessionMemoryIndex | undefined;
};

export const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

export const renderHookHarness = <T,>(useHook: () => T): ChatAppHarnessResult<T> => {
  let latest: T | null = null;

  const Harness = () => {
    latest = useHook();
    return null;
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });

  return {
    getLatest: () => {
      if (latest === null) {
        throw new Error("Hook value not ready");
      }
      return latest;
    },
    renderer,
    rerender: () => {
      act(() => {
        renderer.update(<Harness />);
      });
    },
    cleanup: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
};

const now = () => new Date("2026-01-01T00:00:00.000Z").toISOString();

const cloneRecord = (record: SessionRecord): SessionRecord => ({
  ...record,
  focus: [...record.focus],
  messages: record.messages.map(message => ({ ...message })),
});

export const createSessionRecord = (
  id: string,
  overrides?: Partial<SessionRecord>
): SessionRecord => ({
  id,
  title: overrides?.title ?? id,
  createdAt: overrides?.createdAt ?? now(),
  updatedAt: overrides?.updatedAt ?? now(),
  summary: overrides?.summary ?? "",
  focus: overrides?.focus ? [...overrides.focus] : [],
  messages: overrides?.messages ? overrides.messages.map(message => ({ ...message })) : [],
});

export const createTestSessionStore = (seed: SessionRecord[] = []): TestSessionStore => {
  const records = new Map(seed.map(record => [record.id, cloneRecord(record)]));
  const memory = new Map<string, SessionMemoryIndex>();
  let counter = seed.length + 1;

  const toListItem = (record: SessionRecord): SessionListItem => ({
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
  });

  const syncRecordWithIndex = (record: SessionRecord, index: SessionMemoryIndex): SessionRecord => {
    return {
      ...record,
      summary: record.summary.trim(),
      focus: deriveFocusFromMemoryIndex(index),
    };
  };

  const ensureIndex = (record: SessionRecord) => {
    const existing = memory.get(record.id);
    if (existing) {
      return existing;
    }
    const rebuilt = upsertMemoryEntries(
      createEmptyMemoryIndex(record.id),
      createMessageMemoryInputs(record.id, record.messages, record.focus)
    );
    memory.set(record.id, rebuilt);
    const nextRecord = syncRecordWithIndex(record, rebuilt);
    records.set(record.id, nextRecord);
    return rebuilt;
  };

  return {
    createSession: async (title?: string) => {
      const id = `session-${counter++}`;
      const record = createSessionRecord(id, { title: title ?? id });
      records.set(id, record);
      memory.set(id, createEmptyMemoryIndex(id, record.updatedAt));
      return cloneRecord(record);
    },
    listSessions: async () =>
      [...records.values()]
        .map(record => {
          const index = ensureIndex(record);
          return syncRecordWithIndex(record, index);
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(toListItem),
    loadSession: async id => {
      const record = records.get(id);
      if (!record) {
        return null;
      }
      const index = ensureIndex(record);
      const next = syncRecordWithIndex(record, index);
      records.set(id, next);
      return cloneRecord(next);
    },
    appendMessage: async (id: string, message: SessionMessage) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const next: SessionRecord = {
        ...record,
        messages: [...record.messages, { ...message }],
        updatedAt: message.createdAt,
        summary: message.role === "system" ? record.summary : "",
      };
      const inputs =
        message.role === "system"
          ? []
          : createMessageMemoryInputs(id, [{ ...message }]).map(input => ({
              ...input,
              sourceMessageRange: {
                start: next.messages.length - 1,
                end: next.messages.length - 1,
              },
            }));
      const nextIndex =
        inputs.length > 0
          ? upsertMemoryEntries(ensureIndex(record), inputs)
          : ensureIndex(record);
      memory.set(id, nextIndex);
      const synced = syncRecordWithIndex(next, nextIndex);
      records.set(id, synced);
      return cloneRecord(synced);
    },
    updateSummary: async (id, summary) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const next = { ...record, summary, updatedAt: now() };
      records.set(id, next);
      return cloneRecord(next);
    },
    addFocus: async (id, note) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const nextIndex = upsertMemoryEntries(ensureIndex(record), [
        {
          kind: "pin",
          text: note,
          priority: 100,
          dedupeKey: `pin:${note.trim().toLowerCase()}`,
        },
      ]);
      memory.set(id, nextIndex);
      const next = syncRecordWithIndex({ ...record, updatedAt: now() }, nextIndex);
      records.set(id, next);
      return cloneRecord(next);
    },
    removeFocus: async (id, index) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const currentIndex = ensureIndex(record);
      const currentFocus = deriveFocusFromMemoryIndex(currentIndex);
      const target = currentFocus[index];
      const nextIndex = target ? removePinMemoryEntry(currentIndex, target) : currentIndex;
      memory.set(id, nextIndex);
      const next = syncRecordWithIndex({ ...record, updatedAt: now() }, nextIndex);
      records.set(id, next);
      return cloneRecord(next);
    },
    getMemoryIndex: async id => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      return ensureIndex(record);
    },
    recordMemory: async (id, entry: SessionMemoryInput) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const nextIndex = upsertMemoryEntries(ensureIndex(record), [entry]);
      memory.set(id, nextIndex);
      const next = syncRecordWithIndex({ ...record, updatedAt: now() }, nextIndex);
      records.set(id, next);
      return cloneRecord(next);
    },
    recordMemories: async (id, entries: SessionMemoryInput[]) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const nextIndex = upsertMemoryEntries(ensureIndex(record), entries);
      memory.set(id, nextIndex);
      const next = syncRecordWithIndex({ ...record, updatedAt: now() }, nextIndex);
      records.set(id, next);
      return cloneRecord(next);
    },
    rebuildMemoryIndex: async id => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const rebuilt = upsertMemoryEntries(
        createEmptyMemoryIndex(id),
        createMessageMemoryInputs(id, record.messages, record.focus)
      );
      memory.set(id, rebuilt);
      const next = syncRecordWithIndex({ ...record, updatedAt: now() }, rebuilt);
      records.set(id, next);
      return cloneRecord(next);
    },
    getPromptContext: async (id, query) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const index = ensureIndex(record);
      const compressed = compressContext(record.messages);
      return getPromptContextFromMemoryIndex(
        index,
        query,
        compressed.recent,
        record.summary.trim() || compressed.summary
      );
    },
    __getRecord: (id: string) => {
      const record = records.get(id);
      return record ? cloneRecord(record) : undefined;
    },
    __listRecords: () => [...records.values()].map(cloneRecord),
    __getMemoryIndex: (id: string) => memory.get(id),
  };
};

export const createTestTransport = (
  options?: {
    initialModel?: string;
    models?: string[];
    initialProvider?: string;
    providers?: string[];
    setModelImpl?: (model: string) => Promise<ModelSetResult>;
    setProviderImpl?: (provider: string) => Promise<ProviderSetResult>;
    refreshImpl?: () => Promise<ModelRefreshResult>;
    summarizeImpl?: (prompt: string) => Promise<{
      ok: boolean;
      text?: string;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      message?: string;
    }>;
  }
): QueryTransport => {
  let currentModel = options?.initialModel ?? "gpt-test";
  let currentProvider =
    options?.initialProvider ?? "https://provider.test/v1";
  const models = options?.models ?? ["gpt-test", "gpt-next"];
  const providers = options?.providers ?? [currentProvider];

  return {
    getModel: () => currentModel,
    getProvider: () => currentProvider,
    setModel: async model => {
      if (options?.setModelImpl) {
        const result = await options.setModelImpl(model);
        if (result.ok) {
          currentModel = model;
        }
        return result;
      }
      currentModel = model;
      return { ok: true, message: `Model switched to ${model}` };
    },
    listProviders: async () => [...providers],
    setProvider: async provider => {
      if (options?.setProviderImpl) {
        const result = await options.setProviderImpl(provider);
        if (result.ok) {
          currentProvider = result.currentProvider ?? provider;
        }
        return result;
      }
      currentProvider = provider;
      if (!providers.includes(provider)) {
        providers.push(provider);
      }
      return {
        ok: true,
        message: `Provider switched to: ${provider}`,
        currentProvider: provider,
        providers: [...providers],
        models: [...models],
      };
    },
    listModels: async () => [...models],
    refreshModels: async () =>
      options?.refreshImpl
        ? options.refreshImpl()
        : { ok: true, message: "Models refreshed", models: [...models] },
    summarizeText: async prompt =>
      options?.summarizeImpl
        ? options.summarizeImpl(prompt)
        : { ok: false, message: "summary unavailable" },
    requestStreamUrl: async query => `stream://${query}`,
    stream: async function* () {},
  };
};
