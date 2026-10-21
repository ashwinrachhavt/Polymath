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

/*
 * Detail is deliberately NOT cached.
 *
 * This was `"use cache"` with `cacheLife("default")`, which outlives a
 * navigation. Selecting a second capture re-rendered the pane with the first
 * one's row for the life of that entry — the list highlighted row B while the
 * pane showed A. A detail view of one row costs one indexed read; a stale
 * detail view costs the owner's trust in every row they click.
 */
export async function getCaptureForPage(auth: AuthContext, id: string) {
  return getCapture(auth, id);
}
