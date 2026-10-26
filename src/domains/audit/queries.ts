import { and, desc, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { auditEvents } from "./schema";

export type ActivityRow = {
  action: string;
  actorKind: string;
  subjectType: string;
  summary: string;
  createdAt: Date;
};

/*
 * The workspace's own audit feed, newest first. Every domain already writes
 * these rows through recordAudit; this is the read surface the Activity rail
 * never had (the rail read a browser-local preview log instead).
 *
 * The feed is an allowlist, and it fails closed. A summary renders verbatim
 * only when its action is in SAFE_SUMMARY_ACTIONS - each one checked to be a
 * code-authored template over entities every workspace member can already see
 * in the originating surface (calendar, opportunities, inbox, integrations
 * settings, daybook). Anything else - future actions included - renders as a
 * generic label derived from the action's own constant name, never the raw
 * stored summary, so a new callsite cannot widen disclosure by accident.
 *
 * Two rows of the policy sit outside the allowlist:
 *
 * - PRIVATE_SUBJECT_TYPES: a Supervisor thread is one member's private
 *   assistant exchange (respond.ts refuses to project it into shared
 *   knowledge for exactly that reason), and its audit summaries can carry
 *   the member's own query text. Workspace membership is not authorization
 *   to read those, so thread events never join the feed at all.
 * - integration.connection_failed is allowlisted but sanitized: the summary
 *   embeds a freeform provider reason straight off the wire, so the feed
 *   keeps only the established-visible "Connection failed: provider as
 *   alias" prefix (provider and alias are member-visible in integrations
 *   settings) and drops the reason.
 *
 * Raw metadata payloads and subject ids are never selected at all. Notes and
 * artifacts carry no per-member privacy model in the schema (verified
 * 2026-10-26: no visibility/audience/owner columns on artifacts or related
 * knowledge tables), so their titles are workspace-shared by design; if a
 * private note type ever lands, its action must not join the allowlist
 * without a subject-authorization check here.
 */
const PRIVATE_SUBJECT_TYPES = ["thread"] as const;

const SAFE_SUMMARY_ACTIONS = new Set([
  // Calendar (member-visible calendar surfaces).
  "event.created",
  "event.time_blocked",
  "event.follow_up_created",
  "event.moved",
  "event.cancelled",
  // Opportunities (member-visible opportunities surface).
  "opportunity.created",
  "opportunity.updated",
  "opportunity.stage_changed",
  "opportunity.archived",
  "opportunity.deadline_added",
  "opportunity.deadline_met",
  // Integrations (member-visible integrations settings). connection_failed is
  // in the set but passes through sanitizeSummary below.
  "integration.google_calendar_synced",
  "integration.connection_started",
  "integration.connection_completed",
  "integration.connection_failed",
  "integration.account_registered",
  "integration.account_tier_set",
  "integration.account_capability_set",
  "integration.account_renamed",
  "integration.write_default_set",
  // Daybook (dates and counts only, never entry text).
  "daybook.pin_added",
  "daybook.pin_removed",
  "daybook.shutdown",
  // Capture inbox (member-visible inbox; summaries name kinds, filenames and
  // workspace-entity titles, never body text).
  "capture.created",
  "capture.edited",
  "capture.parked",
  "capture.unparked",
  "capture.archived",
  "capture.restored",
  "capture.converted",
  "capture.proposal_accepted",
  "capture.proposal_rejected",
  "capture.zettels_requested",
  "capture.zettels_proposed",
  "capture.transcribed",
  // Workspace-level lifecycle and proposals.
  "inventory.imported",
  "onboarding.completed",
  "spending_policy.created",
  "meeting.debriefed",
  "note.snapshot",
]);

/** Dynamic action families verified as code-authored over member-visible settings surfaces. */
const SAFE_SUMMARY_PREFIXES = ["integration.account_"] as const;

export function isSafeSummaryAction(action: string): boolean {
  return SAFE_SUMMARY_ACTIONS.has(action) || SAFE_SUMMARY_PREFIXES.some((prefix) => action.startsWith(prefix));
}

/** Humanized constant name - carries no stored content, so it is always safe. */
export function genericSummary(action: string): string {
  const words = action.replace(/[._]/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} recorded`;
}

export function sanitizeSummary(action: string, summary: string): string {
  if (action === "integration.connection_failed") {
    const cut = summary.indexOf(" — ");
    return cut === -1 ? summary : summary.slice(0, cut);
  }
  return summary;
}

export function projectSummary(action: string, summary: string): string {
  if (!isSafeSummaryAction(action)) return genericSummary(action);
  return sanitizeSummary(action, summary);
}

export async function listWorkspaceActivity(auth: AuthContext, { limit = 50 }: { limit?: number } = {}): Promise<ActivityRow[]> {
  const rows = await db
    .select({
      action: auditEvents.action,
      actorKind: auditEvents.actorKind,
      subjectType: auditEvents.subjectType,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, auth.workspaceId), notInArray(auditEvents.subjectType, [...PRIVATE_SUBJECT_TYPES])))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, summary: projectSummary(row.action, row.summary) }));
}
