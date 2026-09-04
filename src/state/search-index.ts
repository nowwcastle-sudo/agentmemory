import type {
  CompressedObservation,
  GraphSourceKind,
  GraphSourceLocator,
  GraphVisibility,
  RetrievalScope,
} from "../types.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";
import {
  matchesRetrievalScope,
  observationRetrievalMetadata,
} from "./retrieval-scope.js";

interface IndexEntry {
  obsId: string;
  sessionId: string;
  termCount: number;
  sourceKind?: GraphSourceKind;
  projectId?: string;
  actorAgentId?: string;
  visibility?: GraphVisibility;
}

type PersistedIndexDocument = [
  string,
  IndexEntry,
  Array<[string, number]>,
];

export class SearchIndex {
  private entries: Map<string, IndexEntry> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private docTermCounts: Map<string, Map<string, number>> = new Map();
  private totalDocLength = 0;
  private sortedTerms: string[] | null = null;

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(obs: CompressedObservation): void {
    const terms = this.extractTerms(obs);
    const termFreq = new Map<string, number>();
    let termCount = 0;

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      termCount++;
    }

    const metadata = observationRetrievalMetadata(obs);
    this.entries.set(obs.id, {
      obsId: obs.id,
      sessionId: obs.sessionId,
      termCount,
      ...(metadata.sourceKind ? { sourceKind: metadata.sourceKind } : {}),
      ...(metadata.projectId ? { projectId: metadata.projectId } : {}),
      ...(metadata.actorAgentId
        ? { actorAgentId: metadata.actorAgentId }
        : {}),
      ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
    });
    this.docTermCounts.set(obs.id, termFreq);
    this.totalDocLength += termCount;

