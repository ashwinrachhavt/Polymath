"use cache";

import { cacheLife, cacheTag } from "next/cache";
import { openInvitationsForEmail } from "@/domains/identity/invitations";
import { getPreferences } from "@/domains/identity/preferences";
import { listSwitchableWorkspaces } from "@/domains/identity/resolve";
import type { AuthContext } from "@/domains/identity/resolve";
import { invitationsTag, prefsTag, workspacesTag } from "@/lib/cache-tags";

/*
 * The workspace shell's reads, behind the repo's 'use cache' wrapper pattern
 * (the same shape neuralflow/work/data.ts uses for its page data). These three
 * sit under every route in the (workspace) group, so their cost is paid on
 * every navigation; caching them turns a per-navigation refetch chain into a
 * tag-expired read. The triage feed deliberately stays uncached: the decision
 * queue must reflect freshly written rows on the very next render, and its
 * read is one query inside the layout's parallel batch anyway.
 *
 * Identity is resolved outside: every wrapper takes plain values (AuthContext
 * fields, a user id, an email) as its cache key — a cached scope cannot read
 * request-time APIs like cookies(), so the layout resolves the session first
 * and passes the context in.
 *
 * Staleness is bounded by construction: each wrapper carries both a short
 * cacheLife profile and a tag, and the mutation sites (settings, question,
 * inbox, reviews, workspace, and invitation actions) call updateTag on write.
 * A missed tag fails the invalidation unit tests, not a user's next render.
 */

/** Preferences for this workspace+user — layout interface mode. */
export async function cachedPreferences(auth: AuthContext) {
  cacheTag(prefsTag(auth));
  cacheLife("minutes"); // invalidated on every preference write
  return getPreferences(auth);
}

/** Switcher rows: every active membership for the signed-in user. */
export async function cachedSwitchableWorkspaces(userId: string) {
  cacheTag(workspacesTag(userId));
  cacheLife("minutes"); // invalidated on membership writes for this user
  return listSwitchableWorkspaces(userId);
}

/** Switcher pending rows: open invitations addressed to one email. */
export async function cachedOpenInvitationsForEmail(email: string) {
  cacheTag(invitationsTag(email));
  cacheLife("minutes"); // invalidated on invitation create/revoke for this email
  return openInvitationsForEmail(email);
}
