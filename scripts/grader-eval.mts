import { generationProvider } from "@/integrations/generation/provider";
import { explainItGenerator } from "@/integrations/learning/explain-it";
import { GRADER_EVAL_CASES, GRADER_EVAL_SOURCE, validateCases, type Grade } from "@/domains/learning/grader-eval-cases";

/*
 * The grader eval: run every fixture answer through the same evaluator the
 * mock interview uses, and report two numbers the owner sets the bar against.
 *
 *   false-pass rate  answers graded "correct" that an owner would grade
 *                    partial or incorrect. This is the number that matters:
 *                    a false pass tells someone they are ready when they are
 *                    not, which is worse than a false fail.
 *   agreement        every answer whose grade equals the expected one.
 *
 * The bar is not set here. This prints the numbers; the owner decides whether
 * they are good enough before anyone is sold a readiness report.
 *
 *   GENERATION_PROVIDER=groq GROQ_API_KEY=... npx tsx scripts/grader-eval.ts
 *   GENERATION_PROVIDER=groq npx tsx scripts/grader-eval.ts --only c01,w11
 *
 * Spend: one model call per case, kept deliberately small (50 short answers).
 */

const only = (() => {
  const index = process.argv.indexOf("--only");
  if (index < 0) return null;
  const ids = new Set((process.argv[index + 1] ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  return ids.size > 0 ? ids : null;
})();

validateCases(GRADER_EVAL_CASES);
const cases = only ? GRADER_EVAL_CASES.filter((item) => only.has(item.id)) : GRADER_EVAL_CASES;
const provider = process.env.GENERATION_PROVIDER ?? "(default chain)";
const delayMs = Number(process.env.EVAL_DELAY_MS ?? "400");

console.log(`Grader eval: ${cases.length} answers, provider ${provider}\n`);

// An offline eval has no workspace, key store or ledger: it grades through the house chain directly.
const house = generationProvider(process.env);
const engine = explainItGenerator(house, (input) => house.generate({ ...input, json: true }));
const results: Array<{
  id: string;
  expected: Grade;
  got: Grade;
  ok: boolean;
  falsePass: boolean;
  falseFail: boolean;
  feedback: string;
  leastCertain: boolean;
  failed: boolean;
}> = [];

let failedCalls = 0;

for (const [index, item] of cases.entries()) {
  let got: Grade = "uncertain";
  let feedback = "";
  let failed = false;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const evaluation = await engine.evaluate({
        sources: [GRADER_EVAL_SOURCE],
        question: item.question,
        answer: item.answer,
        history: [],
      });
      // The grader contract: a verdict with no grounded quote is uncertain.
      const grounded = evaluation.evidence.length > 0;
      got = grounded ? evaluation.grade : "uncertain";
      feedback = evaluation.feedback;
      failed = false;
      break;
    } catch (error) {
      // A provider rate limit or a transient failure is not a grading result:
      // retry with backoff, and count any final failure apart from the scores
      // so a throttled call never silently reads as an agreement or a pass.
      failed = true;
      if (attempt === 4) {
        console.error(`  ${item.id}: eval call failed after ${attempt}:`, error instanceof Error ? error.message : error);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  if (failed) failedCalls += 1;
  const falsePass = !failed && got === "correct" && (item.expected === "partial" || item.expected === "incorrect");
  const falseFail = !failed && (got === "partial" || got === "incorrect") && item.expected === "correct";
  results.push({
    id: item.id,
    expected: item.expected,
    got,
    ok: !failed && got === item.expected,
    falsePass,
    falseFail,
    feedback,
    leastCertain: Boolean(item.leastCertain),
    failed,
  });
  const mark = failed ? "CALL-FAILED" : falsePass ? "FALSE-PASS" : falseFail ? "false-fail" : got === item.expected ? "ok" : "diff";
  console.log(`[${String(index + 1).padStart(2)}/${cases.length}] ${item.id} expected=${item.expected} got=${got} ${mark}`);
  if (process.env.EVAL_VERBOSE === "1") console.log(`       ${feedback.slice(0, 200)}`);
  if (index < cases.length - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const scored = results.filter((row) => !row.failed);
const judged = results.filter(
  (row) => !row.failed && (row.expected === "correct" || row.expected === "partial" || row.expected === "incorrect"),
);
const falsePasses = results.filter((row) => row.falsePass);
const falseFails = results.filter((row) => row.falseFail);
const agreed = results.filter((row) => row.ok);

console.log("\n=== Summary ===");
console.log(`cases run:        ${results.length}`);
console.log(`graded (scored):  ${scored.length}  (${failedCalls} calls failed and are excluded)`);
console.log(`overall agreement: ${agreed.length}/${scored.length} (${pct(agreed.length, scored.length)})`);
console.log(
  `false-pass rate:  ${falsePasses.length}/${judged.length} judged answers were graded correct but expected partial/incorrect (${pct(falsePasses.length, judged.length)})`,
);
console.log(`false-fail count: ${falseFails.length} (a right answer graded partial/incorrect)`);
if (falsePasses.length > 0) console.log(`false passes:     ${falsePasses.map((row) => row.id).join(", ")}`);
if (falseFails.length > 0) console.log(`false fails:      ${falseFails.map((row) => row.id).join(", ")}`);

const uncertain = results.filter((row) => !row.failed && row.expected === "uncertain");
const uncertainHandled = uncertain.filter((row) => row.got === "uncertain" || row.got === "partial" || row.got === "incorrect");
console.log(
  `uncertain handling: ${uncertainHandled.length}/${uncertain.length} expected-uncertain answers were graded uncertain or a non-pass (never "correct")`,
);
const uncertainFalsePass = uncertain.filter((row) => row.got === "correct");
if (uncertainFalsePass.length > 0) console.log(`  expected-uncertain graded correct: ${uncertainFalsePass.map((r) => r.id).join(", ")}`);

console.log("\nThe ten the drafting agent is least sure about (review these first):");
for (const row of results.filter((item) => item.leastCertain)) {
  console.log(`  ${row.id}: expected ${row.expected}, got ${row.failed ? "call failed" : row.got}`);
}

console.log("\nThe owner sets the acceptable false-pass bar. This eval does not.");
// Deliberately no exit code: the numbers are informational, the bar is the owner's.

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}
