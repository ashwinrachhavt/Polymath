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

## Measured result (draft set, 116 candidates incl. 24 adversarial negatives, 2026-11-05)

| policy | recall | precision | abstention | violations |
| --- | --- | --- | --- | --- |
| old-floor-0.5 (PRODUCTION) | 0.322 | 0.250 | 0.000 | 0 |
| single-leg-rank0 | 0.322 | 0.250 | 0.000 | 0 |
| experimental-rank2 | 0.467 | 0.139 | 0.000 | 0 |
| no-admission | 0.737 | 0.083 | 0.000 | 0 |

Honest findings:
- The experimental rank<=2 rule lifts recall over the production floor at a
  steep precision cost (0.139 vs 0.250): NOT shipped. Production keeps the
  0.5 floor; finding 3 stays an open gap until a validated replacement exists.
- NO policy abstains on unanswerable or adversarial-negative questions:
  retrieval always returns something (the floor passes a single-leg rank-0
  hit at exactly 0.5, and the vector leg has no distance cutoff). The
  finding-7 "empty results" messaging can therefore never fire - a real
  abstention mechanism is a remaining gap, not a repaired finding.
- Zero scope/version violations across all policies (archived and
  foreign-workspace decoys never leaked).
