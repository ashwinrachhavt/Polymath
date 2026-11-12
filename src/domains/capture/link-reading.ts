import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { retryGenerationJob } from "@/domains/jobs/commands";
import { submitSiteCrawl } from "@/domains/knowledge/site-crawl";
import { assertPublicUrl } from "@/domains/knowledge/web-fetch";
import { parseVideoId } from "@/integrations/youtube/transcript";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { captures } from "./schema";

/*
 * How much of the web a captured address brings in. "site" (the default)
 * reads the page and crawls the site around it into child documents, so a
 * captured docs page brings the docs; "page" reads the page alone. The choice
 * is the person's, per capture. A video address is never crawled: its
 * transcript is the content.
 */

export type LinkScope = "site" | "page";

export const DEFAULT_LINK_SCOPE: LinkScope = "site";

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
  const { job, created } = await submitSiteCrawl(auth, { url, captureId: input.captureId }, tx);
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
): Promise<{ jobId: string; attempt: number; created: boolean } | null> {
  const [capture] = await db
    .select({ url: captures.url, createdBy: captures.createdBy })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
    .limit(1);
  if (!capture?.url || (capture.createdBy !== auth.userId && auth.role !== "owner")) return null;
  const url = assertPublicUrl(capture.url);
  if (!url || parseVideoId(url.href)) return null;
  const { job, created } = await submitSiteCrawl(auth, { url, captureId: input.captureId });
  // The capture's crawl was stopped or failed earlier: asking again is trying it again.
  if (!created && (job.status === "cancelled" || job.status === "failed")) {
    const retried = await retryGenerationJob(auth, job.id);
    if (retried) return { jobId: retried.id, attempt: retried.attempt, created: true };
  }
  return { jobId: job.id, attempt: job.attempt, created };
}
