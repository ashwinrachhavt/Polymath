import { cacheLife, cacheTag } from "next/cache";
import { countToClarify, searchCaptures, type InboxFilter, type CaptureKindFilter } from "@/domains/capture/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { capturesTag } from "@/lib/cache-tags";

/*
 * Cached reads for the Inbox page (same App Shell rationale as the Briefing
 * wrapper). searchCaptures is keyed by its full input, so each filter/page
 * combination caches separately. Inbox and shell quick-capture mutations
 * updateTag(capturesTag) for read-your-own-writes.
 */
export async function searchCapturesForPage(
  auth: AuthContext,
  input: { filter?: InboxFilter; kind?: CaptureKindFilter; query?: string; limit: number; offset: number },
) {
  "use cache";
  cacheLife("default");
  cacheTag(capturesTag(auth));
  return searchCaptures(auth, input);
}

export async function countToClarifyForPage(auth: AuthContext): Promise<number> {
  "use cache";
  cacheLife("default");
  cacheTag(capturesTag(auth));
  return countToClarify(auth);
}
