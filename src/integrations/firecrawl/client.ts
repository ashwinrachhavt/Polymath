/*
 * The Firecrawl research surface the research flows need, behind one
 * interface: scrape one page to markdown, crawl a site to a depth, and extract
 * structured data from a page. The self-hosted instance runs in compose
 * (`firecrawl`, `make search-up`); FIRECRAWL_API_URL points at it and
 * FIRECRAWL_API_KEY is optional because a local instance authenticates nobody.
 * A hosted instance works with both set and nothing else changed.
 *
 * This module does not gate capabilities — the caller does, from the run's
 * frozen policy, exactly as web-search.ts does. It is a transport.
 */

export type FirecrawlScrapeResult = {
  url: string;
  markdown: string;
  title: string | null;
  /** Provider-reported status; 200 is a successful scrape, anything else carries the message. */
  statusCode: number;
  error: string | null;
};

export type FirecrawlCrawlResult = {
  jobId: string;
  status: string;
  pages: Array<{ url: string; markdown: string; title: string | null }>;
  error: string | null;
};

export class FirecrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlError";
  }
}

/** One call never hangs a run. Crawl polling is bounded by the same budget. */
export const FIRECRAWL_TIMEOUT_MS = 20_000;

type FirecrawlConfig = { baseUrl: string; apiKey: string | null };

function config(env: Record<string, string | undefined>): FirecrawlConfig {
  const baseUrl = env.FIRECRAWL_API_URL?.trim();
  if (!baseUrl) {
    throw new FirecrawlError("FIRECRAWL_API_URL is not set (e.g. http://127.0.0.1:3002).");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: env.FIRECRAWL_API_KEY?.trim() || null };
}

function headers(cfg: FirecrawlConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

type ScrapeBody = {
  success?: boolean;
  data?: { markdown?: string; metadata?: { title?: string; statusCode?: number; error?: string } };
  error?: string;
};

export async function scrapeToMarkdown(
  url: string,
  env: Record<string, string | undefined> = process.env,
): Promise<FirecrawlScrapeResult> {
  const cfg = config(env);
  const response = await fetch(`${cfg.baseUrl}/v1/scrape`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });
  if (!response.ok) throw new FirecrawlError(`Firecrawl scrape returned ${response.status}`);
  const body = (await response.json().catch(() => null)) as ScrapeBody | null;
  if (!body?.success || !body.data) {
    return { url, markdown: "", title: null, statusCode: 0, error: body?.error ?? "scrape failed" };
  }
  return {
    url,
    markdown: body.data.markdown ?? "",
    title: body.data.metadata?.title ?? null,
    statusCode: body.data.metadata?.statusCode ?? 200,
    error: body.data.metadata?.error ?? null,
  };
}

type CrawlBody = {
  success?: boolean;
  id?: string;
  status?: string;
  data?: Array<{ markdown?: string; metadata?: { title?: string; sourceURL?: string } }>;
  error?: string;
};

/*
 * Synchronous crawl: submit, then poll the status endpoint until it settles or
 * the timeout budget runs out. A crawl that outlives the budget returns its
 * partial pages with a running status rather than blocking the run — the caller
 * can treat that as "more where this came from", which is honest.
 */
export async function crawlSite(
  url: string,
  opts: { limit?: number; maxDepth?: number },
  env: Record<string, string | undefined> = process.env,
): Promise<FirecrawlCrawlResult> {
  const cfg = config(env);
  const submission = await fetch(`${cfg.baseUrl}/v1/crawl`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ url, limit: opts.limit ?? 10, maxDepth: opts.maxDepth ?? 1, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });
  if (!submission.ok) throw new FirecrawlError(`Firecrawl crawl returned ${submission.status}`);
  const started = (await submission.json().catch(() => null)) as CrawlBody | null;
  const jobId = started?.id;
  if (!jobId) return { jobId: "", status: "failed", pages: [], error: started?.error ?? "crawl did not start" };

  const deadline = Date.now() + FIRECRAWL_TIMEOUT_MS;
  let status = started.status ?? "scraping";
  let pages: CrawlBody["data"] = started.data ?? [];
  while (status !== "completed" && status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await fetch(`${cfg.baseUrl}/v1/crawl/${jobId}`, {
      headers: headers(cfg),
      signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
    });
    if (!poll.ok) throw new FirecrawlError(`Firecrawl crawl status returned ${poll.status}`);
    const body = (await poll.json().catch(() => null)) as CrawlBody | null;
    status = body?.status ?? status;
    if (body?.data) pages = body.data;
  }

  return {
    jobId,
    status,
    pages: (pages ?? []).map((p) => ({
      url: p.metadata?.sourceURL ?? "",
      markdown: p.markdown ?? "",
      title: p.metadata?.title ?? null,
    })),
    error: status === "failed" ? "crawl failed" : null,
  };
}
