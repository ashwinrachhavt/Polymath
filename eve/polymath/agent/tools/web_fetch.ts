import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
import { normalizeFetchUrl, toolCallsThisTurn } from "../lib/turn-tools";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  crawlSiteForAgent,
  fetchPageForAgent,
  WEB_FETCH_CAPABILITY,
} from "../../../../src/domains/knowledge/web-fetch";
import { runSessionRef } from "../lib/run-session";

/*
 * A read capability over a public URL, backed by the local Firecrawl instance.
 * `url` fetches one page as markdown; `crawl` follows a site to a bounded
 * depth. Writes nothing but the tool_calls row the event bridge records.
 * The run's frozen policy must have granted web.fetch.
 *
 * A turn has a small fetch budget. The first version of this tool let a model
 * spend a step on the same page, then on Invidious mirrors and reader proxies,
 * without ever reading the page it started with. The guards below make a
 * duplicate and a second failure end the search instead of the turn: the
 * model gets an explicit "stop" result it can act on, not another silent
 * provider call.
 */
const MAX_FAILED_FETCHES_PER_TURN = 2;
const MAX_FETCHES_PER_TURN = 8;

export default defineTool({
  description:
    "Read one public web page as markdown (a YouTube URL returns its timestamped transcript). Use after web_search when a snippet is not enough, or for a URL the owner gives. Each URL at most once per turn; if a page fails, do not try mirrors or proxies. `crawl` reads a few pages of one site. Read-only.",
  inputSchema: z.object({
    url: z.string().url().describe("Public http(s) URL to read"),
    crawl: z.boolean().optional().describe("Crawl the site instead of reading one page"),
    limit: z.number().int().min(1).max(30).optional().describe("Crawl: max pages (default 25, two links deep)"),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };
    const userId = current?.principalId;
    if (typeof userId !== "string") return { ok: false as const, error: "no principal in session" };

    const run = await getRunBySessionRef(runSessionRef(ctx.session), workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, WEB_FETCH_CAPABILITY)) {
      return { ok: false as const, error: "web.fetch is not in this run's policy snapshot" };
    }

    if (input.url.startsWith("ai-gateway://")) {
      return {
        ok: false as const,
        error: "that is a provenance marker from a synthesized search answer, not a fetchable page",
      };
    }

    const prior = toolCallsThisTurn(ctx.messages, "web_fetch");
    const mode = input.crawl ? "crawl" : "fetch";
    const wanted = `${mode}:${normalizeFetchUrl(input.url)}`;
    const duplicate = prior.some(
      (call) => `${call.input.crawl ? "crawl" : "fetch"}:${normalizeFetchUrl(call.input.url)}` === wanted,
    );
    if (duplicate) {
      return {
        ok: false as const,
        error:
          "This URL was already fetched this turn. Its result is in the conversation above; use it instead of fetching the page again. Do not try a mirror, reader proxy, or alternate front-end.",
      };
    }
    const failed = prior.filter((call) => call.failed).length;
    if (failed >= MAX_FAILED_FETCHES_PER_TURN) {
      return {
        ok: false as const,
        error: `web_fetch has failed ${failed} times this turn. Stop fetching: do not try mirrors, reader proxies, or alternate front-ends. Answer with what you have, or say the page could not be read.`,
      };
    }
    if (prior.length >= MAX_FETCHES_PER_TURN) {
      return {
        ok: false as const,
        error: `web_fetch has already run ${prior.length} times this turn. Stop fetching and answer with what you have.`,
      };
    }

    if (input.crawl) {
      return crawlSiteForAgent({ workspaceId, userId }, { url: input.url, limit: input.limit });
    }
    return fetchPageForAgent({ workspaceId }, { url: input.url });
  },
});
