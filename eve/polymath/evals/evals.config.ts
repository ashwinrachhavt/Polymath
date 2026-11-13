import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineEvalConfig } from "eve/evals";
import { fixtureTable } from "./fixtures";

/*
 * One case at a time: the cases measure latency and token use, and running
 * them concurrently would make them compete for the same provider rate limit,
 * so a slow or throttled case would say nothing about the agent.
 *
 * Setup writes the tool recordings and points the agent at them before eve
 * starts the local agent server (which inherits this environment).
 */
export default defineEvalConfig({
  maxConcurrency: 1,
  setup() {
    const dir = join(import.meta.dirname, "results");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "fixtures.json");
    writeFileSync(path, JSON.stringify(fixtureTable()));
    process.env.POLYMATH_EVAL_FIXTURES = path;
  },
});
