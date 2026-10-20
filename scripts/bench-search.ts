/*
 * Relevance and latency of the retrieval layer on a small labeled set.
 * Seeds a throwaway workspace (never touches real data), embeds with the
 * configured provider, then scores keyword-only, meaning-only and hybrid.
 *
 *   OPENROUTER_API_KEY=... DATABASE_URL=... pnpm bench:search
 */
import { db } from "@/lib/db";
import { embedArtifact } from "@/domains/knowledge/embedding";
import { commitNoteSnapshot, createNote } from "@/domains/knowledge/notes";
import { searchKnowledge, type SearchMode } from "@/domains/knowledge/retrieval";
import { seedWorkspace } from "../tests/helpers/test-workspace";

const CORPUS: [string, string][] = [
  ["Compound interest", "Money earns returns, and those returns earn returns, so wealth grows exponentially over decades."],
  ["Index funds", "Buying the whole market cheaply beats picking stocks; fees are the main thing you control."],
  ["Emergency fund", "Keep six months of expenses in cash so a job loss never forces you to sell investments."],
  ["Spaced repetition", "Reviewing a fact just before you would forget it moves it into long-term memory with fewer reviews."],
  ["Active recall", "Testing yourself retrieves memory and strengthens it far more than rereading the page."],
  ["Feynman technique", "If you cannot explain a concept simply to a beginner, you do not understand it yet."],
  ["Deep work", "Long uninterrupted blocks of focus produce the output that shallow task switching never will."],
  ["Pomodoro", "Work for twenty five minutes, rest for five; the timer makes starting easy."],
  ["Eisenhower matrix", "Sort tasks by urgent and important; most value hides in important but not urgent work."],
  ["Stoicism", "Separate what is in your control from what is not, and spend your energy only on the first."],
  ["Antifragility", "Some systems gain from shocks and volatility; build in optionality instead of predicting."],
  ["First principles", "Break a problem down to facts you know to be true, then rebuild the solution from there."],
  ["Second-order thinking", "Ask and then what; the consequences of consequences decide whether a decision was good."],
  ["Inversion", "Instead of asking how to succeed, ask how you would fail, and avoid that."],
  ["Occam's razor", "Among explanations that fit the evidence, prefer the one with the fewest assumptions."],
  ["Confirmation bias", "People seek and remember evidence that agrees with what they already believe."],
  ["Sunk cost fallacy", "Past money or time already spent should not decide whether to continue; only future cost and benefit count."],
  ["Network effects", "A product becomes more valuable to each user as more people use it, which creates winner take most markets."],
  ["Moats", "Durable advantage such as brand, switching costs or scale protects a business from competitors."],
  ["Unit economics", "Does one customer pay back what it cost to acquire them; if not, growth only burns cash."],
  ["Product market fit", "Customers pull the product out of your hands; retention is the clearest sign."],
  ["Postgres full-text search", "tsvector and GIN indexes rank documents by keyword relevance inside the database."],
  ["pgvector", "Store embeddings in Postgres and find nearest neighbours by cosine distance with an HNSW index."],
  ["Reciprocal rank fusion", "Merge ranked lists from different retrievers by summing one over k plus rank, no score calibration needed."],
  ["Idempotency keys", "A client-supplied key lets a retried request return the first result instead of repeating the effect."],
  ["Eventual consistency", "Replicas converge if writes stop; availability is kept by accepting temporary disagreement."],
  ["CAP theorem", "During a network partition a system must choose between consistency and availability."],
  ["Sourdough", "A starter of flour and water ferments for days; hydration and temperature change the crumb."],
  ["Marathon training", "Build a base of easy miles, add a long run weekly, and taper in the last two weeks."],
  ["Sleep hygiene", "Consistent bedtime, dark cool room and no screens before bed improve sleep quality."],
];

