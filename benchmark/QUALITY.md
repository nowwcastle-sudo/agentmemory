# agentmemory v0.6.0 — Search Quality Evaluation

**Date:** 2026-09-04T10:52:07.302Z
**Dataset:** 240 observations across 30 sessions (realistic coding project)
**Queries:** 20 labeled queries with ground-truth relevance
**Metric definitions:** Recall@K (fraction of relevant docs in top K), Precision@K (fraction of top K that are relevant), NDCG@10 (ranking quality), MRR (position of first relevant result)

## Head-to-Head Comparison

| System | Recall@5 | Recall@10 | Precision@5 | NDCG@10 | MRR | Latency | Tokens/query |
|--------|----------|-----------|-------------|---------|-----|---------|--------------|
| Built-in (CLAUDE.md / grep) | 37.0% | 55.8% | 78.0% | 80.3% | 82.5% | 0.75ms | 22,610 |
| Built-in (200-line MEMORY.md) | 27.4% | 37.8% | 63.0% | 56.4% | 65.5% | 0.45ms | 7,938 |
| BM25-only | 42.5% | 57.9% | 90.0% | 84.7% | 91.7% | 0.39ms | 3,142 |
| Dual-stream (BM25+Vector) | 42.5% | 58.6% | 90.0% | 84.0% | 91.0% | 2.15ms | 3,142 |
| Triple-stream (BM25+Vector+Graph) | 37.5% | 58.6% | 85.0% | 81.7% | 86.9% | 4.03ms | 3,142 |

## Why This Matters

**Recall improvement:** agentmemory triple-stream finds 58.6% of relevant memories at K=10 vs 55.8% for keyword grep (+5%)
**Token savings:** agentmemory returns only the top 10 results (3,142 tokens) vs loading everything into context (22,610 tokens) — 86% reduction
**200-line cap:** Claude Code's MEMORY.md is capped at 200 lines. With 240 observations, 37.8% recall at K=10 — memories from later sessions are simply invisible.

## Per-Query Breakdown (Triple-Stream)

| Query | Category | Recall@10 | NDCG@10 | MRR | Relevant | Latency |
|-------|----------|-----------|---------|-----|----------|---------|
| How did we set up authentication? | semantic | 50.0% | 100.0% | 100.0% | 20 | 6.9ms |
| JWT token validation middleware | exact | 50.0% | 64.9% | 100.0% | 10 | 3.1ms |
| PostgreSQL connection issues | semantic | 33.3% | 100.0% | 100.0% | 30 | 2.8ms |
| Playwright test configuration | exact | 100.0% | 100.0% | 100.0% | 10 | 2.8ms |
| Why did the production deployment fail? | cross-session | 33.3% | 100.0% | 100.0% | 30 | 7.2ms |
| rate limiting implementation | exact | 100.0% | 100.0% | 100.0% | 10 | 2.1ms |
| What security measures did we add? | semantic | 33.3% | 100.0% | 100.0% | 30 | 1.8ms |
| database performance optimization | semantic | 0.0% | 0.0% | 6.3% | 25 | 1.7ms |
| Kubernetes pod crash debugging | entity | 100.0% | 54.1% | 16.7% | 5 | 3.4ms |
| Docker containerization setup | entity | 100.0% | 100.0% | 100.0% | 10 | 2.5ms |
| How does caching work in the app? | semantic | 25.0% | 64.9% | 100.0% | 20 | 2.8ms |
| test infrastructure and factories | exact | 50.0% | 64.9% | 100.0% | 10 | 2.2ms |
| What happened with the OAuth callback error? | cross-session | 100.0% | 100.0% | 100.0% | 5 | 4.0ms |
| monitoring and observability setup | semantic | 66.7% | 100.0% | 100.0% | 15 | 3.1ms |
| Prisma ORM configuration | entity | 28.6% | 100.0% | 100.0% | 35 | 3.9ms |
| CI/CD pipeline configuration | exact | 20.0% | 64.9% | 100.0% | 25 | 2.5ms |
| memory leak debugging | cross-session | 100.0% | 100.0% | 100.0% | 5 | 2.6ms |
| API design decisions | semantic | 15.0% | 20.6% | 14.3% | 20 | 14.8ms |
| zod validation schemas | entity | 66.7% | 100.0% | 100.0% | 15 | 3.5ms |
| infrastructure as code Terraform | entity | 100.0% | 100.0% | 100.0% | 5 | 7.0ms |

## By Query Category

| Category | Avg Recall@10 | Avg NDCG@10 | Avg MRR | Queries |
|----------|---------------|-------------|---------|---------|
| exact | 64.0% | 78.9% | 100.0% | 5 |
| semantic | 31.9% | 69.4% | 74.4% | 7 |
| cross-session | 77.8% | 100.0% | 100.0% | 3 |
| entity | 79.0% | 90.8% | 83.3% | 5 |

## Context Window Analysis

The fundamental problem with built-in agent memory:

| Observations | MEMORY.md tokens | agentmemory tokens (top 10) | Savings | MEMORY.md reachable |
|-------------|-----------------|---------------------------|---------|-------------------|
| 240 | 12,000 | 3,142 | 74% | 83% |
| 500 | 25,000 | 3,142 | 87% | 40% |
| 1,000 | 50,000 | 3,142 | 94% | 20% |
| 5,000 | 250,000 | 3,142 | 99% | 4% |

At 240 observations (our dataset), MEMORY.md already hits its 200-line cap and loses access to the most recent 40 observations. At 1,000 observations, 80% of memories are invisible. agentmemory always searches the full corpus.

---

*100 evaluations across 5 systems. Ground-truth labels assigned by concept matching against observation metadata.*