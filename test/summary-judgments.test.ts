import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUMMARY_JUDGMENT_TAG,
  buildSummaryJudgmentDelta,
  judgmentRejectReason,
  registerSummaryJudgmentFunction,
} from "../src/functions/summary-judgments.js";
import { readProjectRelations } from "../src/functions/graph-relations-index.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, Session, SessionSummary } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// Stage 2 of the ontology work: judgment relations from a summary's
// keyDecisions. Spike, graded by hand on 50 decisions: good 27% -> 60% once
// the prompt named topics and the filters below were added.

const session: Session = {
  id: "s1", project: "p1", cwd: "/repo", startedAt: "2026-09-18T00:00:00.000Z",
  status: "completed", observationCount: 3,
};
const summary: SessionSummary = {
  sessionId: "s1", project: "p1", createdAt: "2026-09-18T01:00:00.000Z",
  title: "Branch sync", narrative: "n",
  keyDecisions: [
    "Used fast-forward-only merge (git pull --ff-only) to sync branch with origin/main — no merge/rebase/reset",
    "Left the cheat-sheet unchanged",
  ],
  filesModified: [], concepts: [], observationCount: 3,
};
const XML = `<entities>
  <entity type="concept" name="branch sync method"/>
  <entity type="pattern" name="fast-forward-only merge"/>
</entities>
<relationships>
  <relationship type="prefers" source="branch sync method" target="fast-forward-only merge" decision="1"/>
  <relationship type="rejected" source="branch sync method" target="rebase" decision="1"/>
  <relationship type="uses" source="branch sync method" target="git" decision="1"/>
  <relationship type="avoids" source="branch sync method" target="force push" decision="1"/>
</relationships>`;

describe("judgmentRejectReason", () => {
  const decision = summary.keyDecisions[0];
  const rel = (type: string, source: string, target: string) => ({ type, source, target, decision: 1 });

  it("keeps a grounded judgment relation", () => {
    expect(judgmentRejectReason(rel("prefers", "branch sync method", "fast-forward-only merge"), decision)).toBeNull();
  });

  it("drops a type outside the judgment family", () => {
    expect(judgmentRejectReason(rel("uses", "branch sync method", "merge"), decision)).toBe("type");
  });

  it("drops a relation whose target restates its source", () => {
    expect(judgmentRejectReason(rel("prefers", "commit UX task 11 as is", "UX task 11"), "Commit UX task 11 as is")).toBe("tautology");
  });

  it("drops a target the decision text does not contain", () => {
    expect(judgmentRejectReason(rel("avoids", "branch sync method", "force push"), decision)).toBe("ungrounded-target");
  });

  // v2 let "멀티테enant" through: three of its four words were in the text.
  it("drops a name that mixes Hangul and Latin inside one word", () => {
    const korean = "멀티테넌트 및 데이터 격리 강조";
    expect(judgmentRejectReason(rel("prefers", "제안서 강조 방식", "멀티테enant 및 데이터 격리"), korean)).toBe("mixed-script");
  });

  it("drops a name that carries a ledger option label", () => {
    const text = "Resolve AC2 as confirmed based on independent reproducibility";
    expect(judgmentRejectReason(rel("prefers", "AC2 resolution method", "independent reproducibility"), text)).toBe("option-label");
  });
});

describe("buildSummaryJudgmentDelta", () => {
  it("turns accepted relations into edges that name their summary's session and carry the tag", () => {
    const { nodes, edges, dropped } = buildSummaryJudgmentDelta(summary, session, XML, "2026-09-18T02:00:00.000Z");
    expect(edges.map((e) => e.type)).toEqual(["prefers", "rejected"]);
    for (const edge of edges) {
      expect(edge.sourceRefs).toEqual([{ sourceKind: "summary", sourceId: "s1", sessionId: "s1", projectId: "p1" }]);
      expect(edge.projectId).toBe("p1");
      expect(edge.context?.reasoning).toBe(SUMMARY_JUDGMENT_TAG);
      expect(edge.context?.evidence).toEqual([summary.keyDecisions[0]]);
    }
    expect(dropped).toEqual({ type: 1, "ungrounded-target": 1 });
    // "rebase" was never declared as an entity; it is typed concept, not lost.
    expect(nodes.find((n) => n.name === "rebase")?.type).toBe("concept");
  });
});

describe("mem::summary-judgments", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env["GRAPH_EXTRACTION_ENABLED"];
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env["GRAPH_EXTRACTION_ENABLED"];
    else process.env["GRAPH_EXTRACTION_ENABLED"] = previous;
  });

  function wire(response = XML) {
    const kv = mockKV();
    const provider = { name: "test", compress: vi.fn().mockResolvedValue(response), summarize: vi.fn() };
    const sdk = { registerFunction: vi.fn(), registerTrigger: vi.fn() };
    const core = registerSummaryJudgmentFunction(sdk as never, kv as never, provider as never);
    return { kv, provider, core };
  }

  it("persists the relations and puts them in the project's relations index", async () => {
    const { kv, core } = wire();
    await kv.set(KV.sessions, "s1", session);
    await kv.set(KV.summaries, "s1", summary);
    const result = await core({ sessionId: "s1" });
    expect(result).toMatchObject({ success: true, edgesAdded: 2 });
    const stored = await kv.list<GraphEdge>(KV.graphEdges);
    expect(stored.filter((e) => e.context?.reasoning === SUMMARY_JUDGMENT_TAG)).toHaveLength(2);
    const rows = await readProjectRelations(kv as never, "p1");
    expect(rows.map((r) => r.type).sort()).toEqual(["prefers", "rejected"]);
    expect(rows[0].sessions).toEqual(["s1"]);
  });

  it("makes no LLM call for a summary without decisions", async () => {
    const { kv, provider, core } = wire();
    await kv.set(KV.sessions, "s1", session);
    await kv.set(KV.summaries, "s1", { ...summary, keyDecisions: [] });
    expect(await core({ sessionId: "s1" })).toMatchObject({ success: true, edgesAdded: 0 });
    expect(provider.compress).not.toHaveBeenCalled();
  });

  it("does nothing while graph extraction is off", async () => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "false";
    const { kv, provider, core } = wire();
    await kv.set(KV.sessions, "s1", session);
    await kv.set(KV.summaries, "s1", summary);
    expect(await core({ sessionId: "s1" })).toMatchObject({ success: true, skipped: "graph_extraction_disabled" });
    expect(provider.compress).not.toHaveBeenCalled();
  });
});
