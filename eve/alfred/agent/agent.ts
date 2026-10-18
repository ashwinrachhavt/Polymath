import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

/*
 * Alfred: one first-party agent (agents/product.md — not a persona zoo).
 *
 * Direct Anthropic access instead of a Gateway model string: the run's frozen
 * policy snapshot is what the engine prices and bounds, and profiles stay
 * resolvable from the schema. The helper honours ANTHROPIC_BASE_URL, so local
 * development rides the LiteLLM proxy already in the environment, and the
 * deployed default (api.anthropic.com) needs only ANTHROPIC_API_KEY.
 *
 * The dev proxy serves a model id the Gateway catalog does not list, so the
 * context window is declared here; without it eve refuses to compile the
 * compaction trigger. 1M matches the proxy's advertised limit.
 */
export default defineAgent({
  model: anthropic("claude-hive-glm-5.3-flash"),
  compaction: {
    model: anthropic("claude-hive-glm-5.3-flash"),
    modelContextWindowTokens: 1_000_000,
  },
});
