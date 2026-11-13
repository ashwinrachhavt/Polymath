import { and, desc, eq, ilike, inArray, lt, notInArray, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { getUserDisplayNames } from "@/domains/identity/members";
import { activityVisibleActions, actionsInCategory, type EventCategory } from "./events/registry";
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

export const SAFE_SUMMARY_ACTIONS = new Set([
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
  "capture.zettels_created",
  "document.zettels_created",
  "capture.transcribed",
  // Workspace-level lifecycle and proposals.
  "inventory.imported",
  "onboarding.completed",
  "spending_policy.created",
  "meeting.debriefed",
  "note.snapshot",
]);

/** Dynamic action families verified as code-authored over member-visible settings surfaces. */
export const SAFE_SUMMARY_PREFIXES = ["integration.account_"] as const;

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

export async function listWorkspaceActivity(
  auth: AuthContext,
  { limit = 50 }: { limit?: number } = {},
): Promise<ActivityRow[]> {
  const rows = await db
    .select({
      action: auditEvents.action,
      actorKind: auditEvents.actorKind,
      subjectType: auditEvents.subjectType,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, auth.workspaceId),
        notInArray(auditEvents.subjectType, [...PRIVATE_SUBJECT_TYPES]),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, summary: projectSummary(row.action, row.summary) }));
}

/*
 * The extended read model beside listWorkspaceActivity (consumers migrate
 * before it is deleted). The wider row exists so the presenter can attribute
 * actors, resolve destinations and group operations - the fields the legacy
 * row never carried. The privacy invariants are unchanged and structural:
 * workspace scope and the thread exclusion hold, and the metadata column is
 * not selected at all, so raw metadata cannot reach a client surface through
 * this function. When the presenter (a later wave) needs payloads, it reads
 * metadata inside the domain and shows only registry-defined fields.
 */
export type ActivityEventRow = {
  id: string;
  action: string;
  actorId: string | null;
  actorKind: "user" | "system" | "agent";
  subjectType: string;
  subjectId: string | null;
  operationId: string | null;
  /** RAW stored summary: projection happens in the presenter, not here. */
  summary: string;
  createdAt: Date;
};

export type ActivityEventPage = { rows: ActivityEventRow[]; nextCursor: string | null };

/** Keyset ordering is (created_at DESC, id DESC); the cursor carries both columns. */
type ActivityCursor = { createdAt: Date; id: string };

const CURSOR_SEPARATOR = "\n";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeActivityCursor(row: Pick<ActivityEventRow, "createdAt" | "id">): string {
  return Buffer.from(`${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`, "utf8").toString("base64url");
}

/** A malformed cursor is a caller bug: throw (surfacing, never a silent page reset). */
export function decodeActivityCursor(cursor: string): ActivityCursor {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(CURSOR_SEPARATOR);
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) {
    throw new Error("Malformed activity cursor");
  }
  return { createdAt: new Date(createdAt), id };
}

/**
 * The Activity page's server-side filters, all optional and AND-composed.
 * Category and visibility resolve through the registry (a SQL WHERE cannot
 * call the registry, so they become `action IN (...)` over the registry's
 * derived action lists). Search matches the stored summary or the action's
 * constant name, which between them carry every projected sentence's text:
 * legacy rows project the stored summary verbatim through the allowlist,
 * payload-v1 rows store a stable code-authored sentence, and technical rows
 * project the generic name derived from the action.
 */
export type ActivityEventFilters = {
  category?: EventCategory;
  actorId?: string;
  /**
   * Explicitly hide registry-technical rows (Tier 2 and unknown actions).
   * Omitted or true: the read returns everything it scopes - hiding
   * technical rows is the page's toggle policy, never this read's default.
   */
  includeTechnical?: boolean;
  /** Case-insensitive substring over the stored summary and the action name. */
  q?: string;
};

