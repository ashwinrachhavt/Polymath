import { defineEvalConfig } from "eve/evals";

/*
 * Evals run one at a time.
 *
 * The model-backed cases each drive several Gemini calls (a turn, a tool call,
 * then a follow-up turn), and the free tier meters requests per minute. Running
 * cases concurrently bursts that window and the extra calls come back 429,
 * which surfaces as `MODEL_CALL_FAILED: Too Many Requests` — a failed eval that
 * says nothing about the agent. Serial execution keeps the request rate under
 * the limit, so a red row means the behavior broke.
 *
 * This does not make the suite immune to quota: running the full suite
 * repeatedly in quick succession still exhausts the per-minute window. When a
 * failure reads "Too Many Requests" with empty assertion detail, wait a minute
 * and rerun before treating it as a regression.
 */
export default defineEvalConfig({
  maxConcurrency: 1,
});
