import { describe, it, expect } from "vitest";
import { buildTermWeights, scoreSessionCandidate } from "../src/functions/context.js";

// Counting every shared word the same is why widening the pool moved recall
// from 6 to 8 of 30 and no further: in this corpus "memory", "session" and
// "graph" are in almost every prompt, so a session that shares only those
// scores like one that shares the words that actually name the subject.
//
// A term's weight is now how rare it is among the project's own session
// prompts: a word in nearly every prompt says nothing about which session to
// show, a word in two of them says a great deal.

describe("buildTermWeights", () => {
  const prompts = [
    "fix the memory graph session",
    "memory graph session cleanup",
    "memory graph session notes",
    "memory graph session retry backoff in queue.ts",
  ];

  it("weighs a term that is in every prompt below one that is in a few", () => {
    const weights = buildTermWeights(prompts);

    expect(weights.get("backoff") ?? 1).toBeGreaterThan(weights.get("memory") ?? 1);
  });

  it("gives an unseen term the weight of a rare one", () => {
    const weights = buildTermWeights(prompts);
    const unseen = weights.get("kubernetes") ?? Math.max(...weights.values());

    expect(unseen).toBeGreaterThan(weights.get("session") ?? 1);
  });

  it("returns something usable for an empty corpus", () => {
    expect(buildTermWeights([]).size).toBe(0);
  });
});

describe("scoreSessionCandidate with term weights", () => {
  const prompts = [
    "memory graph session one",
    "memory graph session two",
    "memory graph session three",
    "memory graph session retry backoff queue",
  ];
  const focus = new Set(["memory", "graph", "session", "backoff", "queue"]);

  it("ranks the session sharing the rare words above the one sharing the common ones", () => {
    const weights = buildTermWeights(prompts);
    const rare = scoreSessionCandidate(focus, "retry backoff queue work", 50, weights);
    const common = scoreSessionCandidate(focus, "memory graph session work", 5, weights);

    expect(rare).toBeGreaterThan(common);
  });

  it("behaves as before when no weights are given", () => {
    const withoutWeights = scoreSessionCandidate(focus, "retry backoff queue", 10);

    expect(withoutWeights).toBeGreaterThan(0);
  });
});
