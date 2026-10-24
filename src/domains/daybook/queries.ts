import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifacts } from "../knowledge/schema";
import { dayArtifactPins } from "./schema";
import { DAYBOOK_ACTIONS, DAYBOOK_ACTION_LIST } from "./action-registry";

/*
 * The day page's reads. Every section derives from canonical records at read
 * time (eng review D7/D8): the day is a local date plus the owner's timezone,
 * both resolved here — the same read-time derivation briefing.ts uses for
 * "today". No day row exists to freeze anything to.
 *
 * Ceiling: worked-on depends on audit_events staying unpruned. If a retention
 * job ever lands on audit, day history truncates with it — revisit then.
 */

export type DayItem = {
  id: string;
  kind: string;
  title: string;
  at: Date | null;
};

export type DayPage = {
  localDate: string;
  timezone: string;
  created: DayItem[];
  workedOn: DayItem[];
  captured: DayItem[];
  planned: Array<{ id: string; title: string; rank: string; completedAt: Date | null }>;
  sessions: Array<{ id: string; subject: string | null; startedAt: Date; endedAt: Date | null; minutes: number }>;
  meetings: DayItem[];
  pins: Array<{
    id: string;
    artifactId: string;
    title: string;
    artifactKind: string;
    pinnedVersionId: string | null;
    pinnedVersionNumber: number | null;
    archived: boolean;
    position: number;
  }>;
};

export async function getDayPage(auth: AuthContext, localDate: string): Promise<DayPage> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error(`Invalid local date: ${localDate}`);
  }

  // One round trip: bounds derive from the owner's read-time timezone (the
  // same source briefing.ts uses), then every section filters inside them.
  const result = await db.execute(sql`
    with ws as (
      select coalesce(
        (select timezone from user_preferences
          where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}),
        'UTC'
      ) as tz
    ),
    bounds as (
      select
        (${localDate}::text)::timestamp at time zone (select tz from ws) as day_start,
        (((${localDate}::text)::timestamp + interval '1 day')) at time zone (select tz from ws) as day_end,
        (select tz from ws) as tz
    )
    select
      (select tz from bounds) as timezone,
      coalesce(created.items, '[]'::json) as created,
      coalesce(worked.items, '[]'::json) as worked_on,
      coalesce(captured.items, '[]'::json) as captured,
      coalesce(planned.items, '[]'::json) as planned,
      coalesce(sessions.items, '[]'::json) as sessions,
      coalesce(meetings.items, '[]'::json) as meetings
    from bounds
    left join lateral (
      select json_agg(json_build_object(
        'id', a.id, 'kind', a.kind, 'title', a.title, 'at', a.created_at
      ) order by a.created_at desc) as items
      from artifacts a
      where a.workspace_id = ${auth.workspaceId}
        and a.created_at >= (select day_start from bounds)
        and a.created_at < (select day_end from bounds)
        and a.archived_at is null
      limit 50
    ) created on true
    left join lateral (
      select json_agg(json_build_object(
        'id', ev.subject_id, 'kind', ev.subject_type, 'title', ev.summary, 'at', ev.created_at
      ) order by ev.created_at desc) as items
      from audit_events ev
      where ev.workspace_id = ${auth.workspaceId}
        and ev.actor_kind = 'user'
        and ev.action in ${DAYBOOK_ACTION_LIST}
        and ev.created_at >= (select day_start from bounds)
        and ev.created_at < (select day_end from bounds)
      limit 50
    ) worked on true
    left join lateral (
      select json_agg(json_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.text, 'at', c.created_at
      ) order by c.created_at desc) as items
      from captures c
      where c.workspace_id = ${auth.workspaceId}
        and c.created_at >= (select day_start from bounds)
        and c.created_at < (select day_end from bounds)
        and c.processing_state <> 'discarded'
      limit 50
    ) captured on true
    left join lateral (
      select json_agg(json_build_object(
        'id', o.id, 'title', o.title, 'rank', o.rank, 'completed_at', o.completed_at
      ) order by o.rank collate "C" asc) as items
      from daily_outcomes o
      where o.workspace_id = ${auth.workspaceId}
        and o.on_date = ${localDate}::date
    ) planned on true
    left join lateral (
      select json_agg(json_build_object(
        'id', fs.id, 'subject', fs.subject, 'started_at', fs.started_at, 'ended_at', fs.ended_at,
        'minutes', floor(coalesce(fs.accumulated_seconds, 0) / 60.0)
      ) order by fs.started_at asc) as items
      from focus_sessions fs
      where fs.workspace_id = ${auth.workspaceId}
        and fs.started_at < (select day_end from bounds)
        and coalesce(fs.ended_at, now()) >= (select day_start from bounds)
    ) sessions on true
    left join lateral (
      select json_agg(json_build_object(
        'id', e.id, 'kind', 'event', 'title', e.title, 'at', e.starts_at
      ) order by e.starts_at asc) as items
      from events e
      where e.workspace_id = ${auth.workspaceId}
        and e.starts_at >= (select day_start from bounds)
        and e.starts_at < (select day_end from bounds)
        and e.status <> 'cancelled'
    ) meetings on true
  `);

  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) {
    return {
      localDate,
      timezone: "UTC",
      created: [],
      workedOn: [],
      captured: [],
      planned: [],
      sessions: [],
      meetings: [],
      pins: [],
    };
  }

  const pins = await db
    .select({
      id: dayArtifactPins.id,
      artifactId: dayArtifactPins.artifactId,
      pinnedVersionId: dayArtifactPins.pinnedVersionId,
      position: dayArtifactPins.position,
      title: artifacts.title,
      artifactKind: artifacts.kind,
      archived: sql<boolean>`${artifacts.archivedAt} is not null`,
      pinnedVersionNumber: sql<number | null>`(
        select v.version_number from artifact_versions v where v.id = ${dayArtifactPins.pinnedVersionId}
      )`,
    })
    .from(dayArtifactPins)
    .innerJoin(artifacts, eq(artifacts.id, dayArtifactPins.artifactId))
    .where(
      and(
        eq(dayArtifactPins.workspaceId, auth.workspaceId),
        eq(dayArtifactPins.userId, auth.userId),
        eq(dayArtifactPins.localDate, localDate),
      ),
    )
    .orderBy(dayArtifactPins.position);

  const asItems = (value: unknown): DayItem[] =>
    Array.isArray(value)
      ? (value as Array<Record<string, unknown>>).map((r) => ({
          id: r.id as string,
          kind: (r.kind as string) ?? "",
          title: (r.title as string) ?? "",
          at: r.at ? new Date(r.at as string) : null,
        }))
      : [];

  return {
    localDate,
    timezone: row.timezone as string,
    created: asItems(row.created),
    workedOn: asItems(row.worked_on),
    captured: asItems(row.captured),
    planned: Array.isArray(row.planned)
      ? (row.planned as Array<Record<string, unknown>>).map((r) => ({
          id: r.id as string,
          title: r.title as string,
          rank: r.rank as string,
          completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
        }))
      : [],
    sessions: Array.isArray(row.sessions)
      ? (row.sessions as Array<Record<string, unknown>>).map((r) => ({
          id: r.id as string,
          subject: (r.subject as string) ?? null,
          startedAt: new Date(r.started_at as string),
          endedAt: r.ended_at ? new Date(r.ended_at as string) : null,
          minutes: (r.minutes as number) ?? 0,
        }))
      : [],
    meetings: asItems(row.meetings),
    pins,
  };
}

export { DAYBOOK_ACTIONS, DAYBOOK_ACTION_LIST };
