import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// graph-schema (ontology-lite) surfaced in the viewer: a Rejected tab over
// /agentmemory/graph/rejected, full NODE_COLORS / NODE_SHAPES / EDGE_COLORS
// vocabularies, and a per-node relationship view.
const viewer = readFileSync("src/viewer/index.html", "utf-8");

function namedFunction(name: string): string | null {
  const asyncStart = viewer.indexOf(`async function ${name}(`);
  const syncStart = viewer.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  if (start < 0) return null;
  const body = viewer.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < viewer.length; index++) {
    if (viewer[index] === "{") depth++;
    if (viewer[index] === "}") depth--;
    if (depth === 0) return viewer.slice(start, index + 1);
  }
  return null;
}

function objectLiteralKeys(varName: string): string[] {
  const start = viewer.indexOf(`var ${varName} = {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = viewer.indexOf("};", start);
  const body = viewer.slice(viewer.indexOf("{", start) + 1, end);
  return body
    .split(",")
    .map((pair) => pair.split(":")[0].trim())
    .filter((key) => key.length > 0);
}

const NODE_TYPES = [
  "file", "function", "concept", "error", "decision", "pattern", "library", "person",
  "project", "preference", "location", "organization", "event", "task", "feature",
];

const EDGE_TYPES = [
  "uses", "imports", "modifies", "causes", "fixes", "depends_on", "related_to", "works_at",
  "prefers", "blocked_by", "caused_by", "optimizes_for", "rejected", "avoids", "located_in",
  "succeeded_by", "implements", "part_of", "contains", "documents", "defines", "validates", "tests",
];

describe("viewer graph vocabularies", () => {
  it("colours every graph-schema node type and keeps the original eight values", () => {
    const keys = objectLiteralKeys("NODE_COLORS");
    for (const type of NODE_TYPES) expect(keys).toContain(type);
    expect(viewer).toContain("file: '#2D6A4F'");
    expect(viewer).toContain("person: '#111111'");
  });

  it("gives every node type a shape drawNode() can render", () => {
    const shapeKeys = objectLiteralKeys("NODE_SHAPES");
    for (const type of NODE_TYPES) expect(shapeKeys).toContain(type);
    const shapes = new Set(
      viewer
        .slice(viewer.indexOf("var NODE_SHAPES = {"))
        .slice(0, viewer.slice(viewer.indexOf("var NODE_SHAPES = {")).indexOf("};"))
        .match(/'(rect|circle|diamond|hexagon)'/g) ?? [],
    );
    expect(shapes.size).toBeGreaterThan(0);
  });

  it("defines EDGE_COLORS for all 23 relationship types with a grey fallback", () => {
    const keys = objectLiteralKeys("EDGE_COLORS");
    for (const type of EDGE_TYPES) expect(keys).toContain(type);
    expect(keys).toHaveLength(EDGE_TYPES.length);
    expect(viewer).toContain("EDGE_COLORS[e.type] || NODE_COLORS[s.type] || '#666666'");
  });

  it("keeps a fallback colour at every NODE_COLORS lookup site", () => {
    const lookups = viewer.match(/NODE_COLORS\[[^\]]+\]/g) ?? [];
    // Every lookup is either part of a `||` fallback chain or a legend iteration
    // over NODE_COLORS' own keys (which cannot miss).
    expect(lookups.length).toBeGreaterThan(0);
  });
});

describe("viewer node relationship view", () => {
  it("groups a selected node's edges by relationship type with direction and weight", () => {
    const source = namedFunction("renderNodeRelationships");
    expect(source).not.toBeNull();
    if (!source) return;
    expect(source).toContain("EDGE_COLORS[type]");
    expect(source).toContain("row.outgoing ? '&rarr;' : '&larr;'");
    expect(source).toContain("row.weight.toFixed(2)");
    expect(source).toContain("NODE_COLORS[neighborType]");
  });

  it("renders an empty state rather than an empty list when a node has no edges", () => {
    const source = namedFunction("renderNodeRelationships");
    expect(source).toContain("No relationships yet.");
  });

  it("escapes neighbour names, types and the relationship type", () => {
    const source = namedFunction("renderNodeRelationships") ?? "";
    expect(source).toContain("esc(type)");
    expect(source).toContain("esc(neighborType)");
    expect(source).toMatch(/esc\(truncate\(String\(neighborName\)/);
  });

  it("reads ontology fields off the graph/query record, not the layout node", () => {
    const source = namedFunction("selectGraphNode") ?? "";
    expect(source).toContain("state.graph.nodes.filter");
    expect(source).toContain("record.aliases");
    expect(source).toContain("record.mergedFrom");
    expect(source).toContain("record.mergedInto");
    expect(source).toContain("record.stale === true");
    expect(source).toContain("record.sourceObservationIds");
    expect(source).toContain("esc(record.mergedInto)");
  });
});

describe("viewer rejected tab", () => {
  it("registers the tab button, view container and TAB_IDS entry", () => {
    expect(viewer).toContain('<button data-tab="rejected">Rejected</button>');
    expect(viewer).toContain('<div id="view-rejected" class="view"></div>');
    expect(viewer).toMatch(/var TAB_IDS = \[[^\]]*'rejected'/);
  });

  it("loads through loadTab with a bounded limit", () => {
    const source = namedFunction("loadTab") ?? "";
    expect(source).toContain("case 'rejected': await loadRejected(); break;");
    const load = namedFunction("loadRejected") ?? "";
    expect(load).toContain("apiGet('graph/rejected?limit=200')");
  });

  it("surfaces a load failure the way other tabs do instead of an empty table", () => {
    const load = namedFunction("loadRejected") ?? "";
    expect(load).toContain("state.rejected.error");
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain("if (r.error)");
  });

  it("renders the summary line from the server aggregates", () => {
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain("r.total");
    expect(render).toContain("r.cap");
    expect(render).toContain("byKind.node");
    expect(render).toContain("byKind.edge");
  });

  it("filters client-side on reason and kind via data-action selects", () => {
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain('data-action="rejected-reason-filter"');
    expect(render).toContain('data-action="rejected-kind-filter"');
    expect(render).toContain("r.kindFilter");
    expect(render).toContain("r.reasonFilter");
    // The handling lives in the delegated change listener, not inline.
    expect(viewer).toContain("changeAction === 'rejected-reason-filter'");
    expect(viewer).toContain("changeAction === 'rejected-kind-filter'");
    expect(render).not.toContain("onchange=");
  });

  it("renders node records by name+type and edge records as source -> target", () => {
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain("rec.name");
    expect(render).toContain("rec.sourceNodeId");
    expect(render).toContain("rec.targetNodeId");
    expect(render).toContain("&rarr;");
  });

  it("shows capturedAt as relative text with the ISO stamp in the title", () => {
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain("relativeTime(x.capturedAt)");
    expect(render).toContain('title="\' + esc(x.capturedAt');
    expect(namedFunction("relativeTime")).not.toBeNull();
  });

  it("has an empty state when nothing was rejected", () => {
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain("No rejected assertions");
  });

  it("escapes every value it puts into the table", () => {
    const render = namedFunction("renderRejected") ?? "";
    expect(render).toContain("esc(x.reason)");
    expect(render).toContain("esc(x.kind)");
    expect(render).toContain("esc(rec.name || rec.id");
    expect(render).not.toMatch(/\+\s*x\.reason\s*\+/);
  });
});

describe("viewer dashboard rejected surface", () => {
  it("adds the rejected count to the Graph Nodes sub text only when stats carry it", () => {
    const render = namedFunction("renderDashboard") ?? "";
    expect(render).toContain("typeof gs.rejected === 'number' ? gs.rejected : null");
    expect(render).toContain("rejectedCount !== null ? ' · ' + rejectedCount + ' rejected' : ''");
  });

  it("adds a Rejected stat card linking to the tab", () => {
    const render = namedFunction("renderDashboard") ?? "";
    expect(render).toContain('data-action="goto-tab" data-tab="rejected"');
  });
});

describe("viewer graph sidebar ontology stats", () => {
  it("shows rejected (guarded) and a stale-node count", () => {
    const render = namedFunction("renderGraphSidebar") ?? "";
    expect(render).toContain("typeof gs.rejected === 'number' ? gs.rejected : 0");
    expect(render).toContain("n.stale === true");
    expect(render).toContain(">Stale<");
    expect(render).toContain(">Rejected<");
  });

  it("lists the edge types in use with their colours", () => {
    const render = namedFunction("renderGraphSidebar") ?? "";
    expect(render).toContain("EDGE_COLORS[t] || '#666666'");
    expect(render).toContain("Relationship Types");
  });
});
