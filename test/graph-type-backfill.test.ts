import { describe, it, expect, vi } from "vitest";
import {
  selectTypingCandidates,
  buildTypingPrompt,
  parseTypingResponse,
  pickEvidence,
  isTypeableConcept,
  registerGraphTypeBackfill,
  GRAPH_TYPING_SYSTEM,
} from "../src/functions/graph-type-backfill.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, CompressedObservation } from "../src/types.js";

// On the live store 2026-09-10, 73% of live edges were related_to: the
// heuristic extractor's concept x file co-occurrence at weight 0.4. Retrieval
// scores paths by weight alone, so those edges are worth a third of a typed
// one, and the ontology view shows no relation at all. This pass takes the
// pairs with the most evidence behind them, asks the model for a relation from
// the closed vocabulary, writes the typed edge and supersedes the related_to.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  return {
    registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const now = "2026-09-10T12:00:00.000Z";
function node(id: string, type: GraphNode["type"], name: string): GraphNode {
  return { id, type, name, properties: {}, sourceObservationIds: [], createdAt: now };
}
function edge(id: string, type: GraphEdge["type"], src: string, tgt: string, obs: string[], extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id, type, sourceNodeId: src, targetNodeId: tgt, weight: 0.4, sourceObservationIds: obs, createdAt: now, ...extra };
}
function obs(id: string, title: string): CompressedObservation {
  return { id, sessionId: "ses_1", timestamp: now, type: "file_edit", title, facts: [], narrative: `${title} narrative`, concepts: [], files: [], importance: 5 };
}

const concept = node("n_c", "concept", "retry policy");
const file = node("n_f", "file", "src/retry.ts");
const otherConcept = node("n_c2", "concept", "logging");
const staleFile = node("n_stale", "file", "old.ts");
staleFile.stale = true;

describe("selectTypingCandidates", () => {
  it("keeps live concept-file related_to edges with enough evidence, strongest first", () => {
    const edges = [
      edge("e_weak", "related_to", "n_c", "n_f", ["o1"]),
      edge("e_strong", "related_to", "n_c2", "n_f", ["o1", "o2", "o3", "o4"]),
      edge("e_mid", "related_to", "n_c", "n_f", ["o1", "o2"]),
      edge("e_typed", "uses", "n_c", "n_f", ["o1", "o2", "o3"]),
      edge("e_cc", "related_to", "n_c", "n_c2", ["o1", "o2", "o3", "o4", "o5"]),
      edge("e_stale_end", "related_to", "n_c", "n_stale", ["o1", "o2", "o3"]),
      edge("e_superseded", "related_to", "n_c2", "n_f", ["o1", "o2", "o3"], { supersededBy: "e_typed" }),
    ];
    const picked = selectTypingCandidates([concept, file, otherConcept, staleFile], edges, { minBacking: 2, maxPairs: 10 });
    expect(picked.map((c) => c.edge.id)).toEqual(["e_strong", "e_mid"]);
    expect(picked[0].source.type).toBe("concept");
    expect(picked[0].target.type).toBe("file");
  });

  // Second trial: four of twenty-four typed edges pointed at file nodes named
  // "memory", "user" and "gosulgoseul-entertainer" -- not files. A file node
  // with neither a path separator nor an extension is not worth a model call.
  it("skips concept nodes that are commands or tool names", () => {
    const command = node("n_cmd", "concept", "git status");
    const tool = node("n_tool", "concept", "Bash");
    const edges = [
      edge("e_cmd", "related_to", "n_cmd", "n_f", ["o1", "o2"]),
      edge("e_tool", "related_to", "n_tool", "n_f", ["o1", "o2"]),
      edge("e_ok", "related_to", "n_c", "n_f", ["o1", "o2"]),
    ];
    const picked = selectTypingCandidates([concept, file, command, tool], edges, { minBacking: 2 });
    expect(picked.map((c) => c.edge.id)).toEqual(["e_ok"]);
  });

  it("skips directory nodes: a path whose last segment has no extension", () => {
    const dir = node("n_dir", "file", "C:\\Users\\x\\hermes-agent\\.worktrees\\discord-cs-quiz-core");
    const edges = [
      edge("e_dir", "related_to", "n_c", "n_dir", ["o1", "o2"]),
      edge("e_ok", "related_to", "n_c", "n_f", ["o1", "o2"]),
    ];
    const picked = selectTypingCandidates([concept, file, dir], edges, { minBacking: 2 });
    expect(picked.map((c) => c.edge.id)).toEqual(["e_ok"]);
  });

  it("skips file nodes that have neither a path nor an extension", () => {
    const junk = node("n_junk", "file", "memory");
    const bare = node("n_bare", "file", "README");
    const edges = [
      edge("e_junk", "related_to", "n_c", "n_junk", ["o1", "o2", "o3"]),
      edge("e_bare", "related_to", "n_c", "n_bare", ["o1", "o2", "o3"]),
      edge("e_real", "related_to", "n_c", "n_f", ["o1", "o2"]),
    ];
    const picked = selectTypingCandidates([concept, file, junk, bare], edges, { minBacking: 2, maxPairs: 10 });
    expect(picked.map((c) => c.edge.id)).toEqual(["e_real"]);
  });

  it("honours maxPairs after ordering", () => {
    const edges = [
      edge("a", "related_to", "n_c", "n_f", ["o1", "o2"]),
      edge("b", "related_to", "n_c2", "n_f", ["o1", "o2", "o3"]),
    ];
    const picked = selectTypingCandidates([concept, file, otherConcept], edges, { minBacking: 2, maxPairs: 1 });
    expect(picked.map((c) => c.edge.id)).toEqual(["b"]);
  });
});

