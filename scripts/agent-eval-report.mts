/*
 * Summarise agent eval runs (eve/polymath/evals/agent-turns.eval.ts) as a
 * markdown before/after table.
 *
 *   pnpm exec tsx scripts/agent-eval-report.mts baseline.jsonl after.jsonl
 *
 * Cost uses list prices per million tokens. GLM-5.3-Flash: Z.ai first-party
 * API ($0.15 input, $0.03 cached input, $0.50 output; docs.z.ai, 2026-10-17).
 * A model missing here is priced at the GLM rate and marked with an asterisk.
 */
import { readFileSync } from "node:fs";

type Row = {
  id: string;
  lane: string;
  library: string;
  status: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  steps: number;
  tools: string[];
  models: string[];
  ttftMs: number | null;
  retrievalOk: boolean;
  judge: number | null;
};

type Price = { input: number; cached: number; output: number };
const PRICES: Record<string, Price> = {
  "zai-org/glm-5.3-flash": { input: 0.15, cached: 0.03, output: 0.5 },
  "gemini-3.5-flash-lite": { input: 0.1, cached: 0.025, output: 0.4 },
};
const FALLBACK_PRICE = PRICES["zai-org/glm-5.3-flash"] as Price;

function load(path: string): Row[] {
  // The last row for an id wins, so a re-run case replaces its earlier attempt.
  const rows = new Map<string, Row>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim()) {
      const row = JSON.parse(line) as Row;
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

function cost(row: Row): { usd: number; estimated: boolean } {
  const known = row.models.map((model) => PRICES[model]).filter((price): price is Price => Boolean(price));
  // A turn that used several models is priced at the most expensive one: the
  // usage totals are not split per model.
  const price = known.sort((a, b) => b.input - a.input)[0] ?? FALLBACK_PRICE;
  const uncached = row.inputTokens - row.cacheReadTokens;
  const usd = (uncached * price.input + row.cacheReadTokens * price.cached + row.outputTokens * price.output) / 1e6;
  return { usd, estimated: known.length < row.models.length || known.length === 0 };
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : NaN;
};
const fmt = (value: number, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "–");

function summary(rows: Row[], filter: (row: Row) => boolean) {
  const picked = rows.filter(filter);
  const ttfts = picked.map((row) => row.ttftMs).filter((v): v is number => v !== null);
  const judged = picked.map((row) => row.judge).filter((v): v is number => v !== null);
  return {
    n: picked.length,
    input: mean(picked.map((row) => row.inputTokens)),
    steps: mean(picked.map((row) => row.steps)),
    ttft: median(ttfts),
    usd: mean(picked.map((row) => cost(row).usd)),
    judge: mean(judged),
    retrieval: picked.filter((row) => row.retrievalOk).length,
    failed: picked.filter((row) => row.status === "failed").length,
  };
}

const GROUPS: [string, (row: Row) => boolean][] = [
  ["all turns", () => true],
  ["quick (greetings, acks)", (row) => row.lane === "quick"],
  ["general answers", (row) => row.lane === "answer" && row.library === "none"],
  ["library questions", (row) => row.library === "required"],
  ["research", (row) => row.lane === "research"],
  ["tutor", (row) => row.lane === "tutor"],
  ["draft", (row) => row.lane === "draft"],
  ["operate", (row) => row.lane === "operate"],
  ["explain a change", (row) => row.lane === "explain_change"],
];

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath) {
  console.error("usage: agent-eval-report.mts <baseline.jsonl> [after.jsonl]");
  process.exit(1);
}
const runs: [string, Row[]][] = [["before", load(beforePath)]];
if (afterPath) runs.push(["after", load(afterPath)]);

console.log("| group | run | n | avg input tokens | avg steps | median TTFT ms | avg cost $ | avg judge | retrieval ok | failed |");
console.log("| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |");
for (const [label, filter] of GROUPS) {
  for (const [run, rows] of runs) {
    const s = summary(rows, filter);
    if (!s.n) continue;
    console.log(
      `| ${label} | ${run} | ${s.n} | ${fmt(s.input)} | ${fmt(s.steps, 1)} | ${fmt(s.ttft)} | ${fmt(s.usd, 5)} | ${fmt(s.judge, 2)} | ${s.retrieval}/${s.n} | ${s.failed} |`,
    );
  }
}

console.log("\n| turn | lane | input before | input after | steps before→after | tools after | judge before→after |");
console.log("| --- | --- | --: | --: | --- | --- | --- |");
const before = new Map(runs[0]![1].map((row) => [row.id, row]));
const after = new Map((runs[1]?.[1] ?? []).map((row) => [row.id, row]));
for (const [id, b] of before) {
  const a = after.get(id);
  console.log(
    `| ${id} | ${b.lane} | ${b.inputTokens} | ${a?.inputTokens ?? "–"} | ${b.steps}→${a?.steps ?? "–"} | ${(a?.tools ?? []).join(", ") || "none"} | ${fmt(b.judge ?? NaN, 2)}→${fmt(a?.judge ?? NaN, 2)} |`,
  );
}
