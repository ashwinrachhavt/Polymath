import { cacheLife, cacheTag } from "next/cache";
import { getBriefing, type BriefingData } from "@/domains/work/briefing";
import type { AuthContext } from "@/domains/identity/resolve";
import { tasksTag } from "@/lib/cache-tags";

/*
 * Cached read for the Briefing page. The domain function stays uncached for
 * callers that need request-fresh data; the page goes through this wrapper so
 * the rendered list lands in the route's App Shell and link prefetch resolves
 * it before the click (partialPrefetching carries cached session content with
 * a stale time of at least five minutes, which the default profile is).
 * Briefing and Work mutations updateTag(tasksTag) for read-your-own-writes.
 */
export async function getBriefingForPage(auth: AuthContext): Promise<BriefingData> {
  "use cache";
  cacheLife("default");
  cacheTag(tasksTag(auth));
  return getBriefing(auth);
}
