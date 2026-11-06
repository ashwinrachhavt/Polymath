import { asc } from "drizzle-orm";
import { enqueueOutbox } from "@/domains/audit/outbox";
import type { AuthContext } from "@/domains/identity/resolve";
import { workspaces } from "@/domains/identity/tables";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { FACT_SUGGESTION_TOPIC } from "./generate";

/*
 * The scheduler half of the facts refresh. The work is global - the
 * poll_fact_suggestions table has no tenant column - but the outbox is
 * tenant-shaped (workspace_id is not null), so the tick is owned by one
 * workspace: the earliest created. The dispatch key carries the month, so
 * every cron pass in a month enqueues nothing after the first, and the
 * handler's own uniqueness makes even an owner change across months safe.
 *
 * One row per month, not one per workspace: the pass writes one shared deck,
 * and N workspaces would mean N identical model calls into the same table.
 */

function monthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function scheduleMonthlyFactRefresh(now: Date = new Date()): Promise<{ enqueued: boolean }> {
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  if (!workspace) return { enqueued: false };
  const result = await withTransaction((tx) =>
    enqueueOutbox(tx, { workspaceId: workspace.id } as Pick<AuthContext, "workspaceId">, {
      topic: FACT_SUGGESTION_TOPIC,
      payload: { month: monthKey(now) },
      dispatchKey: `facts-refresh-${monthKey(now)}`,
    }),
  );
  return { enqueued: result.enqueued };
}
