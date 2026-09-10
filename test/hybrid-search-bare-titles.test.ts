import { describe, it, expect } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

// Safety net under the retitle pass: a row whose title is still a bare tool
// name says nothing to the caller, so it ranks below a descriptive row that
// scored the same.

function obs(id: string, title: string, narrative: string): CompressedObservation {
  return {
    id, sessionId: "ses_1", timestamp: "2026-09-01T00:00:00.000Z", type: "command_run",
    title, facts: [], narrative, concepts: [], files: [], importance: 5, confidence: 0.3,
  };
}

describe("HybridSearch demotes bare titles", () => {
  it("ranks a descriptive row above a bare-titled row with the same match", async () => {
    const kv = mockKV();
    const bm25 = new SearchIndex();
    // The bare row matches the query harder (the terms repeat), so BM25 alone
    // puts it first; the demotion has to flip that.
    const bare = obs("obs_bare", "Bash", "retry policy tests: ran the retry policy tests again, retry policy tests green");
    const named = obs("obs_named", "Bash: npm test", "ran the retry policy tests once");
    for (const o of [bare, named]) {
      bm25.add(o);
      await kv.set(`mem:obs:ses_1`, o.id, o);
    }
    const search = new HybridSearch(bm25, null, null, kv as never, 1, 0, 0);
    const results = await search.search("retry policy tests", 5);
    expect(results.map((r) => r.observation.id)).toEqual(["obs_named", "obs_bare"]);
    expect(results[1].combinedScore).toBeLessThan(results[0].combinedScore);
  });
});
