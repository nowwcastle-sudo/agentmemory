import { describe, it, expect, beforeEach } from "vitest";
import { retitleObservations, isBareTitle } from "../src/functions/observation-retitle.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, RawObservation, Session } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// The rows already in the store keep their bare titles until something
// rewrites them. This walks sessions in id order, resumable by cursor,
// rebuilds the synthetic title from the raw row, and re-indexes.

function session(id: string): Session {
  return { id, project: "p1", startedAt: "2026-09-01T00:00:00.000Z", status: "active" } as unknown as Session;
}
function raw(id: string, sid: string, over: Partial<RawObservation>): RawObservation {
  return { id, sessionId: sid, timestamp: "2026-09-01T00:00:00.000Z", hookType: "post_tool_use", raw: {}, ...over };
}
function compressed(id: string, sid: string, title: string, over: Partial<CompressedObservation> = {}): CompressedObservation {
  return { id, sessionId: sid, timestamp: "2026-09-01T00:00:00.000Z", type: "command_run", title, facts: [], narrative: `${title} narrative`, concepts: [], files: [], importance: 5, confidence: 0.3, ...over };
}

describe("isBareTitle", () => {
  it("knows a bare tool or hook name when it sees one", () => {
    for (const bare of ["Bash", "Read", "prompt_submit", "Monitor", "Edit", "post_tool_use", "ab", "", "assistant_response: ## Session Summary", "prompt_submit: hello"]) expect(isBareTitle(bare), bare).toBe(true);
    for (const fine of ["Bash: npm test", "Read functions/context.ts", "Prompt: 진행", "Implement retry policy", "Assistant: Session Summary"]) expect(isBareTitle(fine), fine).toBe(false);
  });
});

describe("retitleObservations", () => {
  beforeEach(() => {
    const index = getSearchIndex();
    for (const id of ["o1", "o2", "o3", "o4"]) index.remove(id);
  });

  it("rewrites bare synthetic titles from the raw row, re-indexes, and leaves the rest alone", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "s1", session("s1"));
    await kv.set(KV.rawObservations("s1"), "o1", raw("o1", "s1", { toolName: "Bash", toolInput: { command: "npm test -- auth" } }));
    await kv.set(KV.observations("s1"), "o1", compressed("o1", "s1", "Bash"));
    // An LLM-compressed row with a poor title is not synthetic: untouched.
    await kv.set(KV.rawObservations("s1"), "o2", raw("o2", "s1", { toolName: "Read", toolInput: { file_path: "src/a.ts" } }));
    await kv.set(KV.observations("s1"), "o2", compressed("o2", "s1", "Read", { confidence: 0.9 }));
    // Already descriptive: untouched.
    await kv.set(KV.rawObservations("s1"), "o3", raw("o3", "s1", { toolName: "Edit", toolInput: { file_path: "src/b.ts" } }));
    await kv.set(KV.observations("s1"), "o3", compressed("o3", "s1", "Edit state/b.ts"));
    // The captured compaction prompt: retitled and demoted.
    await kv.set(KV.rawObservations("s1"), "o4", raw("o4", "s1", { hookType: "prompt_submit", userPrompt: "Below is a conversation log from a Claude Code coding session.\nCreate a summary to help the next session quickly understand the context.\n\n## Prioritize including" }));
    await kv.set(KV.observations("s1"), "o4", compressed("o4", "s1", "prompt_submit", { type: "conversation" }));
    getSearchIndex().add(await kv.get(KV.observations("s1"), "o1") as CompressedObservation);

    const result = await retitleObservations(kv as never, { maxSessions: 10 });
    expect(result).toMatchObject({ sessions: 1, scanned: 4, retitled: 2, nextCursor: null });

    expect((await kv.get<CompressedObservation>(KV.observations("s1"), "o1"))!.title).toBe("Bash: npm test -- auth");
    expect((await kv.get<CompressedObservation>(KV.observations("s1"), "o2"))!.title).toBe("Read");
    expect((await kv.get<CompressedObservation>(KV.observations("s1"), "o3"))!.title).toBe("Edit state/b.ts");
    const o4 = (await kv.get<CompressedObservation>(KV.observations("s1"), "o4"))!;
    expect(o4.title).toBe("Auto-compact summary request");
    expect(o4.importance).toBe(1);
    // The search index carries the new title.
    const hits = getSearchIndex().search("auth", 5).map((h) => h.obsId);
    expect(hits).toContain("o1");
  });

  it("re-derives a row the compressor now classifies as a harness notice, title included", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "s1", session("s1"));
    const notice = '<task-notification>\n<task-id>x</task-id>\n<summary>Monitor event: "supervisor log" fired</summary>\n</task-notification>';
    await kv.set(KV.rawObservations("s1"), "o1", raw("o1", "s1", { hookType: "prompt_submit", userPrompt: notice }));
    // Already retitled once by the first pass: descriptive-looking, but noise.
    await kv.set(KV.observations("s1"), "o1", compressed("o1", "s1", "Prompt: <task-notification>", { type: "conversation" }));
    const result = await retitleObservations(kv as never, { maxSessions: 10 });
    expect(result.retitled).toBe(1);
    const row = (await kv.get<CompressedObservation>(KV.observations("s1"), "o1"))!;
    expect(row.title).toBe('Harness notice: Monitor event: "supervisor log" fired');
    expect(row.importance).toBe(1);
  });

  it("pages through sessions by cursor and stops when there are none left", async () => {
    const kv = mockKV();
    for (const sid of ["s1", "s2", "s3"]) {
      await kv.set(KV.sessions, sid, session(sid));
      await kv.set(KV.rawObservations(sid), `${sid}_o`, raw(`${sid}_o`, sid, { toolName: "Bash", toolInput: { command: `echo ${sid}` } }));
      await kv.set(KV.observations(sid), `${sid}_o`, compressed(`${sid}_o`, sid, "Bash"));
    }
    const first = await retitleObservations(kv as never, { maxSessions: 2 });
    expect(first).toMatchObject({ sessions: 2, retitled: 2, nextCursor: "s2" });
    const second = await retitleObservations(kv as never, { maxSessions: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ sessions: 1, retitled: 1, nextCursor: null });
  });

  it("accepts a re-embed request and reports what it re-embedded (nothing without a vector provider)", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "s1", session("s1"));
    await kv.set(KV.rawObservations("s1"), "o1", raw("o1", "s1", { toolName: "Bash", toolInput: { command: "ls" } }));
    await kv.set(KV.observations("s1"), "o1", compressed("o1", "s1", "Bash: ls"));
    const result = await retitleObservations(kv as never, { maxSessions: 10, reembed: true });
    expect(result).toMatchObject({ scanned: 1, retitled: 0, reembedded: 0 });
    expect((await kv.get<CompressedObservation>(KV.observations("s1"), "o1"))!.title).toBe("Bash: ls");
  });

  it("counts without writing in a dry run", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "s1", session("s1"));
    await kv.set(KV.rawObservations("s1"), "o1", raw("o1", "s1", { toolName: "Bash", toolInput: { command: "ls" } }));
    await kv.set(KV.observations("s1"), "o1", compressed("o1", "s1", "Bash"));
    const result = await retitleObservations(kv as never, { maxSessions: 10, dryRun: true });
    expect(result).toMatchObject({ scanned: 1, retitled: 1 });
    expect((await kv.get<CompressedObservation>(KV.observations("s1"), "o1"))!.title).toBe("Bash");
  });
});
