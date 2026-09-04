import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// A per-turn Stop is a checkpoint. Only a guarded true end may publish the
// terminal lifecycle that queues bounded summary and semantic graph work.
describe("api::session::end → event::session::ended", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("api::session::end fires event::session::ended after guarded completion", () => {
    expect(api).toMatch(
      /api::session::end[\s\S]*?completeActiveSession\(kv, sessionId\)[\s\S]*?completion\.transitioned[\s\S]*?fanOutSessionEnded\(sessionId\)/,
    );
    expect(api).toMatch(
      /fanOutSessionEnded[\s\S]*?function_id:\s*"event::session::ended"/,
    );
  });

  it("event::session::ended payload confirms the completed transition", () => {
    expect(api).toMatch(
      /function_id:\s*"event::session::ended",\s*payload:\s*\{\s*sessionId,\s*transitionConfirmed:\s*true\s*\}/,
    );
  });

  it("event::session::ended uses TriggerAction.Void for fire-and-forget", () => {
    expect(api).toMatch(
      /function_id:\s*"event::session::ended"[\s\S]*?action:\s*TriggerAction\.Void\(\)/,
    );
  });

  it("keeps checkpoint fan-out on event::session::stopped", () => {
    expect(api).toMatch(
      /api::session::checkpoint[\s\S]*?checkpoint\.checkpointed[\s\S]*?fanOutSessionStopped\(sessionId\)/,
    );
  });
});

// #666: viewer's "Build Graph" button used to POST /agentmemory/graph/build
// which returned 404 because the endpoint was never registered. Backfill
// the knowledge graph from existing compressed observations across every
// session in batches.
describe("api::graph-build endpoint (#666)", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("registers api::graph-build function", () => {
    expect(api).toMatch(/registerFunction\("api::graph-build"/);
  });

  it("registers HTTP trigger at /agentmemory/graph/build", () => {
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/build",\s*http_method:\s*"POST"/,
    );
  });

  it("iterates sessions and calls mem::graph-extract", () => {
    expect(api).toMatch(/kv\.list<Session>\(KV\.sessions\)/);
    expect(api).toMatch(/kv\.list<CompressedObservation>\(KV\.observations\(sid\)\)/);
    expect(api).toMatch(
      /sdk\.trigger\(\{\s*function_id:\s*"mem::graph-extract"/,
    );
  });

  it("filters observations that have a title (compressed only)", () => {
    expect(api).toMatch(/typeof o\.title === "string" && o\.title\.length > 0/);
  });

  it("respects batchSize override with a 100-item upper bound", () => {
    expect(api).toMatch(/Math\.min\(100,\s*Number\(.*batchSize/);
  });

  it("response shape matches what the viewer expects (success + nodes)", () => {
    expect(api).toMatch(/success:\s*true,\s*sessions:[\s\S]*?nodes:\s*totalNodes/);
  });

  // graph-schema: the viewer's Rejected tab reads this route.
  it("registers api::graph-rejected at GET /agentmemory/graph/rejected", () => {
    expect(api).toMatch(/registerFunction\("api::graph-rejected"/);
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/rejected",\s*http_method:\s*"GET"/,
    );
    expect(api).toMatch(/function_id:\s*"mem::graph-rejected"/);
  });
});

// #666: `agentmemory status` showed Memories/Observations as 0 because it
// fetched /agentmemory/export which times out on iii-engine's file-based
// KV under concurrent kv.list() pressure. Switch to /memories for the
// memory count and derive observation count from sessions[].observationCount.
describe("agentmemory status no longer depends on /export (#666)", () => {
  const cli = readFileSync("src/cli.ts", "utf-8");

  it("status uses count-only memories endpoint instead of export", () => {
    expect(cli).toMatch(/apiFetch<any>\(base,\s*"memories\?count=true"\)/);
    expect(cli).not.toMatch(/apiFetch<any>\(base,\s*"export"\)/);
  });

  it("status derives obsCount from sessions[].observationCount", () => {
    expect(cli).toMatch(
      /sessionList\.reduce\([\s\S]*?observationCount/,
    );
  });

  it("status reads memCount from memoriesRes.latestCount (count endpoint)", () => {
    expect(cli).toMatch(/memoriesRes\?\.latestCount\s*\?\?\s*memoriesRes\?\.total/);
  });
});
