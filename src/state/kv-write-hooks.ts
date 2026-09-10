// In-process notification of KV writes, keyed by the KV instance.
//
// StateKV calls emitKvWrite after every set/update/delete. A reader that
// keeps a scope in memory (the graph retrieval's live-graph cache) subscribes
// with onKvWrite and applies the change instead of listing the scope again
// through the engine. Keyed by instance so a test's mock store never feeds
// another test's cache; a WeakMap so a discarded KV takes its listeners with
// it.

export interface KvWriteEvent {
  op: "set" | "update" | "delete";
  scope: string;
  key: string;
  /** The row as written (set) or as returned by the store (update); absent for delete. */
  value?: unknown;
}

export type KvWriteListener = (event: KvWriteEvent) => void;

const listeners = new WeakMap<object, Set<KvWriteListener>>();

export function onKvWrite(kv: object, listener: KvWriteListener): () => void {
  let set = listeners.get(kv);
  if (!set) {
    set = new Set();
    listeners.set(kv, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

export function emitKvWrite(kv: object, event: KvWriteEvent): void {
  const set = listeners.get(kv);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // A listener's failure must not fail the write it observed.
    }
  }
}
