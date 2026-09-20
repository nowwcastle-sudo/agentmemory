import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  indexSummaries,
  getSearchIndex,
  setVectorIndex,
  setEmbeddingProvider,
  searchSummaries,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { SessionSummary } from "../src/types.js";

// Word overlap took summary selection from 3 of 30 recall items to 11 and
// stopped: every remaining miss shares words with its target, and so do the
// sessions that beat it. Words are the wrong unit for the rest -- the same
// decision gets asked about in other words than it was written in.
//
// Summaries were never in the retrieval indexes at all; only observations
// and memories were. Putting them in gives selection the same keyword and
// vector machinery everything else already uses.

const summary = (sessionId: string, title: string, decisions: string[], project = "p1"): SessionSummary => ({
  sessionId,
  project,
  title,
  narrative: `${title} narrative`,
  keyDecisions: decisions,
  filesModified: [],
  concepts: [],
  observationCount: 2,
  createdAt: "2026-09-19T00:00:00.000Z",
});

// A stand-in embedding: one dimension per keyword, so "closeness" is
// predictable without loading a model in a unit test.
const KEYWORDS = ["timeout", "retry", "logo", "colour", "invoice"];
const fakeEmbed = (text: string): Float32Array => {
  const lower = text.toLowerCase();
  return Float32Array.from(KEYWORDS.map((k) => (lower.includes(k) ? 1 : 0)));
};

beforeEach(() => {
  getSearchIndex().clear();
  setVectorIndex(new VectorIndex());
  setEmbeddingProvider({
    name: "fake",
    dimensions: KEYWORDS.length,
    embed: async (text: string) => fakeEmbed(text),
    embedBatch: async (texts: string[]) => texts.map(fakeEmbed),
  } as never);
});

describe("indexSummaries", () => {
  it("puts a summary where keyword search can find it", async () => {
    const count = await indexSummaries(
      [summary("ses_1", "Acquire-timeout fix", ["Raise the acquire-timeout to thirty seconds"])],
      false,
    );

    expect(count).toBe(1);
    const hits = getSearchIndex().search("acquire-timeout", 5);
    expect(hits.some((h) => h.id === "summary:ses_1" || h.sessionId === "ses_1")).toBe(true);
  });

  it("skips a summary with no title", async () => {
    const empty = { ...summary("ses_2", "", []), title: "" };

    expect(await indexSummaries([empty], false)).toBe(0);
  });
});

describe("searchSummaries", () => {
  it("returns the session whose summary is closest, scored", async () => {
    await indexSummaries(
      [
        summary("ses_timeout", "Acquire-timeout fix", ["Raise the timeout"]),
        summary("ses_logo", "Logo colour pass", ["Use the teal colour"]),
      ],
      false,
    );

    const hits = await searchSummaries("the retry timeout keeps firing", "p1", 5);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sessionId).toBe("ses_timeout");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("keeps summaries of other projects out", async () => {
    await indexSummaries(
      [
        summary("ses_other", "Acquire-timeout fix", ["Raise the timeout"], "p2"),
        summary("ses_mine", "Logo colour pass", ["Use the teal colour"], "p1"),
      ],
      false,
    );

    const hits = await searchSummaries("timeout", "p1", 5);

    expect(hits.every((h) => h.sessionId !== "ses_other")).toBe(true);
  });

  it("answers nothing, rather than throwing, with no embedding provider", async () => {
    setEmbeddingProvider(null as never);

    expect(await searchSummaries("timeout", "p1", 5)).toEqual([]);
  });
});
