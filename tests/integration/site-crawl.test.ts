import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { captureDocuments } from "@/domains/capture/schema";
import { generationJobs } from "@/domains/jobs/schema";
import { documents, sources } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=a captured link bringing its site into the library as child
 * documents through one visible, cancellable job; fails_when=a link capture
 * starts no crawl (or one when the person chose "just this page"), a crawled
 * page is not filed as a document with a source row and linked to its capture,
 * an asset, an off-site page, an error page or a repeated address is filed,
 * progress is not reported, a retried crawl files a page twice, or a cancel
 * leaves the provider crawling; seam=createCapture and the crawl runner
 * against real Postgres, Firecrawl as a local HTTP fixture; no_claim=the real
 * crawler's robots and rate-limit behaviour (it is configured, not
 * reimplemented) and the browser panel.
 */

const handle = makeTestDb();
// Jobs are run by the tests themselves; nothing starts behind their back.
vi.mock("@/domains/jobs/kick", () => ({ kickGenerationJob: vi.fn() }));
let server: Server;
let base: string;
let crawl: { status: string; completed: number; total: number; data: unknown[]; deleted: number; submitted: unknown[] };

const page = (url: string, title: string, markdown: string, statusCode = 200) => ({
  markdown,
  metadata: { sourceURL: url, title, statusCode },
});

const SITE = [
  page("https://docs.example/", "Docs home", "Welcome to the docs."),
  page("https://docs.example/guide/", "Guide", "How to use the thing."),
  page("https://docs.example/guide#install", "Guide again", "Same page, other anchor."),
  page("https://www.docs.example/api", "API", "The API reference."),
  page("https://docs.example/logo.png", "Logo", "binary"),
  page("https://elsewhere.example/blog", "Off site", "Not this site."),
  page("https://docs.example/missing", "Missing", "Not found", 404),
  page("https://docs.example/empty", "Empty", "   "),
];

beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && req.url === "/v1/crawl") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        crawl.submitted.push(JSON.parse(body));
        json({ success: true, id: "crawl-1" });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/crawl/crawl-1") {
      return json({ success: true, status: crawl.status, completed: crawl.completed, total: crawl.total, data: crawl.data });
    }
    if (req.method === "DELETE" && req.url === "/v1/crawl/crawl-1") {
      crawl.deleted += 1;
      return json({ status: "cancelled" });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  await handle.client.end();
});

beforeEach(() => {
  crawl = { status: "completed", completed: SITE.length, total: SITE.length, data: SITE, deleted: 0, submitted: [] };
  vi.stubEnv("FIRECRAWL_API_URL", base);
  vi.stubEnv("CRAWL_MAX_PAGES", "");
});

async function signIn(label: string) {
  const seeded = await seedWorkspace(handle.db, `crawl-${label}-${Date.now()}`);
  return ownerAuth(seeded.userId, seeded.workspaceId);
}

async function crawlJobs(workspaceId: string) {
  return handle.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.workspaceId, workspaceId), eq(generationJobs.kind, "knowledge.crawl")));
}

/** A crawl runner that does not wait between polls. */
async function crawlRunner() {
  const { siteCrawlRunner } = await import("@/domains/knowledge/site-crawl");
  const firecrawl = await import("@/integrations/firecrawl/client");
  return siteCrawlRunner({
    submit: firecrawl.submitCrawl,
    poll: firecrawl.pollCrawl,
    cancel: firecrawl.cancelCrawl,
    sleep: async () => {},
  });
}

