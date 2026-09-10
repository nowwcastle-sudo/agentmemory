import { vi } from "vitest";
import { emitKvWrite } from "../../src/state/kv-write-hooks.js";

type Handler = (data: unknown) => Promise<unknown>;

// Mirrors StateKV, including the write events it emits: an in-process cache
// under test must learn about writes the same way it does in production.
export function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ): Promise<void> => {
      const entries = store.get(scope);
      if (!entries) return;
      const value = (entries.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) value[u.path] = u.value;
      entries.set(key, value);
      emitKvWrite(kv, { op: "update", scope, key, value });
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      emitKvWrite(kv, { op: "set", scope, key, value: data });
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
      emitKvWrite(kv, { op: "delete", scope, key });
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
  return kv;
}

export function mockSdk(opts?: { looseTrigger?: boolean }) {
  const functions = new Map<string, Handler>();
  const triggers: Array<{
    type: string;
    function_id: string;
    config?: { topic?: string };
  }> = [];
  const looseTrigger = opts?.looseTrigger ?? false;
  return {
    fns: functions,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Handler,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: vi.fn((trigger) => {
      triggers.push(trigger);
    }),
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : (idOrInput.payload as unknown);
      if (id === "iii::durable::publish") {
        const published = payload as { topic?: string; data?: unknown };
        const subscribers = triggers.filter(
          (trigger) =>
            trigger.type === "durable:subscriber" &&
            trigger.config?.topic === published.topic,
        );
        await Promise.all(
          subscribers.map(async (trigger) => {
            const subscriber = functions.get(trigger.function_id);
            if (subscriber) await subscriber(published.data);
          }),
        );
        return null;
      }
      const fn = functions.get(id);
      if (!fn) {
        // looseTrigger mirrors production fan-out where side-effect
        // triggers (cascade, events) may target functions another
        // module registers; tests exercising one module opt in.
        if (looseTrigger) return null;
        throw new Error(`No function: ${id}`);
      }
      return fn(payload);
    },
  };
}
