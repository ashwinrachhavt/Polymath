import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { captureInWorkspace, linkCaptureDocument } from "@/domains/capture/children";
import type { AuthContext } from "@/domains/identity/resolve";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobCancelled, GenerationJobFailure } from "@/domains/jobs/state";
import {
  cancelCrawl,
  FirecrawlNotConfiguredError,
  isTerminalCrawlStatus,
  pollCrawl,
  submitCrawl,
  type CrawlPage,
} from "@/integrations/firecrawl/client";
import { db } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";
import { canonicalCaptureUrl } from "@/lib/safe-fetch";
import { intakeFile } from "./intake";
import { documents } from "./schema";
import { recordSource } from "./sources";
import { assertPublicUrl } from "./web-fetch";

/*
 * Reading a whole site: the crawl behind a link capture and the agents'
 * web.crawl tool. One generation job of kind "knowledge.crawl" per request.
 *
 * The runner submits one Firecrawl crawl (the self-hosted instance, so it is
 * free), then polls it every POLL_EVERY_MS and files each page as it arrives,
 * reporting "Crawling n/25" through the job. Bounds:
 *
 *   - pages: CRAWL_PAGE_LIMIT (25 by default, CRAWL_MAX_PAGES picks 20-30);
 *   - depth: CRAWL_DEPTH links from the address given;
 *   - scope: the address's own site, all of it rather than only the paths
 *     below the address (a link deep inside a docs site should bring the
 *     docs, not one page); the crawler follows no external link,
 *     honours robots.txt (Firecrawl's default) and is rate limited
 *     (CRAWL_CONCURRENCY pages at once, CRAWL_DELAY_SECONDS apart);
 *   - pages that are assets or binaries (images, scripts, fonts, archives,
 *     media) are never visited and never filed;
 *   - time: CRAWL_MAX_MS, after which the crawl is stopped and what was read is kept.
 *
 * Every page becomes a library document with a source row, the same as any
 * captured URL. A page already in the library (documents are unique per URL)
 * is reused, never filed twice, so a retried crawl converges. When the crawl
 * belongs to a capture, each page is also linked to it as a child document
 * (capture_documents), which is how a captured docs site becomes something to
 * zettelize. Cancelling the job stops the Firecrawl crawl too.
 */

export const SITE_CRAWL_KIND = "knowledge.crawl";

export const CRAWL_DEPTH = 2;
const CRAWL_CONCURRENCY = 3;
const CRAWL_DELAY_SECONDS = 0.25;
const POLL_EVERY_MS = 1_500;
const CRAWL_MAX_MS = 15 * 60_000;
/** Status reads that may fail in a row before the crawl is given up as unreachable. */
const MAX_POLL_FAILURES = 5;

const PAGE_LIMIT = { min: 20, max: 30, fallback: 25 } as const;

/** How many pages a crawl reads: CRAWL_MAX_PAGES when it is a whole number, held to 20-30; else 25. */
export function crawlPageLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CRAWL_MAX_PAGES?.trim();
  const asked = raw ? Number(raw) : NaN;
  if (!Number.isInteger(asked)) return PAGE_LIMIT.fallback;
  return Math.min(PAGE_LIMIT.max, Math.max(PAGE_LIMIT.min, asked));
}

const ASSET_EXTENSION =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|css|js|mjs|map|woff2?|ttf|otf|eot|zip|gz|tgz|rar|7z|tar|dmg|exe|msi|pkg|deb|rpm|apk|iso|bin|mp4|m4v|mov|avi|mkv|webm|mp3|wav|ogg|m4a|flac)$/i;

/** The crawler's exclusion list: the same extensions, as path regexes. */
const EXCLUDE_ASSET_PATHS = [`.*${ASSET_EXTENSION.source}`];

/** True for an address that is a file to download rather than a page to read. */
export function isAssetUrl(url: URL): boolean {
  return ASSET_EXTENSION.test(url.pathname);
}

