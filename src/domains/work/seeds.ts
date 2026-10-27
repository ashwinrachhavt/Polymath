import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { recordAudit } from "@/domains/audit/record";
import { briefingSeeds, tasks } from "./schema";
import { artifacts } from "@/domains/knowledge/schema";

/*
 * Tomorrow's suggestions, as written by the end-of-day shutdown.
 *
 * The shutdown ritual picks open tasks to lead the next day and records them
 * here. A seed is not a commitment - the owner still commits it - so this read
 * exists to put the suggestion back in front of them, with the reason it was
 * suggested and one action that turns it into today's work.
 *
 * A seed is dismissed by archiving its row, never by deleting it: the unique
 * key on (day, task) then holds, so a replayed shutdown cannot resurrect a
 * suggestion the owner already rejected.
 */

export type SeedRow = {
  seedId: string;
  taskId: string;
  title: string;
  reason: string | null;
  version: number;
  /** The task's own version, which a commit must bind. */
  taskVersion: number;
};

/**
 * Live seeds for one workspace-local day. A seed whose task has since been
 * archived, finished or cancelled is not offered: the suggestion has been
 * overtaken by events, and showing it would ask the owner to commit work that
 * no longer exists as work.
 */
export async function listSeedsForDay(
  auth: Pick<AuthContext, "workspaceId">,
  onDate: string,
): Promise<SeedRow[]> {
  const rows = await db
    .select({
      seedId: briefingSeeds.id,
      seedVersion: briefingSeeds.version,
      taskId: tasks.id,
      // The title is the note's (0260 drops `tasks.title`), joined on id and
      // workspace so a foreign note id can never leak a title.
      title: artifacts.title,
      reason: briefingSeeds.reason,
      taskVersion: tasks.version,
    })
    .from(briefingSeeds)
    .innerJoin(tasks, eq(tasks.id, briefingSeeds.taskId))
    .innerJoin(artifacts, and(eq(artifacts.id, tasks.noteId), eq(artifacts.workspaceId, tasks.workspaceId)))
    .where(
      and(
        eq(briefingSeeds.workspaceId, auth.workspaceId),
        eq(briefingSeeds.onDate, onDate),
        isNull(briefingSeeds.archivedAt),
        isNull(tasks.archivedAt),
        notInArray(tasks.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(asc(briefingSeeds.createdAt), asc(briefingSeeds.id));
  return rows.map((row) => ({
    seedId: row.seedId,
    taskId: row.taskId,
    title: row.title,
    reason: row.reason,
    version: row.seedVersion,
    taskVersion: row.taskVersion,
  }));
}

/**
 * Dismiss one suggestion. Archiving (not deleting) keeps the unique key, so a
 * replay of the same shutdown cannot bring it back later that day.
 */
export async function dismissSeed(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: { seedId: string; expectedVersion: number },
): Promise<{ id: string; version: number } | null> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(briefingSeeds)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${briefingSeeds.version} + 1`,
      })
      .where(
        and(
          eq(briefingSeeds.id, input.seedId),
          eq(briefingSeeds.workspaceId, auth.workspaceId),
          eq(briefingSeeds.version, input.expectedVersion),
          isNull(briefingSeeds.archivedAt),
        ),
      )
      .returning({ id: briefingSeeds.id, version: briefingSeeds.version, taskId: briefingSeeds.taskId });
    if (!row) return null;
    await recordAudit(
      auth as AuthContext,
      {
        action: "briefing_seed.dismissed",
        subjectType: "task",
        subjectId: row.taskId,
        summary: "Dismissed a suggestion for today",
        metadata: { seedId: row.id },
      },
      tx,
    );
    return { id: row.id, version: row.version };
  });
}

/**
 * Commit a suggested task to today. A committed seed has done its job, so it
 * is archived in the same call: the suggestion has been answered, and leaving
 * it live would offer the owner work they already took.
 */
export async function markSeedCommitted(
  auth: AuthContext,
  seedId: string,
): Promise<void> {
  const [row] = await db
    .update(briefingSeeds)
    .set({
      archivedAt: new Date(),
      updatedAt: new Date(),
      updatedBy: auth.userId,
      version: sql`${briefingSeeds.version} + 1`,
    })
    .where(
      and(
        eq(briefingSeeds.id, seedId),
        eq(briefingSeeds.workspaceId, auth.workspaceId),
        isNull(briefingSeeds.archivedAt),
      ),
    )
    .returning({ id: briefingSeeds.id, taskId: briefingSeeds.taskId });
  if (!row) return;
  await recordAudit(
    auth,
    {
      action: "briefing_seed.committed",
      subjectType: "task",
      subjectId: row.taskId,
      summary: "Committed a suggested task to today",
      metadata: { seedId: row.id },
    },
  );
}
