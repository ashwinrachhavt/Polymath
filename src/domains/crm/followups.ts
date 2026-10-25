import { and, eq, isNull, sql } from "drizzle-orm";
import type { TxDrizzle } from "@/lib/db-transaction";
import { followUps } from "./schema";

/*
 * Follow-up records (ASH-288). A follow-up carries a reason and a date
 * (P-07): the note is the reason in the owner's words, dueAt is when it
 * should come back. Superseding is explicit: a newer follow-up for the same
 * task does not silently replace the open ones - it names them, so the
 * record shows what was planned, then what replaced it.
 */

/** Writes the new follow-up and marks the task's still-open ones superseded by it, in the caller's transaction. */
export async function writeFollowUp(
  tx: TxDrizzle,
  input: {
    workspaceId: string;
    contactId?: string | null;
    taskId?: string | null;
    dueAt: Date;
    /** The reason, in the owner's words. */
    note: string;
    createdBy?: string | null;
  },
): Promise<{ id: string; superseded: number }> {
  const [row] = await tx
    .insert(followUps)
    .values({
      workspaceId: input.workspaceId,
      contactId: input.contactId ?? null,
      taskId: input.taskId ?? null,
      dueAt: input.dueAt,
      note: input.note,
      status: "open",
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
    })
    .returning({ id: followUps.id });

  if (input.taskId) {
    const superseded = await tx
      .update(followUps)
      .set({ supersededBy: row.id, status: "superseded", resolvedAt: new Date(), updatedAt: new Date(), version: sql`${followUps.version} + 1` })
      .where(
        and(
          eq(followUps.workspaceId, input.workspaceId),
          eq(followUps.taskId, input.taskId),
          eq(followUps.status, "open"),
          isNull(followUps.supersededBy),
          isNull(followUps.archivedAt),
          sql`${followUps.id} <> ${row.id}`,
        ),
      )
      .returning({ id: followUps.id });
    return { id: row.id, superseded: superseded.length };
  }
  return { id: row.id, superseded: 0 };
}
