/**
 * The completion observation enqueue: a sessionless, dependency-light entry
 * point for the eve turn hook.
 *
 * The hook that sees a turn end lives in the eve bundle and already imports
 * the agents event bridge. Importing the whole superagent composition there
 * would drag the engine, the assessor and the executor into that bundle for
 * one insert, so this module imports only the database handle and the effects
 * table. The `observe` consumer itself registers with the drain in the app
 * process (superagentEffectHandlers), which is where the work belongs.
 */
import { db } from "@/lib/db";
import { workEffects } from "./schema";

/**
 * Queue one completion observation for a workspace. Coalesced on the
 * workspace key while pending, so a burst of finished turns shares a single
 * look and a replayed hook inserts nothing.
 */
export async function enqueueCompletionObservation(workspaceId: string): Promise<void> {
  await db
    .insert(workEffects)
    .values({ workspaceId, kind: "observe", key: workspaceId, payload: { workspaceId } })
    .onConflictDoNothing();
}
