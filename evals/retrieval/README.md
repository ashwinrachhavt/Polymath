# Retrieval evaluation (issue #533, Phase 1) - DRAFT

Status: **draft harness + draft candidate questions**. Every question in
`questions.ts` awaits the owner's manual review and labeling before it counts
as the issue's "manually reviewed" set. The corpus is synthetic; no real user
documents are used.

## Run

```
TEST_DATABASE_URL=<scratch postgres with pgvector> npx tsx evals/retrieval/run.ts
```

Writes `evals/retrieval/results/<run>.json` and prints a per-policy summary.
The embedding provider is a deterministic local hash: no paid calls, no
network.

## What it measures (retrieval level)

- Evidence recall / precision per admission policy (old 0.5 score floor,
  single-leg rank 0, experimental rank<=2, no admission)
- Abstention correctness on unanswerable questions
- Scope/version violations (archived documents, foreign-workspace decoy)
- p50/p95 latency, index chunk counts, evidence size proxies

Answer-level metrics (answer correctness, claim support, answer abstention)
are **unmeasured**: they require an answering model, which is a paid call and
is not authorized. They are reported as null, never invented.

## First measured result (draft set, 92 candidates, 2026-11-05)

| policy | recall | precision | abstention | violations |
| --- | --- | --- | --- | --- |
| old-floor-0.5 | 0.322 | 0.315 | 0.000 | 0 |
| single-leg-rank0 | 0.322 | 0.315 | 0.000 | 0 |
| experimental-rank2 | 0.467 | 0.176 | 0.000 | 0 |
| no-admission | 0.737 | 0.105 | 0.000 | 0 |

Two honest findings: the experimental rank<=2 rule lifts recall over the old
floor at a precision cost, and NO policy abstains on unanswerable questions -
retrieval always returns something, so "empty results" messaging can never
fire. Both need the owner-reviewed set before they become release thresholds.