describe("buildTypingPrompt", () => {
  it("numbers each pair, names both endpoints with their types, and quotes the evidence", () => {
    const candidates = [{ edge: edge("e1", "related_to", "n_c", "n_f", ["o1", "o2"]), source: concept, target: file }];
    const prompt = buildTypingPrompt(candidates, new Map([["e1", ["Add retry policy to fetch", "Tune retry backoff"]]]));
    expect(prompt).toContain('[1] concept "retry policy" -> file "src/retry.ts"');
    expect(prompt).toContain("Add retry policy to fetch");
    expect(prompt).toContain("Tune retry backoff");
    expect(prompt).toContain("none");
  });
});

// First trial on the live store (100 pairs): the model wrote `causes` for a
// gateway creating a PID file and a report file, at weight 0.8, and typed a
// file node literally named "memory". Two fixes, both here: the system prompt
// defines what each type means (causes/caused_by/fixes/blocked_by are for
// errors only), and an answer below minWeight is treated as none.
describe("typing prompt definitions and evidence", () => {
  it("defines the error-only types and the file-side types in the system prompt", () => {
    expect(GRAPH_TYPING_SYSTEM).toMatch(/causes[^\n]*error/i);
    expect(GRAPH_TYPING_SYSTEM).toMatch(/documents[^\n]*(explain|describ|record)/i);
    expect(GRAPH_TYPING_SYSTEM).toMatch(/implements[^\n]*(realis|code)/i);
  });

  // Trial 3 (2026-09-10): the evidence selector ranked titles that merely
  // mentioned the file, so a file-list observation ("Updated persistent
  // memory: ... names many files") typed "BOM documents Hermes_Gateway.cmd" at
  // 0.9. Evidence is now a gate, not a ranking: a snippet counts only when the
  // file and the concept sit in one window with a relation verb, and a
  // list-shaped observation never counts.
  it("keeps only observations that state a relation between the concept and the file", () => {
    const picked = pickEvidence(
      [
        { title: "Daily learning drip cron manual execution session", narrative: "ran the cron" },
        { title: "Scheduled forced restart of Hermes gateway", narrative: "automated the gateway restart: wrote force_restart_hermes_gateway.py to kill and relaunch the process" },
        { title: "Discord session: Japanese Python learning", narrative: "" },
        { title: "gateway restart automation via hidden script", narrative: "" },
      ],
      "gateway restart automation",
      "C:\\Users\\x\\force_restart_hermes_gateway.py",
      2,
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]).toContain("force_restart_hermes_gateway.py");
    expect(picked[0]).toContain("Scheduled forced restart of Hermes gateway");
  });

  it("rejects a file-list observation even though it names both, and one with no relation verb", () => {
    const picked = pickEvidence(
      [
        { title: "Updated persistent memory: PowerShell BOM issue", narrative: "files: Hermes_Gateway.cmd, gateway_state.json, notes.md, run.ps1, setup.sh, README.md; BOM noted" },
        { title: "BOM", narrative: "BOM Hermes_Gateway.cmd" },
      ],
      "BOM",
      "C:\\hermes\\Hermes_Gateway.cmd",
    );
    expect(picked).toEqual([]);
  });

  it("accepts a bare-title observation whose narrative states the relation, without the bare title", () => {
    const picked = pickEvidence(
      [{ title: "Bash", narrative: "the retry policy is implemented in src/retry.ts with exponential backoff" }],
      "retry policy",
      "src/retry.ts",
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]).toContain("implemented in src/retry.ts");
    expect(picked[0]).not.toMatch(/^Bash --/);
  });
});

