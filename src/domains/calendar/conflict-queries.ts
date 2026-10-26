import { and, asc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { userPreferences } from "@/domains/identity/schema";
import { externalAccounts, syncCursors } from "@/domains/integrations/schema";
import { db } from "@/lib/db";
import type { ConflictEvent } from "./conflicts";
import { eventAttendees, eventLinks, events, schedulerPreferences } from "./schema";
import { resolveZone } from "./zoned";

/*
 * What the conflict check reads (ASH-282): the owner's live events in a
 * window, the scheduler's working hours, the owner's timezone, and how fresh
 * the synced Google data is. Google is read by the existing sync (Composio,
 * read-only); this module reads the local store that sync fills, so a stale
 * sync is reported rather than hidden.
 */

export type ProviderFreshness = {
  alias: string;
  status: string;
  lastSyncedAt: Date | null;
};

export type ConflictWindow = {
  events: ConflictEvent[];
  /** A valid IANA zone: the owner's, or UTC when none is saved or it is unknown. */
  timezone: string;
  earliestMinute: number;
  latestMinute: number;
  bufferMinutes: number;
  providers: ProviderFreshness[];
};

export async function loadConflictWindow(
  auth: { workspaceId: string; userId: string },
  from: Date,
  to: Date,
): Promise<ConflictWindow> {
  const [rows, [prefs], [owner], providers] = await Promise.all([
    db
      .select({
        id: events.id,
        title: events.title,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        version: events.version,
        status: events.status,
        externalAccountId: events.externalAccountId,
        // Qualified by hand: drizzle drops the table prefix from a single-table
        // select, and a bare "id" would bind to the subquery's own table.
        taskId: sql<string | null>`(select l.target_id from ${eventLinks} l where l.event_id = events.id and l.target_type = 'task' limit 1)`,
        attendeeCount: sql<number>`(select count(*)::int from ${eventAttendees} a where a.event_id = events.id)`,
      })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, auth.workspaceId),
          isNull(events.archivedAt),
          ne(events.status, "cancelled"),
          eq(events.allDay, false),
          lt(events.startsAt, to),
          gt(events.endsAt, from),
        ),
      )
      .orderBy(asc(events.startsAt)),
    db.select().from(schedulerPreferences).where(eq(schedulerPreferences.workspaceId, auth.workspaceId)).limit(1),
    db
      .select({ timezone: userPreferences.timezone })
      .from(userPreferences)
      .where(and(eq(userPreferences.workspaceId, auth.workspaceId), eq(userPreferences.userId, auth.userId)))
      .limit(1),
    db
      .select({ alias: externalAccounts.alias, status: externalAccounts.status, lastSyncedAt: syncCursors.lastSyncedAt })
      .from(externalAccounts)
      .leftJoin(
        syncCursors,
        and(eq(syncCursors.externalAccountId, externalAccounts.id), eq(syncCursors.resource, "events")),
      )
      .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.provider, "google-calendar"))),
  ]);

  const timezone = resolveZone(owner?.timezone ?? "UTC");
  return {
    events: rows.map((r) => ({
      id: r.id,
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      version: r.version,
      taskId: r.taskId,
      external: r.externalAccountId !== null,
      tentative: r.status === "tentative",
      attendeeCount: r.attendeeCount,
    })),
    timezone,
    earliestMinute: prefs?.earliestMinute ?? 9 * 60,
    latestMinute: prefs?.latestMinute ?? 18 * 60,
    bufferMinutes: prefs?.bufferMinutes ?? 10,
    providers,
  };
}
