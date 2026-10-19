import type { AuthContext } from "@/domains/identity/resolve";
import { crawlSite, FirecrawlError, scrapeToMarkdown, type FirecrawlCrawlResult, type FirecrawlScrapeResult } from "@/integrations/firecrawl/client";

/*
 * What the agents' `web.fetch` tool calls. Like web-search.ts this is a read
 * that stores nothing: the event bridge writes the tool result into the run's
 * tool_calls row, which is the same audit treatment every tool gets.
 *
 * The URL a model supplies is not trusted. Safe-fetch in the app's capture path
 * guards against loopback and private ranges; this path goes through Firecrawl,
 * which runs in a container, so the check that matters is that we never send a
 * private address to it and never let it reach one. `assertPublicUrl` is the
 * same address-family rule the app uses, applied before the request leaves.
 */

export const WEB_FETCH_CAPABILITY = "web.fetch";
export const WEB_FETCH_MAX_BYTES = 200_000;

export type AgentWebFetchResult =
  | { ok: true; url: string; title: string | null; markdown: string; truncated: boolean }
  | { ok: false; error: string };

export type AgentWebCrawlResult =
  | { ok: true; jobId: string; status: string; pages: Array<{ url: string; title: string | null; markdown: string }> }
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
  _auth: Pick<AuthContext, "workspaceId">,
  input: { url: string; limit?: number; maxDepth?: number },
): Promise<AgentWebCrawlResult> {
  const url = assertPublicUrl(input.url.trim());
  if (!url) return { ok: false, error: "url must be a public http(s) address" };
  try {
    const result: FirecrawlCrawlResult = await crawlSite(url.toString(), {
      limit: Math.min(Math.max(input.limit ?? 10, 1), 50),
      maxDepth: Math.min(Math.max(input.maxDepth ?? 1, 1), 3),
    });
    return { ok: true, jobId: result.jobId, status: result.status, pages: result.pages };
  } catch (cause) {
    if (cause instanceof FirecrawlError) return { ok: false, error: "crawl failed, try again" };
    return { ok: false, error: "crawl failed, try again" };
  }
}
