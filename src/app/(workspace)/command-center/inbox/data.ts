import { cacheLife, cacheTag } from "next/cache";
import {
  countInboxTabs,
  getCapture,
  searchCaptures,
  type InboxFilter,
  type CaptureKindFilter,
} from "@/domains/capture/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { capturesTag } from "@/lib/cache-tags";

/*
 * Cached reads for the Inbox page (same App Shell rationale as the Briefing
 * wrapper). Each read is keyed by its full input, so every filter/page/id
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

export async function countInboxTabsForPage(auth: AuthContext): Promise<Record<InboxFilter, number>> {
  "use cache";
  cacheLife("default");
  cacheTag(capturesTag(auth));
  return countInboxTabs(auth);
}

export async function getCaptureForPage(auth: AuthContext, id: string) {
  "use cache";
  cacheLife("default");
  cacheTag(capturesTag(auth));
  return getCapture(auth, id);
}
