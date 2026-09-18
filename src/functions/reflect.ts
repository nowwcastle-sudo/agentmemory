import type { ISdk } from "../iii-compat.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type {
  Insight,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  Lesson,
  Crystal,
  MemoryProvider,
} from "../types.js";
import { recordAudit } from "./audit.js";
import { REFLECT_SYSTEM, buildReflectPrompt } from "../prompts/reflect.js";
import { writeInsight, rebuildInsightIndex, insightTitleKey, type InsightIndexRow } from "./insight-index.js";

interface ConceptCluster {
  concepts: string[];
  facts: Array<{ fact: string; confidence: number }>;
  lessons: Array<{ content: string; confidence: number }>;
  crystalNarratives: string[];
  factIds: string[];
  lessonIds: string[];
  crystalIds: string[];
}

function reinforceInsight(insight: Insight): void {
  const now = new Date().toISOString();
  insight.reinforcements++;
  insight.confidence = Math.min(
    1.0,
    insight.confidence + 0.1 * (1 - insight.confidence),
  );
  insight.lastReinforcedAt = now;
  insight.updatedAt = now;
}

function buildGraphClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxClusters: number,
): string[][] {
  const conceptNodes = nodes.filter(
    (n) => n.type === "concept" && !n.stale,
  );
  if (conceptNodes.length === 0) return [];

  const edgeMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.stale) continue;
    if (!edgeMap.has(edge.sourceNodeId))
      edgeMap.set(edge.sourceNodeId, new Set());
    if (!edgeMap.has(edge.targetNodeId))
      edgeMap.set(edge.targetNodeId, new Set());
    edgeMap.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    edgeMap.get(edge.targetNodeId)!.add(edge.sourceNodeId);
  }

  const degree = new Map<string, number>();
  for (const node of conceptNodes) {
    degree.set(node.id, edgeMap.get(node.id)?.size || 0);
  }

  const sorted = [...conceptNodes].sort(
    (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0),
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];
  const conceptNodeIds = new Set(conceptNodes.map((n) => n.id));

  for (const seed of sorted) {
    if (visited.has(seed.id)) continue;
    if (clusters.length >= maxClusters) break;

    const cluster: string[] = [];
    const queue = [seed.id];
    const seen = new Set<string>();
    let depth = 0;

    while (queue.length > 0 && depth <= 2) {
      const levelCount = queue.length;
      for (let i = 0; i < levelCount; i++) {
        const current = queue.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);

        if (conceptNodeIds.has(current)) {
          const node = conceptNodes.find((n) => n.id === current);
          if (node) cluster.push(node.name);
          visited.add(current);
        }

        const neighbors = edgeMap.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!seen.has(neighbor)) queue.push(neighbor);
        }
      }
      depth++;
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

