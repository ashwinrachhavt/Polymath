import type { AuthContext } from "@/domains/identity/resolve";
import { submitSiteCrawl } from "@/domains/knowledge/site-crawl";
import { assertPublicUrl } from "@/domains/knowledge/web-fetch";
import { parseVideoId } from "@/integrations/youtube/transcript";
import type { TxDrizzle } from "@/lib/db-transaction";

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
