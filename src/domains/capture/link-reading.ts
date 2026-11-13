import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { GenerationJobView } from "@/domains/jobs/state";
import { submitGenerationJob, submitOrRetryGenerationJob } from "@/domains/jobs/commands";
import { siteCrawlJob } from "@/domains/knowledge/site-crawl";
import { queueYouTubeCapture } from "@/domains/knowledge/youtube-capture";
import { assertPublicUrl } from "@/domains/knowledge/web-fetch";
import { parseVideoId } from "@/integrations/youtube/transcript";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { captures } from "./schema";

/*
 * How much of the web a captured address brings in. "site" (the default)
 * reads the page and crawls the site around it into child documents, so a
 * captured docs page brings the docs; "page" reads the page alone. The choice
 * is the person's, per capture. A video address is never crawled: it is
 * absorbed instead (its transcript filed as the capture's child document).
 */

export type LinkScope = "site" | "page";

const DEFAULT_LINK_SCOPE: LinkScope = "site";

/**
 * Accepts the crawl for a captured address in the capture's own transaction.
 * Returns the attempt to start once that transaction commits, or null when
 * there is nothing to start (page scope, a video, an address that is not a
 * public page, or a crawl this capture already has).
 */
export async function startLinkCrawl(
  tx: TxDrizzle,
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: { captureId: string; url: string; scope?: LinkScope },
): Promise<{ jobId: string; attempt: number } | null> {
  if ((input.scope ?? DEFAULT_LINK_SCOPE) !== "site") return null;
  const url = assertPublicUrl(input.url);
  if (!url || parseVideoId(url.href)) return null;
  const { job, created } = await submitGenerationJob(auth, siteCrawlJob({ url, captureId: input.captureId }), tx);
  return created ? { jobId: job.id, attempt: job.attempt } : null;
}

/**
 * "Read the whole site" on a capture read as one page, or one whose crawl was
 * stopped. Only its author or a workspace owner may ask, as for a page
 * re-read. A capture keeps one crawl job: asking again returns it, and a
 * stopped or failed one is tried again. Null when the capture has no public,
 * non-video address.
 */
export async function crawlCaptureSite(
  auth: AuthContext,
  input: { captureId: string },
): Promise<{ job: GenerationJobView; started: { jobId: string; attempt: number } | null } | null> {
  const [capture] = await db
    .select({ url: captures.url, createdBy: captures.createdBy })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
    .limit(1);
  if (!capture?.url || (capture.createdBy !== auth.userId && auth.role !== "owner")) return null;
  const url = assertPublicUrl(capture.url);
  if (!url || parseVideoId(url.href)) return null;
  return submitOrRetryGenerationJob(auth, siteCrawlJob({ url, captureId: input.captureId }));
}

/**
 * A captured video address: its absorption job files the transcript as a
 * library document, linked to the capture as its child. Runs after the
 * capture commits; a failure to queue leaves the capture as it is (its own
 * page read still runs) and is logged, never thrown at the person.
 */
export async function absorbCapturedVideo(auth: AuthContext, input: { captureId: string; url: string }): Promise<void> {
  if (!parseVideoId(input.url)) return;
  try {
    const queued = await queueYouTubeCapture(auth, { url: input.url, captureId: input.captureId });
    if (!queued.ok) console.warn("[capture] video not queued", input.captureId, queued.error);
  } catch (cause) {
    console.error("[capture] video could not be queued", input.captureId, cause instanceof Error ? cause.name : cause);
  }
}
