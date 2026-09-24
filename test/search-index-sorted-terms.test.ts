import { describe, it, expect, vi } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

/**
 * Prefix matching walks a sorted copy of the vocabulary. It was dropped on
 * every add/remove, so while observations kept arriving each search re-sorted
 * the whole vocabulary: 43% of the worker's time on 2026-09-24. Adds and
 * removes now keep the sorted copy in place.
 */

function makeObs(id: string, narrative: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: "2026-09-24T00:00:00.000Z",
    type: "file_edit",
    title: "",
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance: 5,
  };
}

const ids = (index: SearchIndex, q: string) => index.search(q).map((r) => r.obsId).sort();

describe("SearchIndex sorted vocabulary", () => {
  it("does not re-sort the vocabulary when documents change between searches", () => {
    const index = new SearchIndex();
    index.add(makeObs("a", "alpha bravo"));
    index.search("alpha");

    const sort = vi.spyOn(Array.prototype, "sort");
    try {
      index.add(makeObs("b", "charlie delta"));
      index.remove("a");
      index.search("charlie");
      // Result ranking sorts with a comparator; the vocabulary sort has none.
      expect(sort.mock.calls.filter((args) => args.length === 0)).toEqual([]);
    } finally {
      sort.mockRestore();
    }
  });

  it("finds prefix matches for terms added and forgets terms removed after the first search", () => {
    const index = new SearchIndex();
    index.add(makeObs("a", "alpha"));
    expect(ids(index, "zulu")).toEqual([]);

    index.add(makeObs("z", "zulutime zebra"));
    index.add(makeObs("m", "mike"));
    expect(ids(index, "zulu")).toEqual(["z"]);
    expect(ids(index, "zeb")).toEqual(["z"]);

    index.remove("z");
    expect(ids(index, "zulu")).toEqual([]);
    expect(ids(index, "mik")).toEqual(["m"]);
  });

  it("keeps a term that another document still uses", () => {
    const index = new SearchIndex();
    index.add(makeObs("a", "shared"));
    index.add(makeObs("b", "shared"));
    index.search("sha");

    index.remove("a");
    expect(ids(index, "sha")).toEqual(["b"]);
  });
});
