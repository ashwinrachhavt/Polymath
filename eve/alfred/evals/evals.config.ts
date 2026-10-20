import { defineEvalConfig } from "eve/evals";

/*
 * Evals run serially. The model-backed cases drive a real Gemini turn, and two
 * concurrent sessions on the free tier intermittently one-shot a rate limit that
 * surfaces as a failed turn — observed once during development, then gone on
 * every serial rerun. A gate that fails for a reason unrelated to the behavior
 * it grades teaches people to ignore it, so the suite trades a few seconds for a
 * verdict that means what it says.
 */
export default defineEvalConfig({
  maxConcurrency: 1,
});
