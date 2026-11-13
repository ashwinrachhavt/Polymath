/*
 * Routing accuracy on the agent eval set: the production cascade (rules, Jev,
 * small model) against each turn's labelled lane and library need.
 *
 *   pnpm exec tsx scripts/agent-route-eval.mts
 *
 * Needs TYPESAFE_API_KEY for Jev and the small model's key; Jev is called
 * directly (unmetered), as the eval agent does.
 */
import { EVAL_TURNS } from "../eve/polymath/evals/turns";
import { routeTurn, type TurnRoute } from "@/domains/agents/turn-routing";
import { chatModel, modelById, smallModelId } from "@/domains/agents/models";
import { httpJevClient } from "@/integrations/jev/client";
import type { ClassifyJudger } from "@/integrations/jev/provider";

const judge: ClassifyJudger | undefined = process.env.TYPESAFE_API_KEY
  ? {
      async judge(input) {
        const response = await httpJevClient(process.env).systemOne({ state: input.state, questions: input.questions });
        return { model: response.model, answers: response.answers, usage: response.usage };
      },
    }
  : undefined;
const small = modelById(smallModelId());
const smallModel = small ? chatModel(small) : undefined;

let laneHits = 0;
let libraryHits = 0;
let libraryScored = 0;
const bySource = new Map<string, number>();
const latencies: number[] = [];

console.log("| turn | expected | routed | source | confidence | library expected → routed | ms |");
console.log("| --- | --- | --- | --- | --: | --- | --: |");
for (const turn of EVAL_TURNS) {
  const started = Date.now();
  const route: TurnRoute = await routeTurn({ text: turn.text, judge, smallModel });
  const ms = Date.now() - started;
  latencies.push(ms);
  bySource.set(route.source, (bySource.get(route.source) ?? 0) + 1);
  const laneOk = route.lane === turn.lane;
  if (laneOk) laneHits += 1;
  if (turn.library !== "optional") {
    libraryScored += 1;
    if ((turn.library === "required") === route.needsLibrary) libraryHits += 1;
  }
  console.log(
    `| ${turn.id} | ${turn.lane} | ${laneOk ? route.lane : `**${route.lane}**`} | ${route.source} | ${route.confidence.toFixed(2)} | ${turn.library} → ${route.needsLibrary} | ${ms} |`,
  );
}

const sorted = [...latencies].sort((a, b) => a - b);
console.log(`\nLane accuracy: ${laneHits}/${EVAL_TURNS.length}`);
console.log(`Library-need accuracy: ${libraryHits}/${libraryScored} (optional turns not scored)`);
console.log(`Decided by: ${[...bySource].map(([source, n]) => `${source} ${n}`).join(", ")}`);
console.log(`Routing latency: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`);
process.exit(0);
