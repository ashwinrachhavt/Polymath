import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
import { normalizeSearchQuery, toolCallsThisTurn } from "../lib/turn-tools";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  searchWebForAgent,
  WEB_SEARCH_CAPABILITY,
  WEB_SEARCH_MAX_RESULTS,
} from "../../../../src/domains/knowledge/web-search";
import { runSessionRef } from "../lib/run-session";

/*
 * A read capability over the public web. It returns titles, URLs and snippets
 * and writes nothing. The workspace comes from the session's verified auth,
 * never from the model's arguments; the run's frozen policy must have granted
 * web.search or the call is refused before any provider is touched.
 *
 * The turn budget mirrors the instruction "search once per intent": repeating
 * a query is refused without spending an allowance, and two empty results mean
 * the intent is not answerable this way. Without the guard a model can keep
 * rephrasing the same question while the owner watches a spinner.
 */
const MAX_SEARCHES_PER_TURN = 4;
const MAX_EMPTY_SEARCHES_PER_TURN = 2;

export default defineTool({
  description:
    "Search the public web for current or outside information (news, prices, versions, documentation, companies). Returns ranked results with title, URL and snippet; fetch a page with web_fetch before quoting it. One search per intent; rephrase once at most. Read-only.",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
  }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };

    const run = await getRunBySessionRef(runSessionRef(ctx.session), workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, WEB_SEARCH_CAPABILITY)) {
      return { ok: false as const, error: "web.search is not in this run's policy snapshot" };
    }

    const prior = toolCallsThisTurn(ctx.messages, "web_search");
    const wanted = normalizeSearchQuery(input.query);
    if (prior.some((call) => normalizeSearchQuery(call.input.query) === wanted)) {
      return {
        ok: false as const,
        error:
          "That query already ran this turn. Use the results above; if they were empty, rephrase once or answer with what you have.",
      };
    }
    const empty = prior.filter((call) => {
      const output = call.output as { ok?: unknown; results?: unknown } | null;
      return output?.ok === true && Array.isArray(output.results) && output.results.length === 0;
    }).length;
    if (empty >= MAX_EMPTY_SEARCHES_PER_TURN) {
      return {
        ok: false as const,
        error: `Two searches came back empty this turn. Stop searching and answer with what you have, naming the gap.`,
      };
    }
    if (prior.length >= MAX_SEARCHES_PER_TURN) {
      return {
        ok: false as const,
        error: `web_search has already run ${prior.length} times this turn. Stop searching and answer with what you have.`,
      };
    }

    return searchWebForAgent({ workspaceId }, { query: input.query, limit: input.limit });
  },
});
