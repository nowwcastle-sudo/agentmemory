import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    observations: (sessionId: string) => `obs:${sessionId}`,
    audit: "audit",
  },
  fingerprintId: (prefix: string, content: string) =>
    `${prefix}:${content}`,
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { ProjectionCoordinator } from "../src/functions/projection-coordinator.js";
import type {
  CompressedObservation,
  Session,
  MemoryProvider,
} from "../src/types.js";
import { NoopProvider } from "../src/providers/noop.js";
import { ResilientProvider } from "../src/providers/resilient.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function makeObs(i: number, sessionId: string): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "conversation",
    title: `obs ${i}`,
    facts: [`fact ${i}`],
    narrative: `narrative for obs ${i}`,
    concepts: [],
    files: [`src/file_${i}.ts`],
    importance: 5,
  };
}

function makeProvider(responses: string[]): MemoryProvider & {
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  let i = 0;
  return {
    name: "test",
    calls,
    compress: async () => "",
    summarize: async (system: string, user: string) => {
      calls.push({ system, user });
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
}

class ExplodingNoopProvider extends NoopProvider {
  override async summarize(): Promise<string> {
    throw new Error("wrapped noop must not be called");
  }
}

function summaryXml(opts: {
  title: string;
  narrative?: string;
  decisions?: string[];
  files?: string[];
  concepts?: string[];
}): string {
  const d = (opts.decisions ?? []).map((x) => `<decision>${x}</decision>`).join("");
  const f = (opts.files ?? []).map((x) => `<file>${x}</file>`).join("");
  const c = (opts.concepts ?? []).map((x) => `<concept>${x}</concept>`).join("");
  return `<summary>
<title>${opts.title}</title>
<narrative>${opts.narrative ?? "narrative"}</narrative>
<decisions>${d}</decisions>
<files>${f}</files>
<concepts>${c}</concepts>
</summary>`;
}

async function setupHandler(opts: {
  sessionId: string;
  obsCount: number;
  provider: MemoryProvider;
}) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: opts.sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: opts.obsCount,
  };
  await kv.set("sessions", opts.sessionId, session);
  for (let i = 0; i < opts.obsCount; i++) {
    const o = makeObs(i, opts.sessionId);
    await kv.set(`obs:${opts.sessionId}`, o.id, o);
  }
  const core = registerSummarizeFunction(
    sdk as any,
    kv as any,
    opts.provider,
    undefined,
    new ProjectionCoordinator(),
  );
  const handler = sdk.functions.get("mem::summarize")!;
  return { core, handler, kv };
}

