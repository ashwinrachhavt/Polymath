/*
 * Retrieval evaluation harness for issue #533 Phase 1. DRAFT: runs the draft
 * candidate question set (awaiting owner manual review) against a synthetic
 * corpus seeded into a scratch Postgres, and reports retrieval-level metrics
 * only: evidence recall, precision, abstention correctness, scope/version
 * violations, latency, and index/evidence size proxies.
 *
 * NOT measured here (requires an answering model = paid calls, not
 * authorized): answer correctness, claim support, answer-level abstention.
 * No invented results: those fields are reported as null.
 *
 * No paid calls: the embedding provider is a deterministic local hash. Run:
 *   TEST_DATABASE_URL=... npx tsx evals/retrieval/run.ts
 */
import { CORPUS } from "./corpus";
import { QUESTIONS } from "./questions";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required (scratch database only)");
process.env.DATABASE_URL = url;

type Row = Record<string, unknown>;

async function main() {
  const { makeTestDb, seedWorkspace } = await import("../../tests/helpers/test-workspace");
  const { db, client } = makeTestDb({ max: 3 });
  const { blobObjects } = await import("../../src/domains/audit/schema");
  const { documents, documentExtractions, embeddings, files } = await import("../../src/domains/knowledge/schema");
  const { chunkText, isCapped } = await import("../../src/domains/knowledge/chunking");
  const { EMBEDDING_OWNER_TYPE } = await import("../../src/domains/knowledge/embedding");
  const { EMBEDDING_DIMENSIONS } = await import("../../src/integrations/embeddings/provider");
  type EmbeddingProvider = import("../../src/integrations/embeddings/provider").EmbeddingProvider;
  const { searchChunks, searchChunksFts } = await import("../../src/domains/knowledge/search");
  const { searchDocumentsForAgent, rrfMerge, isEvidence, AGENT_SEARCH_MIN_SCORE } = await import("../../src/domains/knowledge/agent-search");

  const MODEL = "eval:hash-1536";
  const hashVector = (value: string) => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % EMBEDDING_DIMENSIONS;
      v[h] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
  const provider: EmbeddingProvider = { model: MODEL, embed: async (values: string[]) => values.map(hashVector) };

  const runId = `eval-${Date.now()}`;
  const a = await seedWorkspace(db, `${runId}-a`);
  const b = await seedWorkspace(db, `${runId}-b`);
  const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };

  let indexedChunks = 0;
  const seedDoc = async (
    ws: { userId: string; workspaceId: string },
    doc: (typeof CORPUS)[number],
  ) => {
    const [blob] = await db.insert(blobObjects).values({
      workspaceId: ws.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
      sizeBytes: doc.text.length, mimeType: "application/pdf",
    }).returning();
    const [file] = await db.insert(files).values({ workspaceId: ws.workspaceId, blobId: blob.id, filename: `${doc.key}.pdf` }).returning();
    const [d] = await db.insert(documents).values({
      workspaceId: ws.workspaceId, title: doc.title, fileId: file.id, mimeType: "application/pdf",
      ...(doc.archived ? { archivedAt: new Date() } : {}),
    }).returning();
    if (doc.unindexed || !doc.text) return d;
    const [ex] = await db.insert(documentExtractions).values({
      workspaceId: ws.workspaceId, documentId: d.id, contentHash: crypto.randomUUID(),
      status: "succeeded", text: doc.text, spans: [{ page: 1, start: 0, end: doc.text.length }], extractor: "eval-fixture@1",
    }).returning();
    const chunks = chunkText(doc.text, [{ page: 1, start: 0, end: doc.text.length }]);
    for (let i = 0; i < chunks.length; i += 100) {
      await db.insert(embeddings).values(
        chunks.slice(i, i + 100).map((c) => ({
          workspaceId: ws.workspaceId, ownerType: EMBEDDING_OWNER_TYPE, ownerId: ex.id, sourceVersionId: ex.id,
          chunkIndex: c.index, content: c.text, spanStart: c.start, spanEnd: c.end, page: c.page,
          embedding: hashVector(c.text), model: MODEL,
        })),
      );
    }
    indexedChunks += chunks.length;
    const { eq } = await import("drizzle-orm");
    await db.update(documentExtractions).set({
      embeddedAt: new Date(), embedModel: MODEL, embedCoverage: isCapped(chunks, doc.text) ? "partial" : "complete",
    }).where(eq(documentExtractions.id, ex.id));
    return d;
  };

  const docIdByKey = new Map<string, string>();
  for (const doc of CORPUS) docIdByKey.set(doc.key, (await seedDoc(a, doc)).id);
  // Foreign decoy: identical wording, different workspace - must never leak.
  await seedDoc(b, { key: "foreign-lease", title: "Foreign Lease Decoy", text: CORPUS[0]!.text });

  const fragmentFound = (results: Row[], docKey: string, fragment: string) =>
    results.some((r) => r.documentId === docIdByKey.get(docKey) && String(r.text).includes(fragment));

  const policies: Record<string, (hits: import("../../src/domains/knowledge/agent-search").ScoredHit[]) => unknown> = {
    "old-floor-0.5": (hits) => hits.filter((h) => h.fusedScore >= AGENT_SEARCH_MIN_SCORE),
    "single-leg-rank0": (hits) => hits.filter((h) => h.legs.length > 1 || (h.bestRank.fts ?? h.bestRank.vector ?? 99) <= 0),
    "experimental-rank2": (hits) => hits.filter(isEvidence),
    "no-admission": (hits) => hits,
  };

  const report: Row = {
    runId, at: new Date().toISOString(), model: MODEL, corpusDocs: CORPUS.length, indexedChunks,
    questions: QUESTIONS.length,
    answerLevelMetrics: {
      answerCorrectness: null, claimSupport: null, answerAbstention: null,
      note: "unmeasured: requires an answering model (paid calls not authorized)",
    },
    policies: {} as Row,
  };

  for (const [name, admit] of Object.entries(policies)) {
    const per: Array<Row & { ms: number }> = [];
    for (const q of QUESTIONS) {
      const t0 = performance.now();
      const [vectorHits, ftsHits] = await Promise.all([
        searchChunks(auth, { query: q.question, limit: 8, provider }),
        searchChunksFts(auth, { query: q.question, limit: 8 }),
      ]);
      const merged = rrfMerge(ftsHits, vectorHits, 8, { legsRun: 2 });
      const admitted = admit(merged) as typeof merged;
      const results = admitted.map((h) => ({ documentId: h.documentId, text: h.text, chunkIndex: h.chunkIndex }));
      const ms = performance.now() - t0;
      const hitsFound = q.expected.filter((e) => fragmentFound(results, e.docKey, e.fragment)).length;
      const violations = (q.forbidden ?? []).filter((e) => fragmentFound(results, e.docKey, e.fragment)).length;
      const foreignLeak = results.length - results.filter((r) => [...docIdByKey.values()].includes(r.documentId)).length;
      const precise = results.filter((r) => q.expected.some((e) => e.docKey && fragmentFound([r], e.docKey, e.fragment))).length;
      per.push({
        id: q.id, split: q.split, category: q.category, ms,
        expected: q.expected.length, found: hitsFound,
        recall: q.expected.length ? hitsFound / q.expected.length : null,
        abstainedCorrectly: q.unanswerable ? results.length === 0 : null,
        violations: violations + foreignLeak,
        precision: results.length ? precise / results.length : (q.unanswerable ? 1 : 0),
        evidenceChars: results.reduce((s, r) => s + String(r.text).length, 0),
      });
    }
    const nums = (f: (r: (typeof per)[number]) => number | null) => per.map(f).filter((x): x is number => x !== null);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const lat = nums((r) => r.ms).sort((x, y) => x - y);
    (report.policies as Row)[name] = {
      recall: avg(nums((r) => r.recall)),
      precision: avg(nums((r) => r.precision)),
      abstentionAccuracy: avg(nums((r) => (r.abstainedCorrectly === null ? null : r.abstainedCorrectly ? 1 : 0))),
      scopeViolations: nums((r) => r.violations).reduce((s, x) => s + x, 0),
      p50ms: lat[Math.floor(lat.length / 2)] ?? 0,
      p95ms: lat[Math.floor(lat.length * 0.95)] ?? 0,
      evidenceCharsPerQuery: avg(nums((r) => r.evidenceChars)),
      byCategory: Object.fromEntries(
        [...new Set(QUESTIONS.map((q) => q.category))].map((c) => {
          const rows = per.filter((r) => r.category === c);
          const rn = rows.map((r) => r.recall).filter((x): x is number => x !== null);
          return [c, { n: rows.length, recall: rn.length ? avg(rn) : null }];
        }),
      ),
    };
    (report as Row)[`detail_${name}`] = per;
  }

  // Sanity: the live tool path agrees with the harness's experimental policy.
  const live = await searchDocumentsForAgent(auth, { query: "monthly rent security deposit", provider });
  (report as Row).liveToolSmoke = live.ok ? { mode: live.mode, results: live.results.length, degraded: live.degraded ?? null } : live;

  const fs = await import("node:fs");
  fs.mkdirSync("evals/retrieval/results", { recursive: true });
  const out = `evals/retrieval/results/${runId}.json`;
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`wrote ${out}`);
  for (const [name, m] of Object.entries(report.policies as Row)) {
    const p = m as Row;
    console.log(`${name.padEnd(20)} recall=${(p.recall as number).toFixed(3)} precision=${(p.precision as number).toFixed(3)} abstain=${(p.abstentionAccuracy as number).toFixed(3)} violations=${p.scopeViolations} p50=${Math.round(p.p50ms as number)}ms p95=${Math.round(p.p95ms as number)}ms`);
  }
  console.log("live tool smoke:", JSON.stringify((report as Row).liveToolSmoke));
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