/** Escape SQL LIKE wildcards so a hand-typed "%", "_" or "\" matches itself. */
function ilikePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function filterConditions(filters: ActivityEventFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.includeTechnical === false) conditions.push(inArray(auditEvents.action, [...activityVisibleActions()]));
  if (filters.category) conditions.push(inArray(auditEvents.action, [...actionsInCategory(filters.category)]));
  if (filters.actorId) conditions.push(eq(auditEvents.actorId, filters.actorId));
  if (filters.q) {
    const pattern = ilikePattern(filters.q);
    const textMatch = or(ilike(auditEvents.summary, pattern), ilike(auditEvents.action, pattern));
    if (textMatch) conditions.push(textMatch);
  }
  return conditions;
}

export async function listActivityEvents(
  auth: AuthContext,
  { limit = 50, cursor, filters = {} }: { limit?: number; cursor?: string | null; filters?: ActivityEventFilters } = {},
): Promise<ActivityEventPage> {
  const pageSize = Math.min(Math.max(limit, 1), 200);
  const conditions = [
    eq(auditEvents.workspaceId, auth.workspaceId),
    notInArray(auditEvents.subjectType, [...PRIVATE_SUBJECT_TYPES]),
    ...filterConditions(filters),
  ];
  if (cursor) {
    const keyset = decodeActivityCursor(cursor);
    // created_at < cursor, or equal created_at with a smaller id: the rows
    // after the last returned one in (created_at DESC, id DESC) order. The
    // id tiebreak keeps same-timestamp rows from repeating or skipping a
    // row that shares a timestamp with a page boundary.
    const keysetCondition = or(
      lt(auditEvents.createdAt, keyset.createdAt),
      and(eq(auditEvents.createdAt, keyset.createdAt), lt(auditEvents.id, keyset.id)),
    );
    if (keysetCondition) conditions.push(keysetCondition);
  }
  const rows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorId: auditEvents.actorId,
      actorKind: auditEvents.actorKind,
      subjectType: auditEvents.subjectType,
      subjectId: auditEvents.subjectId,
      operationId: auditEvents.operationId,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(pageSize + 1);
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    rows: page.map((row) => ({ ...row, actorKind: row.actorKind })),
    nextCursor: hasMore ? encodeActivityCursor(page[page.length - 1]) : null,
  };
}

/**
 * One visible event by id, for the /activity?event=<id> deep link: a row this
 * viewer cannot see (another workspace, a private thread subject) and a
 * malformed id are both null, so the page renders the same honest
 * not-available note instead of distinguishing them for the URL's author.
 * Keyed reads by primary key; no pagination.
 */
export async function getActivityEvent(auth: AuthContext, id: string): Promise<ActivityEventRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorId: auditEvents.actorId,
      actorKind: auditEvents.actorKind,
      subjectType: auditEvents.subjectType,
      subjectId: auditEvents.subjectId,
      operationId: auditEvents.operationId,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.id, id),
        eq(auditEvents.workspaceId, auth.workspaceId),
        notInArray(auditEvents.subjectType, [...PRIVATE_SUBJECT_TYPES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type ActivityActor = { id: string; label: string };

/**
 * The distinct user actors of the workspace's visible feed, for the Activity
 * page's actor filter: you can filter by anyone who has acted. Names hydrate
 * through the same batched read the presenter uses; an unnamed member stays
 * filterable under a disambiguated fallback label.
 */
export async function listActivityActors(auth: AuthContext): Promise<ActivityActor[]> {
  const rows = await db
    .selectDistinct({ actorId: auditEvents.actorId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, auth.workspaceId),
        eq(auditEvents.actorKind, "user"),
        notInArray(auditEvents.subjectType, [...PRIVATE_SUBJECT_TYPES]),
      ),
    );
  const ids = rows.map((row) => row.actorId).filter((id): id is string => id !== null);
  const names = await getUserDisplayNames(ids);
  return ids
    .map((id) => ({ id, label: names.get(id)?.trim() || `Member ${id.slice(0, 4)}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
