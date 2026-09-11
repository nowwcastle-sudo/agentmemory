import { describe, it, expect, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";

// A string with a lone surrogate cannot be encoded as UTF-8; the state worker
// never answers such a set and the caller waits out its invocation timeout
// (live: 180 s, retried hundreds of times). The KV wrapper drops lone
// surrogates from every string in a value before it leaves the process.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("StateKV.set sanitises strings", () => {
  it("removes lone surrogates anywhere in the value and leaves valid text alone", async () => {
    const trigger = vi.fn(async (req: { payload: { value: unknown } }) => req.payload.value);
    const kv = new StateKV({ trigger } as never);
    const value = {
      title: "cut here \ud83d…",
      nested: { list: ["fine 🔥 text", "bad \ude00 tail"], n: 3, ok: true },
    };
    await kv.set("mem:test", "k", value);
    const sent = trigger.mock.calls[0][0].payload.value as typeof value;
    expect(LONE.test(JSON.stringify(sent))).toBe(false);
    expect(sent.title).toBe("cut here …");
    expect(sent.nested.list[0]).toBe("fine 🔥 text");
    expect(sent.nested.list[1]).toBe("bad  tail");
    expect(sent.nested.n).toBe(3);
  });

  it("passes a clean value through untouched (same object)", async () => {
    const trigger = vi.fn(async (req: { payload: { value: unknown } }) => req.payload.value);
    const kv = new StateKV({ trigger } as never);
    const value = { title: "plain", items: [1, 2, 3] };
    await kv.set("mem:test", "k", value);
    expect(trigger.mock.calls[0][0].payload.value).toBe(value);
  });
});