/** query, the title that should rank first, and what the query tests. */
const LABELED: [string, string, "keyword" | "typo" | "paraphrase"][] = [
  ["tsvector", "Postgres full-text search", "keyword"],
  ["hnsw", "pgvector", "keyword"],
  ["cosine distance", "pgvector", "keyword"],
  ["switching costs", "Moats", "keyword"],
  ["tapering", "Marathon training", "typo"],
  ["stoisism", "Stoicism", "typo"],
  ["antifragilty", "Antifragility", "typo"],
  ["sourdogh starter", "Sourdough", "typo"],
  ["recipricol rank fusion", "Reciprocal rank fusion", "typo"],
  ["how do I remember things longer", "Spaced repetition", "paraphrase"],
  ["stop wasting energy on things I cannot change", "Stoicism", "paraphrase"],
  ["why did the consensus of replicas diverge", "Eventual consistency", "paraphrase"],
  ["should I keep investing in a failing project because of what I already put in", "Sunk cost fallacy", "paraphrase"],
  ["a safety net of cash for losing my job", "Emergency fund", "paraphrase"],
  ["products that get better as more people join", "Network effects", "paraphrase"],
  ["cheap way to own every stock", "Index funds", "paraphrase"],
  ["find which two plans a database must pick between when the network splits", "CAP theorem", "paraphrase"],
  ["combine results from several search engines into one ranking", "Reciprocal rank fusion", "paraphrase"],
  ["focus for hours without checking messages", "Deep work", "paraphrase"],
  ["explain it so a child could follow", "Feynman technique", "paraphrase"],
  ["bread dough that rises from wild yeast", "Sourdough", "paraphrase"],
  ["think about what happens after what happens", "Second-order thinking", "paraphrase"],
  ["does each customer make us money", "Unit economics", "paraphrase"],
  ["am I only noticing evidence that supports me", "Confirmation bias", "paraphrase"],
];

const modes: SearchMode[] = ["keyword", "meaning", "hybrid"];

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const auth = { ...(await seedWorkspace(db as never, `bench-${crypto.randomUUID()}`)), role: "owner" as const };
  for (const [title, text] of CORPUS) {
    const note = await createNote(auth, { title });
    await commitNoteSnapshot(auth, { artifactId: note.id, expectedVersion: 1, content: { format: "markdown", text }, plainText: text });
    const out = await embedArtifact(auth, { artifactId: note.id });
    if (out.status !== "succeeded") throw new Error(`embed failed for ${title}: ${JSON.stringify(out)}`);
  }
  const groups = ["keyword", "typo", "paraphrase", "all"] as const;
  const report: Record<string, Record<string, { mrr: number; r3: number; n: number }>> = {};
  const latency: Record<string, number[]> = {};
  for (const mode of modes) {
    report[mode] = {};
    latency[mode] = [];
    const acc: Record<string, { rr: number; hit3: number; n: number }> = Object.fromEntries(groups.map((g) => [g, { rr: 0, hit3: 0, n: 0 }]));
    for (const [query, expected, kind] of LABELED) {
      const t0 = performance.now();
      const res = await searchKnowledge(auth, { query, mode, limit: 10 });
      latency[mode].push(performance.now() - t0);
      const rank = res.hits.findIndex((h) => h.title === expected) + 1;
      for (const g of [kind, "all"] as const) {
        acc[g].n += 1;
        acc[g].rr += rank ? 1 / rank : 0;
        acc[g].hit3 += rank && rank <= 3 ? 1 : 0;
      }
    }
    for (const g of groups) report[mode][g] = { mrr: acc[g].rr / acc[g].n, r3: acc[g].hit3 / acc[g].n, n: acc[g].n };
  }
  console.log(`corpus ${CORPUS.length} notes, ${LABELED.length} labeled queries\n`);
  console.log("MRR / recall@3 by query type");
  for (const mode of modes) {
    console.log(mode.padEnd(8), groups.map((g) => `${g} ${report[mode][g].mrr.toFixed(2)}/${report[mode][g].r3.toFixed(2)}`).join("  "));
  }
  console.log("\nlatency ms (query embedding included for meaning and hybrid)");
  for (const mode of modes) {
    const s = [...latency[mode]].sort((a, b) => a - b);
    console.log(mode.padEnd(8), `p50 ${pct(s, 50).toFixed(0)}  p95 ${pct(s, 95).toFixed(0)}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
