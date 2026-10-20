import { and, asc, eq, gt, isNull, lt, ne } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { eventLinks, events } from "./schema";

export type WeekEvent = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  version: number;
  taskId: string | null;
};

/** Live events overlapping [from, to), each with the task it blocks time for. */
export async function listEventsBetween(
  auth: Pick<AuthContext, "workspaceId">,
  from: Date,
  to: Date,
): Promise<WeekEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      version: events.version,
      taskId: eventLinks.targetId,
    })
    .from(events)
    .leftJoin(
      eventLinks,
      and(eq(eventLinks.eventId, events.id), eq(eventLinks.targetType, "task")),
    )
    .where(
      and(
        eq(events.workspaceId, auth.workspaceId),
        isNull(events.archivedAt),
        ne(events.status, "cancelled"),
        lt(events.startsAt, to),
        gt(events.endsAt, from),
      ),
    )
    .orderBy(asc(events.startsAt));
  return rows;
}
