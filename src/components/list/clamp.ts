import { redirect } from "next/navigation";
import { listHref, pageCount, type RawSearchParams } from "@/lib/list-params";

/**
 * A stale link (page=9 after a filter shrank the list, or after rows were
 * deleted) would otherwise render an empty page under a non-empty count.
 * Send it to the last real page instead. Call after the read, in the server page.
 */
export function redirectPastEnd(
  basePath: string,
  raw: RawSearchParams,
  page: number,
  pageSize: number,
  total: number,
  pageParam = "page",
): void {
  const last = pageCount(total, pageSize);
  if (total > 0 && page > last) redirect(listHref(basePath, raw, { [pageParam]: last === 1 ? undefined : last }));
}