describe("mem::summarize chunking", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.SUMMARIZE_CHUNK_SIZE;
    delete process.env.SUMMARIZE_CHUNK_CONCURRENCY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns one core whose persisted result matches the public wrapper", async () => {
    const direct = await setupHandler({
      sessionId: "ses_core_direct",
      obsCount: 1,
      provider: makeProvider([summaryXml({ title: "Shared summary core" })]),
    });
    const wrapped = await setupHandler({
      sessionId: "ses_core_wrapped",
      obsCount: 1,
      provider: makeProvider([summaryXml({ title: "Shared summary core" })]),
    });

    const directResult: any = await direct.core({
      sessionId: "ses_core_direct",
    });
    const wrappedResult: any = await wrapped.handler({
      sessionId: "ses_core_wrapped",
    });

    expect(directResult).toMatchObject({
      success: true,
      qualityScore: 100,
      summary: { title: "Shared summary core", observationCount: 1 },
    });
    expect(wrappedResult).toMatchObject({
      success: true,
      qualityScore: 100,
      summary: { title: "Shared summary core", observationCount: 1 },
    });
    expect(await direct.kv.get("summaries", "ses_core_direct")).toMatchObject({
      title: "Shared summary core",
      observationCount: 1,
    });
    expect(await wrapped.kv.get("summaries", "ses_core_wrapped")).toMatchObject({
      title: "Shared summary core",
      observationCount: 1,
    });
  });

  it("skips a resilient-wrapped noop provider without calling it", async () => {
    const provider = new ResilientProvider(new ExplodingNoopProvider());
    const { handler, kv } = await setupHandler({
      sessionId: "ses_wrapped_noop",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_wrapped_noop" });

    expect(result).toMatchObject({ success: false, error: "no_provider" });
    expect(await kv.get("summaries", "ses_wrapped_noop")).toBeNull();
  });

  it("small session takes the single-call path (no chunking, no reduce)", async () => {
    const provider = makeProvider([
      summaryXml({
        title: "Small session",
        decisions: ["decision A"],
        files: ["src/a.ts"],
        concepts: ["concept-a"],
      }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_small",
      obsCount: 10,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_small" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].user).toContain("Session observations (10 total)");
    const stored: any = await kv.get("summaries", "ses_small");
    expect(stored?.title).toBe("Small session");
  });

  it("large session map-reduces: N chunk calls + 1 reduce call", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1"; // serial keeps call ordering deterministic
    const provider = makeProvider([
      summaryXml({ title: "Chunk 1", decisions: ["dA"], files: ["src/a.ts"], concepts: ["ca"] }),
      summaryXml({ title: "Chunk 2", decisions: ["dB"], files: ["src/b.ts"], concepts: ["cb"] }),
      summaryXml({ title: "Chunk 3", decisions: ["dC"], files: ["src/c.ts"], concepts: ["cc"] }),
      summaryXml({
        title: "Merged",
        decisions: ["dA", "dB", "dC"],
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        concepts: ["ca", "cb", "cc"],
      }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_large",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_large" });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(4);
    // First three are chunk calls (use the summary system prompt).
    expect(provider.calls[0].system).toContain("session summarizer");
    expect(provider.calls[2].system).toContain("session summarizer");
    // Last is the reduce call (uses the merge system prompt).
    expect(provider.calls[3].system).toContain("merging multiple partial summaries");
    expect(provider.calls[3].user).toContain("Chunk 1 of 3");
    expect(provider.calls[3].user).toContain("Chunk 3 of 3");

    const stored: any = await kv.get("summaries", "ses_large");
    expect(stored?.title).toBe("Merged");
    // observationCount on the persisted summary should reflect the full session,
    // not just the final chunk.
    expect(stored?.observationCount).toBe(250);
    expect(stored?.keyDecisions).toEqual(["dA", "dB", "dC"]);
  });

  it("SUMMARIZE_CHUNK_SIZE env override is respected", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "50";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "chunk" }),
      summaryXml({ title: "merged" }),
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_env",
      obsCount: 175,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_env" });

    expect(result.success).toBe(true);
    // 175 obs ÷ 50 = 4 chunks (last chunk has 25) + 1 reduce = 5 calls.
    expect(provider.calls).toHaveLength(5);
  });

  it("flaky chunk: parse fails once, retried, then succeeds — no skip", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "ok1" }),
      "<garbage/>",                  // chunk 2 attempt 1: parse-fail
      summaryXml({ title: "ok2" }),  // chunk 2 attempt 2 (retry): success
      summaryXml({ title: "ok3" }),
      summaryXml({ title: "merged" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_flaky",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_flaky" });

    expect(result.success).toBe(true);
    // 3 chunks × 1 attempt + 1 retry on chunk 2 + 1 reduce = 5 calls.
    expect(provider.calls).toHaveLength(5);
    const stored: any = await kv.get("summaries", "ses_flaky");
    expect(stored?.title).toBe("merged");
  });

  it("persistently-broken chunk is skipped, reduce still runs on remaining partials", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    const provider = makeProvider([
      summaryXml({ title: "ok1" }),
      "<garbage/>", "<garbage/>",   // chunk 2: both attempts parse-fail
      summaryXml({ title: "ok3" }),
      summaryXml({ title: "merged-with-skip" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_skip",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_skip" });

    expect(result.success).toBe(true);
    // 1 ok + (1 + 1 retry skip) + 1 ok + 1 reduce = 5 calls.
    expect(provider.calls).toHaveLength(5);
    // Reduce input should mention only 2 of 3 chunks (chunk 2 skipped) —
    // but the chunk indices in the reduce labels should reflect chunk 1 and 3,
    // preserving chronological boundaries.
    const reduceCall = provider.calls[4];
    expect(reduceCall.user).toContain("Chunk 1 of 2");
    expect(reduceCall.user).toContain("Chunk 2 of 2");
    expect(reduceCall.user).toContain("obs 1-100");        // first surviving chunk
    expect(reduceCall.user).toContain("obs 201-250");      // third surviving chunk (was idx 2, range 201-250)
    const stored: any = await kv.get("summaries", "ses_skip");
    expect(stored?.title).toBe("merged-with-skip");
  });

  it("too many skipped chunks bails out with a clear error", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    // 3 chunks, 2 fully broken → >50% skipped → bail.
    const provider = makeProvider([
      summaryXml({ title: "ok1" }),
      "<garbage/>", "<garbage/>",
      "<garbage/>", "<garbage/>",
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_too_broken",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_too_broken" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too_many_chunks_skipped: 2\/3/);
  });

  it("provider error on one chunk after retry is skipped, not propagated", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    let i = 0;
    const provider: MemoryProvider & { calls: any[] } = {
      name: "test",
      calls: [],
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        (provider as any).calls.push({ system, user });
        i += 1;
        if (i === 1) return summaryXml({ title: "ok1" });
        // chunk 2: both attempts throw (e.g. provider 400)
        if (i === 2 || i === 3) throw new Error("OpenAI API error (400): content rejected");
        if (i === 4) return summaryXml({ title: "ok3" });
        return summaryXml({ title: "merged-with-skip" });
      },
    };
    const { handler, kv } = await setupHandler({
      sessionId: "ses_net",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_net" });

    expect(result.success).toBe(true);
    // 1 ok + 2 fail + 1 ok + 1 reduce = 5 calls.
    expect((provider as any).calls.length).toBe(5);
    const stored: any = await kv.get("summaries", "ses_net");
    expect(stored?.title).toBe("merged-with-skip");
  });

  it("every chunk failing on provider error trips too_many_chunks_skipped", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    // 3 chunks, all chunk calls throw → 3/3 skipped → bail.
    const provider: MemoryProvider & { calls: any[] } = {
      name: "test",
      calls: [],
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        (provider as any).calls.push({ system, user });
        throw new Error("OpenAI API error (400): invalid request");
      },
    };
    const { handler } = await setupHandler({
      sessionId: "ses_all_400",
      obsCount: 250,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_all_400" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too_many_chunks_skipped: 3\/3/);
  });

  it("chunks run in parallel batches according to SUMMARIZE_CHUNK_CONCURRENCY", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "2";
    let inflight = 0;
    let maxInflight = 0;
    const provider: MemoryProvider & { calls: any[] } = {
      name: "test",
      calls: [],
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        (provider as any).calls.push({ system, user });
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        // Yield to event loop so siblings can also enter before we resolve.
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        if (system.includes("merging")) return summaryXml({ title: "merged" });
        return summaryXml({ title: "ok" });
      },
    };
    const { handler } = await setupHandler({
      sessionId: "ses_par",
      obsCount: 400, // 4 chunks at chunkSize=100
      provider,
    });

    const result: any = await handler({ sessionId: "ses_par" });

    expect(result.success).toBe(true);
    // 4 chunks at concurrency 2 → max 2 in flight at once during the chunk phase.
    // Reduce is a single call so doesn't bump it.
    expect(maxInflight).toBe(2);
  });

  // #783: markdown-wrapped XML used to silently fail parsing because
  // the tag regex looked for <title> in the raw payload. stripXmlWrappers
  // now peels ```xml ... ``` fences and conversational pre/postamble
  // before the regex runs.
  it("parses a summary even when the LLM wraps XML in markdown fences", async () => {
    const wrappedXml = "Here's the summary:\n```xml\n" + summaryXml({
      title: "wrapped",
      narrative: "n",
      decisions: ["d1"],
      files: ["src/a.ts"],
      concepts: ["c1"],
    }) + "\n```\nLet me know if you need anything else.";
    const provider = makeProvider([wrappedXml]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_md",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_md" });

    expect(result.success).toBe(true);
    expect(result.summary.title).toBe("wrapped");
    const stored = await kv.get("summaries", "ses_md");
    expect((stored as any).title).toBe("wrapped");
  });

  it("retries the final summarize once on first-attempt parse failure", async () => {
    // First call returns garbage (no <title>), second returns valid XML.
    // The chunk-level retry is bypassed for a 1-obs session (no chunking),
    // so this exercises the new final-summarize retry path.
    const provider = makeProvider([
      "not xml, just a sentence with no tags",
      summaryXml({ title: "second-attempt" }),
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_retry",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_retry" });

    expect(result.success).toBe(true);
    expect(result.summary.title).toBe("second-attempt");
    expect((provider as any).calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns parse_failed only after both attempts fail", async () => {
    const provider = makeProvider([
      "garbage one",
      "garbage two",
    ]);
    const { handler } = await setupHandler({
      sessionId: "ses_fail",
      obsCount: 1,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_fail" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("parse_failed");
  });

  it("skips an unchanged source only after a successful summary checkpoint", async () => {
    const provider = makeProvider([summaryXml({ title: "stable" })]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_stable",
      obsCount: 1,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_stable" });
    const second: any = await handler({ sessionId: "ses_stable" });

    expect(first.success).toBe(true);
    expect(second).toMatchObject({ success: true, deduplicated: true });
    expect(provider.calls).toHaveLength(1);
    expect(await kv.get("summaries", "ses_stable")).toMatchObject({
      sourceFingerprint: expect.any(String),
    });
  });

  it("re-summarizes changed content even when observation count is unchanged", async () => {
    const provider = makeProvider([
      summaryXml({ title: "before" }),
      summaryXml({ title: "after" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_changed",
      obsCount: 1,
      provider,
    });
    await handler({ sessionId: "ses_changed" });
    const changed = makeObs(0, "ses_changed");
    changed.narrative = "the source changed without changing the row count";
    await kv.set("obs:ses_changed", changed.id, changed);

    const result: any = await handler({ sessionId: "ses_changed" });

    expect(result.success).toBe(true);
    expect(result.summary.title).toBe("after");
    expect(provider.calls).toHaveLength(2);
  });

  it("does not checkpoint a failed summary and retries the same source", async () => {
    const provider = makeProvider([
      "invalid first attempt",
      "invalid second attempt",
      summaryXml({ title: "recovered" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_summary_retry",
      obsCount: 1,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_summary_retry" });
    expect(first).toMatchObject({ success: false, error: "parse_failed" });
    expect(await kv.get("summaries", "ses_summary_retry")).toBeNull();

    const second: any = await handler({ sessionId: "ses_summary_retry" });
    expect(second).toMatchObject({ success: true });
    expect(second.summary.title).toBe("recovered");
  });

  it("summarizes a 500-observation default session with one bounded provider call", async () => {
    const provider = makeProvider([
      summaryXml({
        title: "bounded large session",
        narrative: "The whole session was summarized without replaying every raw narrative.",
      }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_bounded_500",
      obsCount: 500,
      provider,
    });
    const longNarrative = "x".repeat(400);
    for (let i = 0; i < 500; i++) {
      const observation = makeObs(i, "ses_bounded_500");
      observation.title = `obs ${i} ${"t".repeat(400)}`;
      observation.narrative = longNarrative;
      observation.facts = Array.from({ length: 5 }, (_, fact) =>
        `fact ${fact} ${"f".repeat(400)}`,
      );
      observation.files = Array.from({ length: 12 }, (_, file) =>
        `src/${"p".repeat(220)}/file_${i}_${file}.ts`,
      );
      observation.concepts = Array.from({ length: 12 }, (_, concept) =>
        `concept-${i}-${concept}-${"c".repeat(160)}`,
      );
      await kv.set("obs:ses_bounded_500", observation.id, observation);
    }

    const result: any = await handler({ sessionId: "ses_bounded_500" });

    expect(result).toMatchObject({ success: true });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].user.length).toBeLessThanOrEqual(24_000);
    expect(await kv.get("summaries", "ses_bounded_500")).toMatchObject({
      coveredObservationIds: Array.from({ length: 500 }, (_, i) => `obs_${i}`).sort(),
    });
  });

  it("merges only new observation ids into the previous successful summary", async () => {
    const provider = makeProvider([
      summaryXml({ title: "first checkpoint", narrative: "initial work" }),
      summaryXml({ title: "second checkpoint", narrative: "initial work plus the delta" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_incremental",
      obsCount: 3,
      provider,
    });
    await handler({ sessionId: "ses_incremental" });
    for (let i = 3; i < 5; i++) {
      const observation = makeObs(i, "ses_incremental");
      await kv.set("obs:ses_incremental", observation.id, observation);
    }

    const result: any = await handler({ sessionId: "ses_incremental" });

    expect(result).toMatchObject({ success: true });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].user).toContain("Mode: incremental");
    expect(provider.calls[1].user).toContain("Delta observations: 2");
    expect(provider.calls[1].user).toContain("first checkpoint");
    expect(provider.calls[1].user).toContain("obs 3");
    expect(provider.calls[1].user).toContain("obs 4");
    expect(await kv.get("summaries", "ses_incremental")).toMatchObject({
      coveredObservationIds: ["obs_0", "obs_1", "obs_2", "obs_3", "obs_4"],
    });
  });

  it("rebuilds one bounded digest when a covered observation changes", async () => {
    const provider = makeProvider([
      summaryXml({ title: "before rebuild" }),
      summaryXml({ title: "after rebuild" }),
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_rebuild",
      obsCount: 3,
      provider,
    });
    await handler({ sessionId: "ses_rebuild" });
    const changed = makeObs(1, "ses_rebuild");
    changed.narrative = "a covered source changed after the last successful checkpoint";
    await kv.set("obs:ses_rebuild", changed.id, changed);

    const result: any = await handler({ sessionId: "ses_rebuild" });

    expect(result).toMatchObject({ success: true });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].user).toContain("Mode: rebuild");
    expect(provider.calls[1].user).toContain("before rebuild");
    expect(provider.calls[1].user.length).toBeLessThanOrEqual(24_000);
  });

  it("keeps the previous successful checkpoint when replacement output cannot be parsed", async () => {
    const provider = makeProvider([
      summaryXml({ title: "stable checkpoint" }),
      "invalid replacement one",
      "invalid replacement two",
    ]);
    const { handler, kv } = await setupHandler({
      sessionId: "ses_preserve_checkpoint",
      obsCount: 2,
      provider,
    });
    await handler({ sessionId: "ses_preserve_checkpoint" });
    const before = await kv.get("summaries", "ses_preserve_checkpoint");
    const added = makeObs(2, "ses_preserve_checkpoint");
    await kv.set("obs:ses_preserve_checkpoint", added.id, added);

    const result: any = await handler({ sessionId: "ses_preserve_checkpoint" });
    const after = await kv.get("summaries", "ses_preserve_checkpoint");

    expect(result).toMatchObject({ success: false, error: "parse_failed" });
    expect(after).toEqual(before);
    expect(before).toMatchObject({
      sourceFingerprint: expect.any(String),
      coveredObservationIds: ["obs_0", "obs_1"],
    });
  });
});
