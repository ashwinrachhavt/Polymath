/*
 * Calibrate the documents_search admission floor (AGENT_SEARCH_MIN_SCORE) and
 * measure whether a Jev relevance check pays for itself.
 *
 *   DATABASE_URL=<library db> pnpm exec tsx scripts/calibrate-agent-search.mts <workspaceId> [userId]
 *
 * Read-only: it runs the two production search legs, fuses them with the
 * production RRF, and scores each candidate floor against labelled queries
 * written for the owner's laptop library (17 documents, 2026-11-13). A query
 * labelled with no document is one the library cannot answer: the right
 * result there is nothing.
 */
import { AGENT_SEARCH_MIN_SCORE, rrfMerge } from "@/domains/knowledge/agent-search";
import { searchChunks, searchChunksFts } from "@/domains/knowledge/search";
import { httpJevClient } from "@/integrations/jev/client";

type Labelled = { query: string; relevant: string[] };

const QUERIES: Labelled[] = [
  { query: "How does adding Jev to RAG change retrieval?", relevant: ["RAG vs. Jev + RAG"] },
  { query: "what is CFG scale and how high should I set it", relevant: ["CFG Scale"] },
  { query: "how do I get the same image twice from the same prompt", relevant: ["Seed: Controlling randomness"] },
  { query: "image width and height limits", relevant: ["Dimensions: Output size"] },
  { query: "connect Claude to an MCP server running on my machine", relevant: ["Connect to local MCP servers"] },
  { query: "debugging an MCP server with a visual tool", relevant: ["MCP Inspector"] },
  { query: "how to write an MCP server", relevant: ["Build an MCP server"] },
  { query: "what are agent skills and how do I build one", relevant: ["Build with Agent Skills"] },
  { query: "how to choose between AWS architectures", relevant: ["The AWS Decision Framework"] },
  { query: "state of the software engineering job market", relevant: ["The state of the software engineering industry"] },
  { query: "understanding is the bottleneck when AI writes the code", relevant: ["Understanding is the new bottleneck"] },
  { query: "how ChatGPT renders interactive UI in answers", relevant: ["We reverse engineered ChatGPT Intelligent UI"] },
  { query: "How much is my rent?", relevant: [] },
  { query: "what does my car insurance cover", relevant: [] },
  { query: "when is the tax filing deadline", relevant: [] },
  { query: "my notes on the French Revolution", relevant: [] },
  { query: "kubernetes pod autoscaling settings", relevant: [] },
  { query: "recipe for sourdough bread", relevant: [] },
];

const FLOORS = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8];

const [workspaceId, userId = "calibration"] = process.argv.slice(2);
if (!workspaceId) {
  console.error("usage: calibrate-agent-search.mts <workspaceId> [userId]");
  process.exit(1);
}
const auth = { workspaceId, userId, role: "viewer" as const };

type Candidate = { title: string; text: string; score: number };

async function candidates(query: string): Promise<Candidate[]> {
  const [vector, fts] = await Promise.all([
    searchChunks(auth, { query, limit: 5 }).catch(() => null),
    searchChunksFts(auth, { query, limit: 5 }).catch(() => null),
  ]);
  const legs = (vector ? 1 : 0) + (fts ? 1 : 0);
  return rrfMerge(fts ?? [], vector ?? [], 5, { legsRun: Math.max(legs, 1) }).map((hit) => ({
    title: hit.title,
    text: hit.text,
    score: hit.fusedScore,
  }));
}

const isRelevant = (label: Labelled, title: string) => label.relevant.some((needle) => title.includes(needle));

/** Jev's probability that each passage helps answer the query, in one bundled call. */
async function jevKeep(query: string, list: Candidate[]): Promise<boolean[]> {
  if (list.length === 0) return [];
  const questions = Object.fromEntries(
    list.map((c, i) => [
      `p${i}`,
      { type: "noul" as const, instructions: `Does passage ${i} help answer the query? Passage ${i}: ${c.title}: ${c.text.slice(0, 600)}` },
    ]),
  );
  const result = await httpJevClient(process.env).systemOne({ state: `Query: ${query}`, questions });
  return list.map((_, i) => {
    const answer = result.answers[`p${i}`];
    return answer?.type === "noul" ? answer.noul >= 0.5 : true;
  });
}

type Tally = { tp: number; fp: number; fn: number; abstainOk: number; abstainTotal: number; answered: number; answerable: number };
const empty = (): Tally => ({ tp: 0, fp: 0, fn: 0, abstainOk: 0, abstainTotal: 0, answered: 0, answerable: 0 });

function score(tally: Tally, label: Labelled, kept: Candidate[]) {
  const relevantKept = kept.filter((c) => isRelevant(label, c.title)).length;
  tally.tp += relevantKept;
  tally.fp += kept.length - relevantKept;
  if (label.relevant.length === 0) {
    tally.abstainTotal += 1;
    if (kept.length === 0) tally.abstainOk += 1;
  } else {
    tally.answerable += 1;
    if (relevantKept > 0) tally.answered += 1;
    else tally.fn += 1;
  }
}

const byFloor = new Map(FLOORS.map((floor) => [floor, empty()]));
const rerank = empty();
let jevMs = 0;

for (const label of QUERIES) {
  const list = await candidates(label.query);
  console.log(`\n${label.query}`);
  for (const c of list) console.log(`  ${c.score.toFixed(3)} ${isRelevant(label, c.title) ? "✓" : " "} ${c.title.slice(0, 70)}`);
  for (const floor of FLOORS) score(byFloor.get(floor)!, label, list.filter((c) => c.score >= floor));
  if (process.env.TYPESAFE_API_KEY) {
    const started = Date.now();
    const keep = await jevKeep(label.query, list).catch(() => list.map(() => true));
    jevMs += Date.now() - started;
    score(rerank, label, list.filter((_, i) => keep[i]));
  }
}

const row = (name: string, t: Tally) => {
  const precision = t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp);
  console.log(
    `| ${name} | ${precision.toFixed(2)} | ${t.answered}/${t.answerable} | ${t.abstainOk}/${t.abstainTotal} | ${t.fp} |`,
  );
};
console.log(`\nCurrent floor: ${AGENT_SEARCH_MIN_SCORE}\n`);
console.log("| admission | passage precision | answerable queries with a relevant passage | unanswerable queries left empty | irrelevant passages shown |");
console.log("| --- | --: | --: | --: | --: |");
for (const [floor, tally] of byFloor) row(`fused score ≥ ${floor}`, tally);
if (process.env.TYPESAFE_API_KEY) {
  row("Jev relevance check (no floor)", rerank);
  console.log(`\nJev check latency: ${Math.round(jevMs / QUERIES.length)} ms per query on average`);
}
process.exit(0);