describe("isTypeableConcept", () => {
  it("rejects shell commands, tool names, paths, and sentences", () => {
    for (const bad of [
      "git status",
      "git log",
      "commit range",
      "PowerShell command execution",
      "npm run build --watch",
      "Bash",
      "Read",
      "prompt_submit",
      "src/auth.ts",
      "ab",
      "Inspecting the projection coordinator for a race on the retry path",
    ]) {
      expect(isTypeableConcept(bad), bad).toBe(false);
    }
  });

  it("accepts domain concepts", () => {
    for (const good of ["JSON schema validation", "GitHub Actions workflow", "keyed mutex", "BOM", "retry policy", "pytest"]) {
      expect(isTypeableConcept(good), good).toBe(true);
    }
  });
});

describe("parseTypingResponse", () => {
  const candidates = [
    { edge: edge("e1", "related_to", "n_c", "n_f", ["o1"]), source: concept, target: file },
    { edge: edge("e2", "related_to", "n_c2", "n_f", ["o1"]), source: otherConcept, target: file },
    { edge: edge("e3", "related_to", "n_c", "n_c2", ["o1"]), source: concept, target: otherConcept },
  ];

  it("accepts closed-vocabulary types with a clamped weight, and drops none / unknown / rule-breaking", () => {
    const xml = `
      <pairs>
        <pair i="1" type="implements" weight="0.9"/>
        <pair i="2" type="none"/>
        <pair i="3" type="modifies" weight="0.8"/>
        <pair i="4" type="documents" weight="0.7"/>
        <pair i="1" type="banana" weight="1.5"/>
      </pairs>`;
    const out = parseTypingResponse(xml, candidates);
    // modifies must target a file or function; pair 3 targets a concept, so the
    // schema's own rule rejects it -- the same rule the extractor is held to.
    expect(out.typed.map((t) => [t.candidate.edge.id, t.type, t.weight])).toEqual([["e1", "implements", 0.9]]);
    expect(out.none).toEqual(["e2"]);
    expect(out.rejected.map((r) => r.edgeId).sort()).toEqual(["e1", "e3"]);
  });

  it("treats an answer below minWeight as none rather than writing a weak typed edge", () => {
    const out = parseTypingResponse('<pairs><pair i="1" type="uses" weight="0.4"/><pair i="2" type="uses" weight="0.6"/></pairs>', candidates, { minWeight: 0.6 });
    expect(out.typed.map((t) => t.candidate.edge.id)).toEqual(["e2"]);
    expect(out.none).toEqual(["e1"]);
  });
});

