import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  crawlSiteForAgent,
  fetchPageForAgent,
  WEB_FETCH_CAPABILITY,
} from "../../../../src/domains/knowledge/web-fetch";

/*
 * A read capability over a public URL, backed by the local Firecrawl instance.
 * `url` fetches one page as markdown; `crawl` follows a site to a bounded
 * depth. Writes nothing but the tool_calls row the event bridge records.
 * The run's frozen policy must have granted web.fetch.
 */
export default defineTool({
  description:
    "Read a public web page as markdown, or crawl a site to a bounded depth. Use after web_search when a snippet is not enough or the owner names a URL. It will not authenticate, fetch paywalled or private pages, or read workspace content; on deployments without a fetch provider it answers 'not configured' — report that, do not retry. Read-only; the run's frozen policy must allow web.fetch.",
  inputSchema: z.object({
    url: z.string().url().describe("Public http(s) URL to read"),
    crawl: z.boolean().optional().describe("Crawl the site instead of reading one page"),
    limit: z.number().int().min(1).max(50).optional().describe("Crawl: max pages (default 10)"),
    maxDepth: z.number().int().min(1).max(3).optional().describe("Crawl: link depth (default 1)"),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };
    const userId = current?.principalId;
    if (typeof userId !== "string") return { ok: false as const, error: "no principal in session" };

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, WEB_FETCH_CAPABILITY)) {
      return { ok: false as const, error: "web.fetch is not in this run's policy snapshot" };
    }

    if (input.crawl) {
      return crawlSiteForAgent({ workspaceId, userId }, { url: input.url, limit: input.limit, maxDepth: input.maxDepth });
    }
    return fetchPageForAgent({ workspaceId }, { url: input.url });
  },
});