/** www.example.com and example.com are one site. */
function siteOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Which crawled pages may be filed, in the order they arrived: public http(s)
 * addresses on the starting site, not assets, with readable text and no error
 * status, each address once. `already` holds the keys filed on earlier passes.
 */
export function pagesToFile(
  start: URL,
  pages: CrawlPage[],
  already: ReadonlySet<string>,
): Array<{ key: string; url: URL; page: CrawlPage }> {
  const keep: Array<{ key: string; url: URL; page: CrawlPage }> = [];
  const seen = new Set(already);
  for (const page of pages) {
    const url = assertPublicUrl(page.url);
    if (!url || siteOf(url) !== siteOf(start) || isAssetUrl(url)) continue;
    if (page.statusCode !== null && page.statusCode >= 400) continue;
    if (!page.markdown.trim()) continue;
    const key = canonicalCaptureUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push({ key, url: new URL(key), page });
  }
  return keep;
}

const inputSchema = z.object({
  url: z.url(),
  limit: z.number().int().min(1).max(PAGE_LIMIT.max),
  /** The capture the pages belong to, when the crawl was started from one. */
  captureId: z.uuid().optional(),
});

type CrawlInput = z.infer<typeof inputSchema>;

/**
 * The job that crawls a site, ready to submit (submitGenerationJob, or
 * submitOrRetryGenerationJob where asking again means trying again). The key
 * makes one crawl per capture, and for the agents' tool one per site per day:
 * asking twice joins the first job.
 */
export function siteCrawlJob(input: { url: URL; captureId?: string; limit?: number }) {
  const url = canonicalCaptureUrl(input.url);
  const value: CrawlInput = {
    url,
    limit: input.limit ?? crawlPageLimit(),
    ...(input.captureId ? { captureId: input.captureId } : {}),
  };
  return {
    kind: SITE_CRAWL_KIND,
    subject: input.captureId ? `capture:${input.captureId}` : undefined,
    idempotencyKey: input.captureId
      ? `crawl:capture:${input.captureId}`
      : `crawl:${url}:${new Date().toISOString().slice(0, 10)}`,
    title: `Reading ${siteOf(new URL(url))}`,
    input: value,
  };
}