    for (const term of termFreq.keys()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Set());
      }
      this.invertedIndex.get(term)!.add(obs.id);
    }

    this.sortedTerms = null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const termFreq = this.docTermCounts.get(id);
    if (termFreq) {
      for (const term of termFreq.keys()) {
        const postingList = this.invertedIndex.get(term);
        if (postingList) {
          postingList.delete(id);
          if (postingList.size === 0) {
            this.invertedIndex.delete(term);
          }
        }
      }
      this.docTermCounts.delete(id);
    }

    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
    this.sortedTerms = null;
  }

  search(
    query: string,
    limit = 20,
    scope?: RetrievalScope,
  ): Array<{
    obsId: string;
    sessionId: string;
    score: number;
    source: GraphSourceLocator;
  }> {
    const rawTerms = this.tokenize(query.toLowerCase());
    if (rawTerms.length === 0) return [];

    const scopedEntries = Array.from(this.entries.values()).filter((entry) =>
      matchesRetrievalScope(entry, scope),
    );
    const N = scopedEntries.length;
    if (N === 0) return [];
    const avgDocLen =
      scopedEntries.reduce((total, entry) => total + entry.termCount, 0) / N;

    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of rawTerms) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1.0 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<string, number>();
    const sorted = this.getSortedTerms();

    for (const { term, weight } of queryTerms) {
      const matchingDocs = this.invertedIndex.get(term);
      if (matchingDocs) {
        const scopedDocs = Array.from(matchingDocs).filter((obsId) =>
          matchesRetrievalScope(this.entries.get(obsId)!, scope),
        );
        const df = scopedDocs.length;
        if (df === 0) continue;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        for (const obsId of scopedDocs) {
          const entry = this.entries.get(obsId)!;
          const docTerms = this.docTermCounts.get(obsId);
          const tf = docTerms?.get(term) || 0;
          const docLen = entry.termCount;

          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const bm25Score = idf * (numerator / denominator) * weight;

          scores.set(obsId, (scores.get(obsId) || 0) + bm25Score);
        }
      }

      const startIdx = this.lowerBound(sorted, term);
      for (let si = startIdx; si < sorted.length; si++) {
        const indexTerm = sorted[si];
        if (!indexTerm.startsWith(term)) break;
        if (indexTerm === term) continue;

        const obsIds = this.invertedIndex.get(indexTerm)!;
        const scopedObsIds = Array.from(obsIds).filter((obsId) =>
          matchesRetrievalScope(this.entries.get(obsId)!, scope),
        );
        const prefixDf = scopedObsIds.length;
        if (prefixDf === 0) continue;
        const prefixIdf =
          Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5;
        for (const obsId of scopedObsIds) {
          const entry = this.entries.get(obsId)!;
          const docTerms = this.docTermCounts.get(obsId);
          const tf = docTerms?.get(indexTerm) || 0;
          const docLen = entry.termCount;
          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          scores.set(
            obsId,
            (scores.get(obsId) || 0) + prefixIdf * (numerator / denominator) * weight,
          );
        }
      }
    }

    return Array.from(scores.entries())
      .map(([obsId, score]) => {
        const entry = this.entries.get(obsId)!;
        return {
          obsId,
          sessionId: entry.sessionId,
          score,
          source: this.entryLocator(entry),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.invertedIndex.clear();
    this.docTermCounts.clear();
    this.totalDocLength = 0;
    this.sortedTerms = null;
  }

  restoreFrom(other: SearchIndex): void {
    this.entries = new Map(
      Array.from(other.entries.entries()).map(([k, v]) => [k, { ...v }]),
    );
    this.invertedIndex = new Map(
      Array.from(other.invertedIndex.entries()).map(([k, v]) => [
        k,
        new Set(v),
      ]),
    );
    this.docTermCounts = new Map(
      Array.from(other.docTermCounts.entries()).map(([k, v]) => [
        k,
        new Map(v),
      ]),
    );
    this.totalDocLength = other.totalDocLength;
    this.sortedTerms = null;
  }

  serialize(): string {
    const documents = Array.from(this.entries.entries()).map(
      ([id, entry]) => [
        id,
        entry,
        Array.from(this.docTermCounts.get(id)?.entries() ?? []),
      ] as PersistedIndexDocument,
    );
    return JSON.stringify({
      v: 3,
      documents,
    });
  }

  static deserialize(json: string): SearchIndex {
    try {
      const idx = new SearchIndex();
      const data = JSON.parse(json);
      if (data?.v === 3 && Array.isArray(data.documents)) {
        for (const [
          key,
          entry,
          persistedCounts,
        ] of data.documents as PersistedIndexDocument[]) {
          const counts = new Map(persistedCounts);
          idx.entries.set(key, entry);
          idx.docTermCounts.set(key, counts);
          idx.totalDocLength += entry.termCount;
          for (const term of counts.keys()) {
            const postingList = idx.invertedIndex.get(term) ?? new Set<string>();
            postingList.add(key);
            idx.invertedIndex.set(term, postingList);
          }
        }
        return idx;
      }
      if (!data?.entries || !data?.inverted || !data?.docTerms) return idx;
      for (const [key, val] of data.entries) {
        idx.entries.set(key, val);
      }
      for (const [term, ids] of data.inverted) {
        idx.invertedIndex.set(term, new Set(ids));
      }
      for (const [id, counts] of data.docTerms) {
        idx.docTermCounts.set(id, new Map(counts));
      }
      const rawLen = Number(data.totalDocLength);
      idx.totalDocLength =
        Number.isFinite(rawLen) && rawLen >= 0 ? Math.floor(rawLen) : 0;
      return idx;
    } catch {
      return new SearchIndex();
    }
  }

  private extractTerms(obs: CompressedObservation): string[] {
    const parts = [
      obs.title,
      obs.subtitle || "",
      obs.narrative,
      ...obs.facts,
      ...obs.concepts,
      ...obs.files,
      obs.type,
    ];
    return this.tokenize(parts.join(" ").toLowerCase());
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2) continue;
      if (hasCjk(raw)) {
        for (const seg of segmentCjk(raw)) {
          if (seg.length >= 1) out.push(seg);
        }
      } else {
        out.push(stem(raw));
      }
    }
    return out;
  }

  private getSortedTerms(): string[] {
    if (!this.sortedTerms) {
      this.sortedTerms = Array.from(this.invertedIndex.keys()).sort();
    }
    return this.sortedTerms;
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private entryLocator(entry: IndexEntry): GraphSourceLocator {
    return {
      sourceKind: entry.sourceKind ??
        (entry.obsId.startsWith("mem_") ? "memory" : "observation"),
      sourceId: entry.obsId,
      sessionId: entry.sessionId,
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.actorAgentId
        ? { actorAgentId: entry.actorAgentId }
        : {}),
      ...(entry.visibility ? { visibility: entry.visibility } : {}),
    };
  }
}
