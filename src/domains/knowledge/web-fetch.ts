import type { AuthContext } from "@/domains/identity/resolve";
import { scrapeToMarkdown, FirecrawlError, type FirecrawlScrapeResult } from "@/integrations/firecrawl/client";
import { withTransaction } from "@/lib/db-transaction";
import { canonicalCaptureUrl } from "@/lib/safe-fetch";
import { enqueueOutbox } from "@/domains/audit/outbox";

/*
 * What the agents' `web.fetch` tool calls.
 *
 * Reading one page is a read: nothing is stored beyond the run's tool_calls
 * row, which the event bridge writes.
 *
 * Crawling is different. A crawl outlives a request, so this does not fetch —
 * it enqueues `crawl.requested` in the same shape every other producer uses,
 * and the outbox worker submits, polls and lands the pages as documents. The
 * tool returns "queued" rather than a partial page set, because a truncated
 * crawl reported as success is the failure this replaced.
 *
 * The URL a model supplies is not trusted. `assertPublicUrl` is the same
 * address-family rule the app uses, applied before anything leaves.
 */

export const WEB_FETCH_CAPABILITY = "web.fetch";
export const WEB_FETCH_MAX_BYTES = 200_000;

export type AgentWebFetchResult =
  | { ok: true; url: string; title: string | null; markdown: string; truncated: boolean }
  | { ok: false; error: string };

export type AgentWebCrawlResult =
  | { ok: true; queued: true; url: string; limit: number; maxDepth: number; note: string }
  | { ok: false; error: string };

/** Reject anything that is not a normal http(s) URL to a public host name. */
export function assertPublicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  // A bare IP literal is refused; a host name is resolved by Firecrawl, and the
  // container's own network is not reachable from the internet.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  return url;
}

export async function fetchPageForAgent(
  _auth: Pick<AuthContext, "workspaceId">,
  input: { url: string; maxChars?: number },
): Promise<AgentWebFetchResult> {
  const url = assertPublicUrl(input.url.trim());
  if (!url) return { ok: false, error: "url must be a public http(s) address" };
  const maxChars = Math.min(Math.max(input.maxChars ?? WEB_FETCH_MAX_BYTES, 1_000), WEB_FETCH_MAX_BYTES);
  try {
    const page: FirecrawlScrapeResult = await scrapeToMarkdown(url.toString());
    if (page.error) return { ok: false, error: `fetch failed: ${page.error}` };
    const truncated = page.markdown.length > maxChars;
    return {
      ok: true,
      url: page.url,
      title: page.title,
      markdown: truncated ? page.markdown.slice(0, maxChars) : page.markdown,
      truncated,
    };
  } catch (cause) {
    if (cause instanceof FirecrawlError) return { ok: false, error: "fetch failed, try again" };
    return { ok: false, error: "fetch failed, try again" };
  }
}

export async function crawlSiteForAgent(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: { url: string; limit?: number; maxDepth?: number },
): Promise<AgentWebCrawlResult> {
  const url = assertPublicUrl(input.url.trim());
  if (!url) return { ok: false, error: "url must be a public http(s) address" };
  const target = canonicalCaptureUrl(url);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const maxDepth = Math.min(Math.max(input.maxDepth ?? 1, 1), 3);
  try {
    await withTransaction((tx) =>
      enqueueOutbox(tx, auth, {
        topic: "crawl.requested",
        payload: { url: target, limit, maxDepth },
        // The canonical URL is the key, so asking twice while one is running
        // joins the first job instead of starting a second crawl of the site.
        dispatchKey: `crawl:${target}`,
      }),
    );
  } catch {
    return { ok: false, error: "crawl could not be queued, try again" };
  }
  return {
    ok: true,
    queued: true,
    url: target,
    limit,
    maxDepth,
    note: "Queued. Pages land in the Library as documents as they arrive; search them there once the crawl finishes.",
  };
}
