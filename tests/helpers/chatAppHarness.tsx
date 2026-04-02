import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SessionStore } from "../../src/core/session/store";
import type {
  SessionListItem,
  SessionMessage,
  SessionRecord,
} from "../../src/core/session/types";
import type {
  ModelRefreshResult,
  ModelSetResult,
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
  let counter = seed.length + 1;

  const toListItem = (record: SessionRecord): SessionListItem => ({
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
  });

  return {
    createSession: async (title?: string) => {
      const id = `session-${counter++}`;
      const record = createSessionRecord(id, { title: title ?? id });
      records.set(id, record);
      return cloneRecord(record);
    },
    listSessions: async () =>
      [...records.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(toListItem),
    loadSession: async id => {
      const record = records.get(id);
      return record ? cloneRecord(record) : null;
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
      };
      records.set(id, next);
      return cloneRecord(next);
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
      const next = { ...record, focus: [...record.focus, note], updatedAt: now() };
      records.set(id, next);
      return cloneRecord(next);
    },
    removeFocus: async (id, index) => {
      const record = records.get(id);
      if (!record) {
        throw new Error(`Missing session ${id}`);
      }
      const nextFocus = [...record.focus];
      nextFocus.splice(index, 1);
      const next = { ...record, focus: nextFocus, updatedAt: now() };
      records.set(id, next);
      return cloneRecord(next);
    },
    __getRecord: (id: string) => {
      const record = records.get(id);
      return record ? cloneRecord(record) : undefined;
    },
    __listRecords: () => [...records.values()].map(cloneRecord),
  };
};

export const createTestTransport = (
  options?: {
    initialModel?: string;
    models?: string[];
    setModelImpl?: (model: string) => Promise<ModelSetResult>;
    refreshImpl?: () => Promise<ModelRefreshResult>;
  }
): QueryTransport => {
  let currentModel = options?.initialModel ?? "gpt-test";
  const models = options?.models ?? ["gpt-test", "gpt-next"];

  return {
    getModel: () => currentModel,
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
    listModels: async () => [...models],
    refreshModels: async () =>
      options?.refreshImpl
        ? options.refreshImpl()
        : { ok: true, message: "Models refreshed", models: [...models] },
    requestStreamUrl: async query => `stream://${query}`,
    stream: async function* () {},
  };
};
