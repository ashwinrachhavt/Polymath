import * as Sentry from "@sentry/nextjs";

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

class FirecrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlError";
  }
}

/** A non-2xx answer from Firecrawl, logged with the operation and status only (never the URL). */
function firecrawlFailed(operation: "scrape" | "crawl" | "crawl status", status: number): FirecrawlError {
  Sentry.logger.warn("firecrawl request failed", { operation, status });
  return new FirecrawlError(`Firecrawl ${operation} returned ${status}`);
}

/** The deployment has no Firecrawl endpoint. Repeating the call cannot help, so callers must not offer a retry. */
export class FirecrawlNotConfiguredError extends FirecrawlError {
  constructor() {
    super("FIRECRAWL_API_URL is not set (e.g. http://127.0.0.1:3002).");
    this.name = "FirecrawlNotConfiguredError";
  }
}

/** One call never hangs a run. Crawl polling is bounded by the same budget. */
const FIRECRAWL_TIMEOUT_MS = 20_000;

type FirecrawlConfig = { baseUrl: string; apiKey: string | null };

function config(env: Record<string, string | undefined>): FirecrawlConfig {
  const baseUrl = env.FIRECRAWL_API_URL?.trim();
  if (!baseUrl) {
    throw new FirecrawlNotConfiguredError();
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
  if (!response.ok) throw firecrawlFailed("scrape", response.status);
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
  completed?: number;
  total?: number;
  next?: string | null;
  data?: Array<{ markdown?: string; metadata?: { title?: string; sourceURL?: string; statusCode?: number } }>;
  error?: string;
};

export type CrawlPage = { url: string; markdown: string; title: string | null; statusCode: number | null };

export type CrawlPollResult = {
  status: string;
  /** Pages the provider has finished, and the pages it has found so far (both bounded by the limit). */
  completed: number;
  total: number;
  pages: CrawlPage[];
  error: string | null;
};

/** Firecrawl's terminal states. Anything else means "still working". */
export function isTerminalCrawlStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export type CrawlOptions = {
  limit: number;
  maxDepth: number;
  /** Path regexes the crawler never visits (assets, binaries). */
  excludePaths?: string[];
  /** Pages scraped at once; the self-hosted instance's politeness knob. */
  maxConcurrency?: number;
  /** Seconds between page requests, so a site is not hammered. */
  delaySeconds?: number;
};

/*
 * Crawl is three transports, not one.
 *
 * `submitCrawl` starts a job and returns its id; `pollCrawl` reads it once;
 * `cancelCrawl` stops it. None waits. The caller decides whether to sleep and
 * poll again. The crawler stays on the address's own site but may walk the
 * whole of it, not only the paths below the address; it follows no external
 * link, and it honours robots.txt, which is Firecrawl's default and is never
 * overridden here.
 */
export async function submitCrawl(
  url: string,
  opts: CrawlOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<{ jobId: string }> {
  const cfg = config(env);
  const submission = await fetch(`${cfg.baseUrl}/v1/crawl`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      url,
      limit: opts.limit,
      maxDepth: opts.maxDepth,
      allowExternalLinks: false,
      allowBackwardLinks: true,
      // ?utm=a and ?utm=b are one page.
      ignoreQueryParameters: true,
      ...(opts.excludePaths?.length ? { excludePaths: opts.excludePaths } : {}),
      ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
      ...(opts.delaySeconds ? { delay: opts.delaySeconds } : {}),
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });
  if (!submission.ok) throw firecrawlFailed("crawl", submission.status);
  const started = (await submission.json().catch(() => null)) as CrawlBody | null;
  if (!started?.id) throw new FirecrawlError(started?.error ?? "crawl did not start");
  return { jobId: started.id };
}

/** Result pages a large crawl answer is split into; more than this is a provider bug, not a site. */
const MAX_RESULT_PAGES = 20;

/**
 * One status read, following the provider's `next` links so every page it
 * holds so far comes back. No retry, no loop over time; a non-ok response is
 * the caller's to schedule.
 */
export async function pollCrawl(
  jobId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CrawlPollResult> {
  const cfg = config(env);
  let next: string | null = `${cfg.baseUrl}/v1/crawl/${encodeURIComponent(jobId)}`;
  let first: CrawlBody | null = null;
  const pages: CrawlPage[] = [];
  for (let hop = 0; next && hop < MAX_RESULT_PAGES; hop += 1) {
    const response = await fetch(next, { headers: headers(cfg), signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS) });
    if (!response.ok) throw firecrawlFailed("crawl status", response.status);
    const body = (await response.json().catch(() => null)) as CrawlBody | null;
    if (!body) throw new FirecrawlError("Firecrawl crawl status returned no body");
    first ??= body;
    for (const p of body.data ?? []) {
      pages.push({
        url: p.metadata?.sourceURL ?? "",
        markdown: p.markdown ?? "",
        title: p.metadata?.title ?? null,
        statusCode: p.metadata?.statusCode ?? null,
      });
    }
    // Only ever follow a link back to the same instance: the answer is not a place to be sent elsewhere.
    next = typeof body.next === "string" && body.next.startsWith(`${cfg.baseUrl}/`) ? body.next : null;
  }
  const status = first?.status ?? "scraping";
  return {
    status,
    completed: first?.completed ?? pages.length,
    total: first?.total ?? pages.length,
    pages,
    error: status === "failed" ? (first?.error ?? "crawl failed") : null,
  };
}

/** Stops a crawl. A crawl that already ended answers with an error, which is not the caller's problem. */
export async function cancelCrawl(jobId: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const cfg = config(env);
  await fetch(`${cfg.baseUrl}/v1/crawl/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: headers(cfg),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  }).catch(() => undefined);
}