export type CrawlClient = {
  submit: typeof submitCrawl;
  poll: typeof pollCrawl;
  cancel: typeof cancelCrawl;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** The self-hosted Firecrawl, read when a crawl runs (not at import, so tests can replace the module). */
function firecrawl(): CrawlClient {
  return { submit: submitCrawl, poll: pollCrawl, cancel: cancelCrawl, sleep: abortableSleep };
}

export const siteCrawlRunner = (injected?: CrawlClient): GenerationJobRunner =>
  async function crawlSite(auth, raw, run) {
    const client = injected ?? firecrawl();
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("malformed crawl input");
    const input = parsed.data;
    const start = assertPublicUrl(input.url);
    if (!start) throw new GenerationJobFailure("That address is not a public web page.");
    const captureId = input.captureId && (await captureInWorkspace(auth, input.captureId)) ? input.captureId : null;

    await run.progress("Starting the crawl");
    let providerJob: string;
    try {
      ({ jobId: providerJob } = await client.submit(start.href, {
        limit: input.limit,
        maxDepth: CRAWL_DEPTH,
        excludePaths: EXCLUDE_ASSET_PATHS,
        maxConcurrency: CRAWL_CONCURRENCY,
        delaySeconds: CRAWL_DELAY_SECONDS,
      }));
    } catch (cause) {
      throw new GenerationJobFailure(
        cause instanceof FirecrawlNotConfiguredError
          ? "Reading sites is not set up on this deployment."
          : "The site reader could not be reached. Try again.",
      );
    }

    const filed: string[] = [];
    const filedKeys = new Set<string>();
    let failedPages = 0;
    let pollFailures = 0;
    const deadline = Date.now() + CRAWL_MAX_MS;
    let finished = false;
    try {
      for (;;) {
        let poll;
        try {
          poll = await client.poll(providerJob);
          pollFailures = 0;
        } catch {
          pollFailures += 1;
          if (pollFailures >= MAX_POLL_FAILURES) {
            throw new GenerationJobFailure("The site reader stopped answering. Try again.");
          }
          await client.sleep(POLL_EVERY_MS, run.signal);
          continue;
        }

        for (const { key, url, page } of pagesToFile(start, poll.pages, filedKeys)) {
          filedKeys.add(key);
          const documentId = await filePage(auth, { url, page, providerJob }).catch((cause: unknown) => {
            console.warn("[crawl] could not file a page", providerJob, cause instanceof Error ? cause.name : cause);
            return null;
          });
          if (!documentId) {
            failedPages += 1;
            continue;
          }
          if (captureId) await linkCaptureDocument(auth, { captureId, documentId, position: filed.length });
          filed.push(documentId);
        }

        const terminal = isTerminalCrawlStatus(poll.status);
        if (terminal) {
          finished = true;
          if (poll.status !== "completed" && filed.length === 0) {
            throw new GenerationJobFailure(`The site could not be read: ${poll.error ?? "the crawl stopped"}.`);
          }
          break;
        }
        await run.progress("Crawling", { done: Math.min(poll.completed, input.limit), total: input.limit });
        if (Date.now() > deadline) break;
        await client.sleep(POLL_EVERY_MS, run.signal);
        if (run.signal.aborted) throw new GenerationJobCancelled();
      }
    } finally {
      // Cancelled, timed out or failed mid-way: stop the provider's crawl too.
      if (!finished) await client.cancel(providerJob);
    }

    if (filed.length === 0) throw new GenerationJobFailure("No readable pages were found at that address.");
    const site = siteOf(start);
    const skipped = failedPages > 0 ? ` ${failedPages} could not be filed.` : "";
    return {
      href: captureId ? `/command-center/inbox?id=${captureId}` : `/polymath/knowledge?doc=${filed[0]}`,
      notice: `Read ${filed.length} page${filed.length === 1 ? "" : "s"} from ${site}.${skipped}`,
    };
  };

/**
 * One page into the library: the existing document for its address, or a new
 * one with a source row. Returns the document's id, or null when the page is
 * too large to file.
 */
async function filePage(
  auth: AuthContext,
  input: { url: URL; page: CrawlPage; providerJob: string },
): Promise<string | null> {
  const sourceUrl = input.url.href;
  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, sourceUrl)))
    .limit(1);
  if (existing) return existing.id;

  const bytes = new TextEncoder().encode(input.page.markdown.trim());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return null;
  const contentHash = await sha256Hex(bytes);
  const title = pageTitle(input.page, input.url);
  const result = await intakeFile(auth, {
    bytes,
    filename: `${pageSlug(input.url)}.md`,
    title,
    verdict: { ok: true, mimeType: "text/markdown" },
    contentHash,
    origin: "crawl",
    sourceUrl,
    inTransaction: (tx) =>
      recordSource(auth, tx, { title, url: sourceUrl, contentHash, kind: "web", providerRequestId: input.providerJob }),
  });
  return result.documentId;
}

/**
 * A page's name: its own title, else its first heading (a markdown or text
 * page has no title), else its path, never just the site's host, which would
 * name every untitled page the same.
 */
export function pageTitle(page: Pick<CrawlPage, "title" | "markdown">, url: URL): string {
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(page.markdown)?.[1];
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
  const name = page.title?.trim() || heading?.trim() || (path ? `${url.hostname}/${path}` : url.hostname);
  return name.slice(0, 200);
}

function pageSlug(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const base = (last.replace(/\.[^.]+$/, "") || url.hostname).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return (base || "page").slice(0, 80);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
