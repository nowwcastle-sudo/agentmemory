import { describe, it, expect, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";

// `state::list` returns a whole scope as one message and has no pagination,
// which is problem #1: the biggest live scope answers 59.2 MB in 1.5 s. The
// state worker is a closed package, so that call cannot be changed here --
// but it also serves `state::list_keys`, which answered the same scope with
// 6,890 keys in 158 KB and 72 ms (measured 2026-09-20). Keys plus the gets a
// caller actually needs is the pagination the API never grew.
//
// listKeys exposes it; listPage reads one window of rows through it. Neither
// replaces `list` -- a full scan still costs one get per row, which is slower
// than one message -- so they are for callers that want a bounded read.

function mockSdk(rows: Record<string, unknown>) {
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    trigger: vi.fn(async (input: { function_id: string; payload: any }) => {
      calls.push(input);
      if (input.function_id === "state::list_keys") return { keys: Object.keys(rows) };
      if (input.function_id === "state::get") return rows[input.payload.key] ?? null;
      if (input.function_id === "state::list") return Object.values(rows);
      throw new Error(`unexpected ${input.function_id}`);
    }),
  };
}

const sample = {
  a: { id: "a" },
  b: { id: "b" },
  c: { id: "c" },
  d: { id: "d" },
};

describe("StateKV.listKeys", () => {
  it("returns the scope's keys without reading any value", async () => {
    const sdk = mockSdk(sample);
    const kv = new StateKV(sdk as never);

    const keys = await kv.listKeys("mem:obs:s1");

    expect(keys).toEqual(["a", "b", "c", "d"]);
    expect(sdk.calls.map((c) => c.function_id)).toEqual(["state::list_keys"]);
  });

  it("accepts a bare array answer as well as {keys}", async () => {
    const sdk = {
      trigger: vi.fn(async () => ["x", "y"]),
    };
    const kv = new StateKV(sdk as never);

    expect(await kv.listKeys("mem:obs:s1")).toEqual(["x", "y"]);
  });

  it("returns nothing when the scope has no keys", async () => {
    const sdk = mockSdk({});
    const kv = new StateKV(sdk as never);

    expect(await kv.listKeys("mem:obs:empty")).toEqual([]);
  });
});

describe("StateKV.listPage", () => {
  it("reads only the rows in the window", async () => {
    const sdk = mockSdk(sample);
    const kv = new StateKV(sdk as never);

    const page = await kv.listPage<{ id: string }>("mem:obs:s1", { offset: 1, limit: 2 });

    expect(page.rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(true);
    const gets = sdk.calls.filter((c) => c.function_id === "state::get");
    expect(gets).toHaveLength(2);
    expect(sdk.calls.some((c) => c.function_id === "state::list")).toBe(false);
  });

  it("says when the window reaches the end", async () => {
    const sdk = mockSdk(sample);
    const kv = new StateKV(sdk as never);

    const page = await kv.listPage("mem:obs:s1", { offset: 2, limit: 10 });

    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("drops a key whose row disappeared between the two calls", async () => {
    // The keys are read first; a delete that lands before the gets leaves a
    // key pointing at nothing.
    const rows: Record<string, unknown> = { ...sample };
    const sdk = {
      trigger: vi.fn(async (input: { function_id: string; payload: any }) => {
        if (input.function_id === "state::list_keys") {
          const keys = Object.keys(rows);
          delete rows.b;
          return { keys };
        }
        if (input.function_id === "state::get") return rows[input.payload.key] ?? null;
        throw new Error(`unexpected ${input.function_id}`);
      }),
    };
    const kv = new StateKV(sdk as never);

    const page = await kv.listPage<{ id: string }>("mem:obs:s1", { offset: 0, limit: 3 });

    expect(page.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(page.total).toBe(4);
  });

  it("reads the first rows when no window is given", async () => {
    const sdk = mockSdk(sample);
    const kv = new StateKV(sdk as never);

    const page = await kv.listPage("mem:obs:s1", { limit: 1 });

    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});