function buildJaccardClusters(
  semanticMemories: SemanticMemory[],
  lessons: Lesson[],
  maxClusters: number,
): string[][] {
  const allConcepts = new Map<string, Set<string>>();

  for (const sem of semanticMemories) {
    const terms = sem.fact.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    for (const term of terms) {
      if (!allConcepts.has(term)) allConcepts.set(term, new Set());
      allConcepts.get(term)!.add(sem.id);
    }
  }
  for (const lesson of lessons) {
    for (const tag of lesson.tags) {
      const key = tag.toLowerCase();
      if (!allConcepts.has(key)) allConcepts.set(key, new Set());
      allConcepts.get(key)!.add(lesson.id);
    }
  }

  const conceptList = [...allConcepts.keys()].filter(
    (k) => (allConcepts.get(k)?.size || 0) >= 2,
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const concept of conceptList) {
    if (visited.has(concept)) continue;
    if (clusters.length >= maxClusters) break;

    const cluster = [concept];
    visited.add(concept);

    const docsA = allConcepts.get(concept) || new Set();
    for (const other of conceptList) {
      if (visited.has(other)) continue;
      const docsB = allConcepts.get(other) || new Set();
      let intersection = 0;
      for (const d of docsA) {
        if (docsB.has(d)) intersection++;
      }
      const union = docsA.size + docsB.size - intersection;
      const similarity = union > 0 ? intersection / union : 0;
      if (similarity > 0.3) {
        cluster.push(other);
        visited.add(other);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

export function registerReflectFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::reflect", 
    async (data: {
      maxClusters?: number;
      offset?: number;
      project?: string;
      strict?: boolean;
      previousSourceFingerprint?: string;
    }) => {
      const maxClusters = Math.max(1, Math.min(data?.maxClusters ?? 10, 20));
      const offset = Math.max(0, Math.floor(data?.offset ?? 0));
      const maxInsightsPerCluster = 5;
      const maxTotal = 50;

      const [graphNodes, graphEdges, semanticMemories, lessons, crystals] =
        await Promise.all([
          kv.list<GraphNode>(KV.graphNodes).catch(() => []),
          kv.list<GraphEdge>(KV.graphEdges).catch(() => []),
          kv.list<SemanticMemory>(KV.semantic).catch(() => []),
          kv.list<Lesson>(KV.lessons).catch(() => []),
          kv.list<Crystal>(KV.crystals).catch(() => []),
        ]);

      let activeLessons = lessons.filter((l) => !l.deleted);
      if (data?.project) {
        activeLessons = activeLessons.filter((l) => l.project === data.project);
      }

      let allConceptClusters = buildGraphClusters(
        graphNodes,
        graphEdges,
        20,
      );

      const usedFallback = allConceptClusters.length === 0;
      if (usedFallback) {
        allConceptClusters = buildJaccardClusters(
          semanticMemories,
          activeLessons,
          20,
        );
      }
      const sourceFingerprint = fingerprintId(
        "maintenance-reflect",
        JSON.stringify({
          project: data?.project,
          clusters: allConceptClusters,
          semantic: semanticMemories
            .map((item) => [item.id, item.updatedAt])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          lessons: activeLessons
            .map((item) => [item.id, item.updatedAt])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          crystals: crystals
            .map((item) => item.id)
            .sort((a, b) => a.localeCompare(b)),
        }),
      );
      if (
        offset === 0 &&
        data?.previousSourceFingerprint === sourceFingerprint
      ) {
        return {
          success: true,
          skipped: true,
          reason: "source unchanged",
          sourceFingerprint,
        };
      }
      const conceptClusters = allConceptClusters.slice(
        offset,
        offset + maxClusters,
      );
      const nextOffset =
        offset + conceptClusters.length < allConceptClusters.length
          ? offset + conceptClusters.length
          : undefined;

      // Existing insights by title, so a reworded restatement reinforces the
      // insight it restates instead of becoming another copy of it.
      const indexRows = await kv
        .list<InsightIndexRow>(KV.insightIndex)
        .catch(() => [] as InsightIndexRow[]);
      const byTitle = new Map<string, string>();
      for (const row of indexRows) {
        if (!row.deleted) byTitle.set(insightTitleKey(row), row.id);
      }

      let newInsights = 0;
      let reinforced = 0;
      let clustersSkipped = 0;
      let totalInsights = 0;
      let firstError: string | undefined;

      for (const conceptNames of conceptClusters) {
        if (totalInsights >= maxTotal) break;

        const conceptSet = new Set(conceptNames.map((c) => c.toLowerCase()));

        const clusterFacts = semanticMemories.filter((s) => {
          const factTerms = s.fact.toLowerCase().split(/\s+/);
          return factTerms.some((t) => conceptSet.has(t));
        });

        const clusterLessons = activeLessons.filter((l) =>
          l.tags.some((t) => conceptSet.has(t.toLowerCase())) ||
          conceptNames.some((c) =>
            l.content.toLowerCase().includes(c.toLowerCase()),
          ),
        );

        const clusterCrystals = crystals.filter((c) =>
          (c.lessons || []).some((l) =>
            conceptNames.some((cn) =>
              l.toLowerCase().includes(cn.toLowerCase()),
            ),
          ),
        );

        const totalItems =
          clusterFacts.length + clusterLessons.length + clusterCrystals.length;
        if (totalItems < 3) {
          clustersSkipped++;
          continue;
        }

        const cluster: ConceptCluster = {
          concepts: conceptNames,
          facts: clusterFacts.map((f) => ({
            fact: f.fact,
            confidence: f.confidence,
          })),
          lessons: clusterLessons.map((l) => ({
            content: l.content,
            confidence: l.confidence,
          })),
          crystalNarratives: clusterCrystals.map((c) => c.narrative),
          factIds: clusterFacts.map((f) => f.id),
          lessonIds: clusterLessons.map((l) => l.id),
          crystalIds: clusterCrystals.map((c) => c.id),
        };

        try {
          const prompt = buildReflectPrompt(cluster);
          const response = await provider.summarize(REFLECT_SYSTEM, prompt);

          const insightRegex =
            /<insight\s+confidence="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/insight>/g;
          let match;
          let clusterCount = 0;

          while (
            (match = insightRegex.exec(response)) !== null &&
            clusterCount < maxInsightsPerCluster &&
            totalInsights < maxTotal
          ) {
            const parsedConf = parseFloat(match[1]);
            const confidence = Number.isNaN(parsedConf)
              ? 0.5
              : Math.max(0, Math.min(1, parsedConf));
            const title = match[2].trim();
            const content = match[3].trim();

            if (!content) continue;

            const fp = fingerprintId("ins", content.trim().toLowerCase());
            const titleKey = insightTitleKey({ title, project: data?.project });
            const sameTitleId = byTitle.get(titleKey);
            const existing =
              (await kv.get<Insight>(KV.insights, fp)) ??
              (sameTitleId ? await kv.get<Insight>(KV.insights, sameTitleId) : null);

            if (existing && !existing.deleted) {
              reinforceInsight(existing);
              await writeInsight(kv, existing);
              reinforced++;
            } else {
              const now = new Date().toISOString();
              const insight: Insight = {
                id: fp,
                title,
                content,
                confidence,
                reinforcements: 0,
                sourceConceptCluster: conceptNames,
                sourceMemoryIds: cluster.factIds,
                sourceLessonIds: cluster.lessonIds,
                sourceCrystalIds: cluster.crystalIds,
                project: data?.project,
                tags: conceptNames,
                createdAt: now,
                updatedAt: now,
                decayRate: 0.05,
              };
              await writeInsight(kv, insight);
              byTitle.set(titleKey, insight.id);
              newInsights++;
            }

            clusterCount++;
            totalInsights++;
          }
        } catch (error) {
          firstError =
            firstError ??
            (error instanceof Error ? error.message : String(error));
          continue;
        }
      }

      try {
        await recordAudit(kv, "reflect", "mem::reflect", [], {
          newInsights,
          reinforced,
          clustersProcessed: conceptClusters.length - clustersSkipped,
          clustersSkipped,
          usedFallback,
        });
      } catch {}

      return {
        success: !(data?.strict && firstError),
        ...(data?.strict && firstError ? { error: firstError } : {}),
        newInsights,
        reinforced,
        clustersProcessed: conceptClusters.length - clustersSkipped,
        clustersSkipped,
        usedFallback,
        sourceFingerprint,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
      };
    },
  );

  sdk.registerFunction("mem::insight-list", 
    async (data: {
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      const limit = data?.limit ?? 50;
      const minConfidence = data?.minConfidence ?? 0;
      let items = await kv.list<Insight>(KV.insights);

      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data?.project) {
        items = items.filter((i) => i.project === data.project);
      }

      items.sort((a, b) => b.confidence - a.confidence);

      return { success: true, insights: items.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::insight-search", 
    async (data: {
      query: string;
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      if (!data?.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const query = data.query.toLowerCase();
      const minConfidence = data.minConfidence ?? 0.1;
      const limit = data.limit ?? 10;

      let items = await kv.list<Insight>(KV.insights);
      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data.project) {
        items = items.filter((i) => i.project === data.project);
      }

      const terms = query.split(/\s+/).filter((t) => t.length > 1);
      const scored = items
        .map((i) => {
          const text =
            `${i.title} ${i.content} ${i.tags.join(" ")}`.toLowerCase();
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;

          const relevance = matchCount / terms.length;
          const daysSince = i.lastReinforcedAt
            ? (Date.now() - new Date(i.lastReinforcedAt).getTime()) /
              (1000 * 60 * 60 * 24)
            : (Date.now() - new Date(i.createdAt).getTime()) /
              (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSince * 0.01);
          const score = i.confidence * relevance * recencyBoost;

          return { insight: i, score };
        })
        .filter(Boolean) as Array<{ insight: Insight; score: number }>;

      scored.sort((a, b) => b.score - a.score);

      try {
        await recordAudit(kv, "insight_search", "mem::insight-search", [], {
          query: data.query,
          resultCount: scored.length,
        });
      } catch {}

      return {
        success: true,
        insights: scored.slice(0, limit).map((s) => ({
          ...s.insight,
          score: Math.round(s.score * 1000) / 1000,
        })),
      };
    },
  );

  // First run after deploy, and repair: the one deliberate full-scope list
  // of mem:insights. Same role as mem::graph-snapshot-rebuild.
  sdk.registerFunction("mem::insight-index-rebuild", async () => {
    const result = await rebuildInsightIndex(kv);
    return { success: true, ...result };
  });

  sdk.registerFunction("mem::insight-decay-sweep", 
    async () => {
      const items = await kv.list<Insight>(KV.insights);
      let decayed = 0;
      let softDeleted = 0;
      const now = Date.now();
      const timestamp = new Date().toISOString();
      const dirty: Insight[] = [];

      for (const insight of items) {
        if (insight.deleted) continue;

        const baseline =
          insight.lastDecayedAt ||
          insight.lastReinforcedAt ||
          insight.createdAt;
        const weeksSince =
          (now - new Date(baseline).getTime()) / (1000 * 60 * 60 * 24 * 7);

        if (weeksSince < 1) continue;

        const decay = insight.decayRate * weeksSince;
        const newConfidence = Math.max(0.05, insight.confidence - decay);

        if (newConfidence !== insight.confidence) {
          insight.confidence = Math.round(newConfidence * 1000) / 1000;
          insight.lastDecayedAt = timestamp;
          insight.updatedAt = timestamp;

          if (insight.confidence <= 0.1 && insight.reinforcements === 0) {
            insight.deleted = true;
            softDeleted++;
          } else {
            decayed++;
          }

          dirty.push(insight);
        }
      }

      await Promise.all(dirty.map((i) => writeInsight(kv, i)));
      await recordAudit(kv, "reflect", "mem::insight-decay-sweep", dirty.map((i) => i.id), {
        event: "insight.decay",
        decayed,
        softDeleted,
        total: items.length,
        timestamp,
      });

      return { success: true, decayed, softDeleted, total: items.length };
    },
  );
}
