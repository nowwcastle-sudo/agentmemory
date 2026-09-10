import { describe, it, expect } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, GraphEdge } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// Two defects the 2026-09-09 real-corpus A/B left standing (remaining
// problems #6):
//  - hubDiscount exempted both endpoints, so at maxDepth 1 (expansion) a
//    degree-400 tool-name node handed every one of its observations the same
//    score as a specific neighbour's single observation;
//  - extractEntitiesFromQuery only matched quoted or Capitalised tokens, so
//    the all-lowercase queries the probe uses never opened the entity leg.

function node(id: string, name: string, obs: string[]): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: obs,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function edge(id: string, a: string, b: string, weight = 0.8): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: a,
    targetNodeId: b,
    weight,
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-09-01T00:00:00.000Z",
    tcommit: "2026-09-01T00:00:00.000Z",
    isLatest: true,
  };
}

async function hubGraph() {
  const kv = mockKV();
  await kv.set(KV.graphNodes, "start", node("start", "auth.ts", ["obs_1"]));
  await kv.set(KV.graphNodes, "specific", node("specific", "jwt refresh", ["obs_specific"]));
  await kv.set(KV.graphNodes, "hub", node("hub", "Bash", ["obs_hub"]));
  await kv.set(KV.graphEdges, "e_specific", edge("e_specific", "start", "specific"));
  await kv.set(KV.graphEdges, "e_hub", edge("e_hub", "start", "hub"));
  for (let i = 0; i < 48; i += 1) {
    await kv.set(KV.graphNodes, `f${i}`, node(`f${i}`, `filler ${i}`, [`obs_f${i}`]));
    await kv.set(KV.graphEdges, `ef${i}`, edge(`ef${i}`, "hub", `f${i}`));
  }
  return kv;
}

describe("hub discount at the destination", () => {
  it("scores an observation behind a specific neighbour above one behind a hub at depth 1", async () => {
    const kv = await hubGraph();
    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.expandFromChunks(["obs_1"], 1, 10);
    const score = (id: string) => results.find((r) => r.obsId === id)?.score ?? -1;
    expect(score("obs_specific")).toBeGreaterThan(0);
    expect(score("obs_specific")).toBeGreaterThan(score("obs_hub"));
  });

  it("applies the same rule to entity search at depth 1 and leaves the matched node itself undiscounted", async () => {
    const kv = await hubGraph();
    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["auth.ts"], 1, 100);
    const score = (id: string) => results.find((r) => r.obsId === id)?.score ?? -1;
    expect(score("obs_1")).toBeGreaterThan(score("obs_specific"));
    expect(score("obs_specific")).toBeGreaterThan(score("obs_hub"));
  });
});

describe("entity names matched from the query against the live graph", () => {
  async function namedGraph() {
    const kv = mockKV();
    await kv.set(KV.graphNodes, "n1", node("n1", "Auth", ["obs_1"]));
    await kv.set(KV.graphNodes, "n2", node("n2", "insight index", ["obs_2"]));
    await kv.set(KV.graphNodes, "n3", node("n3", "the", ["obs_3"]));
    await kv.set(KV.graphNodes, "n4", node("n4", "ab", ["obs_4"]));
    return kv;
  }

  it("matches lowercase words and two-word phrases that name a node", async () => {
    const retrieval = new GraphRetrieval((await namedGraph()) as never);
    const names = await retrieval.matchEntityNames("how does the auth middleware use the insight index rebuild");
    expect(names.sort()).toEqual(["Auth", "insight index"]);
  });

  it("ignores stop words and tokens shorter than three characters even when a node carries that name", async () => {
    const retrieval = new GraphRetrieval((await namedGraph()) as never);
    expect(await retrieval.matchEntityNames("the ab")).toEqual([]);
  });

  it("returns nothing for a query that names no node, and caps the rest", async () => {
    const kv = mockKV();
    for (let i = 0; i < 8; i += 1) await kv.set(KV.graphNodes, `n${i}`, node(`n${i}`, `term${i}`, [`obs_${i}`]));
    const retrieval = new GraphRetrieval(kv as never);
    expect(await retrieval.matchEntityNames("nothing here at all")).toEqual([]);
    expect((await retrieval.matchEntityNames("term0 term1 term2 term3 term4 term5 term6 term7")).length).toBe(5);
  });

  it("learns a node written through the KV after the first match", async () => {
    const kv = await namedGraph();
    const retrieval = new GraphRetrieval(kv as never);
    expect(await retrieval.matchEntityNames("keyed mutex")).toEqual([]);
    await kv.set(KV.graphNodes, "n5", node("n5", "keyed mutex", ["obs_5"]));
    expect(await retrieval.matchEntityNames("keyed mutex")).toEqual(["keyed mutex"]);
    await kv.delete(KV.graphNodes, "n5");
    expect(await retrieval.matchEntityNames("keyed mutex")).toEqual([]);
  });
});
