import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  searchWebForAgent,
  WEB_SEARCH_CAPABILITY,
  WEB_SEARCH_MAX_RESULTS,
} from "../../../../src/domains/knowledge/web-search";

/*
 * A read capability over the public web. It returns titles, URLs and snippets
 * and writes nothing. The workspace comes from the session's verified auth,
 * never from the model's arguments; the run's frozen policy must have granted
 * web.search or the call is refused before any provider is touched.
 */
export default defineTool({
  description:
    "Search the public web. Returns ranked results with title, URL and snippet, plus which provider answered. Use for the world rather than the owner's workspace: current events, prices, versions, documentation, anything that changed after the library was captured. Search the owner's documents first when the question is about their own work — a web answer to a library question is a weaker claim. It will not open pages (that is web_fetch), and snippets go stale and truncate: fetch the page before quoting anything from it. One search per intent; if a query came back useless, rephrase once rather than repeating it, because every search spends a metered allowance. Read-only; the run's frozen policy must allow web.search.",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
  }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, WEB_SEARCH_CAPABILITY)) {
      return { ok: false as const, error: "web.search is not in this run's policy snapshot" };
    }

    return searchWebForAgent({ workspaceId }, { query: input.query, limit: input.limit });
  },
});
