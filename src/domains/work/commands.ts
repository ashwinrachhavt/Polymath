import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { tasks } from "./schema";

/*
 * The work domain's mutation surface. Minimal by design: callers outside the
 * domain (e.g. knowledge accepting an obligation) go through here so task
 * invariants live in one place.
 */

type Db = typeof db | TxDrizzle;

/** Minimal insert with defaults (status "inbox", priority "none"). Returns the row. */
export async function createTask(
  auth: AuthContext,
  input: { title: string; description?: string; dueAt?: Date; rank?: string },
  tx: Db = db,
) {
  const [task] = await tx
    .insert(tasks)
    .values({
      workspaceId: auth.workspaceId,
      title: input.title,
      description: input.description ?? null,
      dueAt: input.dueAt ?? null,
      rank: input.rank ?? "m",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return task;
}
