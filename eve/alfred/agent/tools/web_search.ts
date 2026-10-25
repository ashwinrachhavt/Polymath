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
    "Search the public web. Returns ranked results with title, URL and snippet, plus which provider answered. Use for current events, prices, documentation, and anything the workspace does not cover; it is the right first call when the question is about the world, not the owner's workspace. It will not open or read pages (that is web_fetch). Snippets can be stale or truncated: fetch the page when a claim will be quoted. Read-only; the run's frozen policy must allow web.search.",
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