describe("mem::graph-type-backfill", () => {
  it("writes a typed edge, supersedes the related_to, and reports what it did", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const n of [concept, file, otherConcept]) await kv.set(KV.graphNodes, n.id, n);
    const rel = edge("e_rel", "related_to", "n_c", "n_f", ["o1", "o2", "o3"], {
      sourceRefs: [
        { sourceKind: "observation", sourceId: "o1", sessionId: "ses_1" },
        { sourceKind: "observation", sourceId: "o2", sessionId: "ses_1" },
      ] as GraphEdge["sourceRefs"],
    });
    await kv.set(KV.graphEdges, rel.id, rel);
    await kv.set(KV.observations("ses_1"), "o1", obs("o1", "Implement retry policy in src/retry.ts"));
    await kv.set(KV.observations("ses_1"), "o2", obs("o2", "Retry policy backoff tuning"));

    const provider = {
      name: "test",
      compress: vi.fn().mockResolvedValue('<pairs><pair i="1" type="implements" weight="0.85"/></pairs>'),
      summarize: vi.fn(),
    };
    registerGraphTypeBackfill(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::graph-type-backfill", {
      minBacking: 2,
      batchSize: 20,
      maxBatches: 1,
    })) as { candidates: number; asked: number; typed: number; none: number; rejected: number; attemptedEdgeIds: string[] };

    expect(result).toMatchObject({ candidates: 1, asked: 1, typed: 1, none: 0, rejected: 0, attemptedEdgeIds: ["e_rel"] });
    // The model saw the evidence, not just the names.
    expect(String(provider.compress.mock.calls[0][1])).toContain("Implement retry policy in src/retry.ts");

    const edges = await kv.list<GraphEdge>(KV.graphEdges);
    const typed = edges.find((e) => e.type === "implements");
    const old = edges.find((e) => e.id === "e_rel");
    expect(typed).toMatchObject({ sourceNodeId: "n_c", targetNodeId: "n_f", weight: 0.85, sourceObservationIds: ["o1", "o2", "o3"] });
    // The edge carries what the model was shown, so a reader can judge it later.
    expect(typed!.context?.evidence?.[0]).toContain("Implement retry policy in src/retry.ts");
    expect(old).toMatchObject({ stale: true, isLatest: false, supersededBy: typed!.id });
    expect(await kv.get(KV.graphEdgeHistory, "e_rel")).toMatchObject({ supersededBy: typed!.id });
  });

  it("explains, in a dry run, why each candidate's evidence passes or fails the gate, asking nothing", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const n of [concept, file]) await kv.set(KV.graphNodes, n.id, n);
    const rel = edge("e_rel", "related_to", "n_c", "n_f", ["o1", "o2", "o3"], {
      sourceRefs: [
        { sourceKind: "observation", sourceId: "o1", sessionId: "ses_1" },
        { sourceKind: "observation", sourceId: "o2", sessionId: "ses_1" },
        { sourceKind: "observation", sourceId: "o3", sessionId: "ses_1" },
      ] as GraphEdge["sourceRefs"],
    });
    await kv.set(KV.graphEdges, rel.id, rel);
    await kv.set(KV.observations("ses_1"), "o1", obs("o1", "Implement retry policy in src/retry.ts"));
    const list = obs("o2", "Updated notes");
    list.narrative = "files: src/retry.ts, src/a.ts, src/b.ts, src/c.ts, docs/d.md; retry policy noted";
    await kv.set(KV.observations("ses_1"), "o2", list);
    const noVerb = obs("o3", "retry policy src/retry.ts");
    noVerb.narrative = "retry policy src/retry.ts";
    await kv.set(KV.observations("ses_1"), "o3", noVerb);

    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerGraphTypeBackfill(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::graph-type-backfill", { minBacking: 2, dryRun: true, explain: true })) as {
      asked: number; explained: Array<Record<string, unknown>>;
    };

    expect(provider.compress).not.toHaveBeenCalled();
    expect(result.asked).toBe(0);
    expect(result.explained).toHaveLength(1);
    expect(result.explained[0]).toMatchObject({
      edgeId: "e_rel", concept: "retry policy", file: "src/retry.ts", backing: 3,
      // o1 states the relation; o2 names both with a verb ("Updated") but lists
      // five files; o3 names both and has no verb at all.
      read: 3, withFile: 3, listShaped: 1, withConcept: 3, withVerb: 2, gated: 1,
    });
    expect((await kv.list<GraphEdge>(KV.graphEdges)).map((e) => e.type)).toEqual(["related_to"]);
  });

  // Live store 2026-09-11 02:36: the top-100 candidates carry 100-298 backing
  // observation ids each, but only 1-7 sourceRefs, and evidence was read
  // through the refs alone -- so the gate saw two observations out of two
  // hundred and passed nothing. The projection row of an observation knows its
  // session, so ids without a ref are resolvable too.
  it("reads evidence for backing observation ids that have no sourceRef, through their projection rows", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const n of [concept, file]) await kv.set(KV.graphNodes, n.id, n);
    const rel = edge("e_rel", "related_to", "n_c", "n_f", ["o1", "o2", "o3"], {
      sourceRefs: [{ sourceKind: "observation", sourceId: "o1", sessionId: "ses_1" }] as GraphEdge["sourceRefs"],
    });
    await kv.set(KV.graphEdges, rel.id, rel);
    await kv.set(KV.observations("ses_1"), "o1", obs("o1", "Daily standup notes"));
    // o2 has no ref; its projection row says which session holds it.
    await kv.set(KV.observationProjections, "o2", { observationId: "o2", captureId: "c2", sessionId: "ses_2", status: "succeeded", attempts: 1, updatedAt: now });
    await kv.set(KV.observations("ses_2"), "o2", obs("o2", "Implement retry policy in src/retry.ts"));

    const provider = {
      name: "test",
      compress: vi.fn().mockResolvedValue('<pairs><pair i="1" type="implements" weight="0.85"/></pairs>'),
      summarize: vi.fn(),
    };
    registerGraphTypeBackfill(sdk as never, kv as never, provider as never);

    const explained = (await sdk.trigger("mem::graph-type-backfill", { minBacking: 2, dryRun: true, explain: true })) as {
      explained: Array<{ read: number; refs: number; gated: number }>;
    };
    expect(explained.explained[0]).toMatchObject({ refs: 1, read: 2, gated: 1 });

    const result = (await sdk.trigger("mem::graph-type-backfill", { minBacking: 2 })) as { asked: number; typed: number };
    expect(result).toMatchObject({ asked: 1, typed: 1 });
    expect(String(provider.compress.mock.calls[0][1])).toContain("Implement retry policy in src/retry.ts");
  });

  it("does not ask the model about a pair whose evidence only lists files, and reports it as skipped", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const n of [concept, file]) await kv.set(KV.graphNodes, n.id, n);
    const rel = edge("e_rel", "related_to", "n_c", "n_f", ["o1", "o2"], {
      sourceRefs: [
        { sourceKind: "observation", sourceId: "o1", sessionId: "ses_1" },
        { sourceKind: "observation", sourceId: "o2", sessionId: "ses_1" },
      ] as GraphEdge["sourceRefs"],
    });
    await kv.set(KV.graphEdges, rel.id, rel);
    const list = obs("o1", "Updated persistent memory notes");
    list.narrative = "files: src/retry.ts, src/a.ts, src/b.ts, src/c.ts, docs/d.md, e.json; retry policy noted";
    await kv.set(KV.observations("ses_1"), "o1", list);
    await kv.set(KV.observations("ses_1"), "o2", obs("o2", "Retry policy backoff tuning"));

    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerGraphTypeBackfill(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::graph-type-backfill", { minBacking: 2, batchSize: 20, maxBatches: 1 })) as {
      candidates: number; asked: number; typed: number; skipped: number; attemptedEdgeIds: string[];
    };

    expect(provider.compress).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 1, asked: 0, typed: 0, skipped: 1, attemptedEdgeIds: ["e_rel"] });
    const edges = await kv.list<GraphEdge>(KV.graphEdges);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "e_rel", type: "related_to" });
  });

  // Trial 2 re-typed pairs whose trial-1 typed edge had been reverted (stale).
  // persistGraphDelta merged the new decision into that same-key row, which
  // stayed stale, and the related_to was superseded anyway -- 34 pairs with
  // no live edge at all. A merged-into row must come back to life.
  it("revives a previously reverted typed edge for the same pair instead of leaving both stale", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const n of [concept, file]) await kv.set(KV.graphNodes, n.id, n);
    await kv.set(KV.graphEdges, "e_rel", edge("e_rel", "related_to", "n_c", "n_f", ["o1", "o2"], {
      sourceRefs: [{ sourceKind: "observation", sourceId: "o1", sessionId: "ses_1" }] as GraphEdge["sourceRefs"],
    }));
    // The evidence gate asks only pairs with an observation stating the relation.
    await kv.set(KV.observations("ses_1"), "o1", obs("o1", "Implement retry policy in src/retry.ts"));
    const reverted = edge("e_old_typed", "implements", "n_c", "n_f", ["o1"], { stale: true, isLatest: false, weight: 0.5 });
    await kv.set(KV.graphEdges, reverted.id, reverted);
    await kv.set(KV.graphEdgeKey, "n_c|n_f|implements", reverted.id);
    const provider = {
      name: "test",
      compress: vi.fn().mockResolvedValue('<pairs><pair i="1" type="implements" weight="0.9"/></pairs>'),
      summarize: vi.fn(),
    };
    registerGraphTypeBackfill(sdk as never, kv as never, provider as never);
    const result = (await sdk.trigger("mem::graph-type-backfill", { minBacking: 2 })) as { typed: number };
    expect(result.typed).toBe(1);
    const edges = await kv.list<GraphEdge>(KV.graphEdges);
    const live = edges.filter((e) => !e.stale && e.sourceNodeId === "n_c" && e.targetNodeId === "n_f");
    expect(live.map((e) => e.type)).toEqual(["implements"]);
    expect(live[0].weight).toBe(0.9);
    expect(edges.find((e) => e.id === "e_rel")).toMatchObject({ stale: true, supersededBy: live[0].id });
  });

  it("skips edges the caller has already attempted, so a resumable driver never re-asks", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const n of [concept, file]) await kv.set(KV.graphNodes, n.id, n);
    await kv.set(KV.graphEdges, "e_rel", edge("e_rel", "related_to", "n_c", "n_f", ["o1", "o2"]));
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn() };
    registerGraphTypeBackfill(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::graph-type-backfill", {
      minBacking: 2,
      skipEdgeIds: ["e_rel"],
    })) as { candidates: number; asked: number };
    expect(result).toMatchObject({ candidates: 0, asked: 0 });
    expect(provider.compress).not.toHaveBeenCalled();
  });
});