describe("site crawl jobs (real Postgres, Firecrawl fixture)", () => {
  it("starts a crawl job when an address is captured, alongside the read of its own page", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const auth = await signIn("capture");
    const capture = await createCapture(auth, { text: "https://docs.example/guide" });

    const [job] = await crawlJobs(auth.workspaceId);
    expect(job).toMatchObject({
      status: "queued",
      subject: `capture:${capture.id}`,
      title: "Reading docs.example",
      input: { url: "https://docs.example/guide", limit: 25, captureId: capture.id },
    });
    const reads = await handle.db
      .select({ topic: outboxEvents.topic })
      .from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, auth.workspaceId));
    expect(reads.map((row) => row.topic).sort()).toEqual(
      ["capture.enrichment_requested", "capture.url_content_requested", "generation.job_requested"].sort(),
    );
  });

  it("reads the page alone, with no crawl, when the person asks for just this page", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const auth = await signIn("page");
    await createCapture(auth, { text: "https://docs.example/guide", linkScope: "page" });
    expect(await crawlJobs(auth.workspaceId)).toEqual([]);
  });

  it("never crawls a video address", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const auth = await signIn("video");
    await createCapture(auth, { text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(await crawlJobs(auth.workspaceId)).toEqual([]);
  });

  it("files each readable page of the site once, as a child document of the capture, and reports progress", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const { runGenerationJob } = await import("@/domains/jobs/commands");
    const auth = await signIn("land");
    const capture = await createCapture(auth, { text: "https://docs.example/guide" });
    const [job] = await crawlJobs(auth.workspaceId);

    // The first poll finds the crawl still going with two pages read.
    crawl = { ...crawl, status: "scraping", completed: 2, total: 8, data: SITE.slice(0, 2) };
    const steps: unknown[] = [];
    const runner = await crawlRunner();
    let polls = 0;
    await runGenerationJob(
      { jobId: job.id, attempt: 1 },
      {
        "knowledge.crawl": (a, input, run) =>
          runner(a, input, {
            ...run,
            async progress(step, counts) {
              steps.push({ step, ...counts });
              await run.progress(step, counts);
              if (step === "Crawling" && ++polls === 1) {
                crawl = { ...crawl, status: "completed", completed: SITE.length, total: SITE.length, data: SITE };
              }
            },
          }),
      },
    );

    expect(crawl.submitted[0]).toMatchObject({
      url: "https://docs.example/guide",
      limit: 25,
      maxDepth: 2,
      allowExternalLinks: false,
      ignoreQueryParameters: true,
    });
    expect(steps).toEqual([{ step: "Starting the crawl" }, { step: "Crawling", done: 2, total: 25 }]);

    const [settled] = await crawlJobs(auth.workspaceId);
    expect(settled).toMatchObject({
      status: "ready",
      result: { href: `/command-center/inbox?id=${capture.id}`, notice: "Read 3 pages from docs.example." },
    });

    const children = await handle.db
      .select({ url: documents.sourceUrl, position: captureDocuments.position })
      .from(captureDocuments)
      .innerJoin(documents, eq(documents.id, captureDocuments.documentId))
      .where(eq(captureDocuments.captureId, capture.id))
      .orderBy(captureDocuments.position);
    expect(children).toEqual([
      { url: "https://docs.example/", position: 0 },
      { url: "https://docs.example/guide", position: 1 },
      { url: "https://www.docs.example/api", position: 2 },
    ]);
    const cited = await handle.db
      .select({ url: sources.url })
      .from(sources)
      .where(eq(sources.workspaceId, auth.workspaceId));
    expect(cited.map((row) => row.url).sort()).toEqual(children.map((child) => child.url).sort());
  });

  it("files nothing twice when the crawl is tried again", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const { retryGenerationJob, runGenerationJob } = await import("@/domains/jobs/commands");
    const auth = await signIn("retry");
    await createCapture(auth, { text: "https://docs.example/" });
    const [job] = await crawlJobs(auth.workspaceId);
    const runner = await crawlRunner();
    await runGenerationJob({ jobId: job.id, attempt: 1 }, { "knowledge.crawl": runner });
    const before = await handle.db.select().from(documents).where(eq(documents.workspaceId, auth.workspaceId));

    await handle.db.update(generationJobs).set({ status: "failed", error: "x", result: null }).where(eq(generationJobs.id, job.id));
    await retryGenerationJob(auth, job.id);
    await runGenerationJob({ jobId: job.id, attempt: 2 }, { "knowledge.crawl": runner });
    const after = await handle.db.select().from(documents).where(eq(documents.workspaceId, auth.workspaceId));
    expect(after).toHaveLength(before.length);
    expect(before).toHaveLength(3);
  });

  it("stops the provider's crawl when the job is cancelled", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const { cancelGenerationJob, runGenerationJob } = await import("@/domains/jobs/commands");
    const auth = await signIn("cancel");
    await createCapture(auth, { text: "https://docs.example/" });
    const [job] = await crawlJobs(auth.workspaceId);
    crawl = { ...crawl, status: "scraping", completed: 1, total: 8, data: SITE.slice(0, 1) };
    const runner = await crawlRunner();
    await runGenerationJob(
      { jobId: job.id, attempt: 1 },
      {
        "knowledge.crawl": (a, input, run) =>
          runner(a, input, {
            ...run,
            async progress(step, counts) {
              if (step === "Crawling") await cancelGenerationJob(auth, job.id);
              await run.progress(step, counts);
            },
          }),
      },
    );
    expect(crawl.deleted).toBe(1);
    const [settled] = await crawlJobs(auth.workspaceId);
    expect(settled.status).toBe("cancelled");
  });

  it("fails with a reason the person can read when nothing readable was found", async () => {
    const { submitSiteCrawl } = await import("@/domains/knowledge/site-crawl");
    const { runGenerationJob } = await import("@/domains/jobs/commands");
    const auth = await signIn("empty");
    crawl = { ...crawl, data: [SITE[4], SITE[5], SITE[6]] };
    const { job } = await submitSiteCrawl(auth, { url: new URL("https://docs.example/") });
    await runGenerationJob({ jobId: job.id, attempt: 1 }, { "knowledge.crawl": await crawlRunner() });
    const [settled] = await crawlJobs(auth.workspaceId);
    expect(settled).toMatchObject({ status: "failed", error: "No readable pages were found at that address." });
  });

  it("queues the agents' crawl as the same job, one per site per day", async () => {
    const { crawlSiteForAgent } = await import("@/domains/knowledge/web-fetch");
    const auth = await signIn("agent");
    const first = await crawlSiteForAgent(auth, { url: "https://docs.example/" });
    const second = await crawlSiteForAgent(auth, { url: "https://docs.example/#top" });
    expect(first).toMatchObject({ ok: true, queued: true, url: "https://docs.example/", limit: 25, maxDepth: 2 });
    expect(second.ok).toBe(true);
    expect(await crawlJobs(auth.workspaceId)).toHaveLength(1);
  });
});
