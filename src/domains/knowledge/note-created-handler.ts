import type { AuthContext } from "@/domains/identity/resolve";
import { OutboxParkError, type OutboxHandler } from "@/domains/audit/outbox";
import { embedArtifact } from "./embedding";

/*
 * The `note.created` consumer.
 *
 * Without it the topic was released every 60 seconds forever: every task
 * create, subtask and imported issue enqueued a row nothing read. The work is
 * real rather than ceremonial - the note an event names has never been
 * embedded, so it counts as "pending" in search's partial-indexing banner
 * until some unrelated pass picks it up.
 *
 * embedArtifact carries every guard this handler needs, which is why there is
 * nothing here about versions or races: it reads the artifact's CURRENT
 * version, keys its chunks to that version, and joins a pass that already
 * finished for it. A redelivered event for a note edited since costs a lookup,
 * never a stale index or a second metered batch.
 */
export function noteCreatedHandler(
  workspaceOwnerAuth: (workspaceId: string) => Promise<AuthContext | null>,
): OutboxHandler {
  return async (event) => {
    const payload = event.payload as { artifactId?: unknown } | null;
    const artifactId = typeof payload?.artifactId === "string" ? payload.artifactId : null;
    // A row with no artifact id was never written by createNoteInTx and can
    // never succeed; consuming it avoids five pointless attempts.
    if (!artifactId) return;

    const auth = await workspaceOwnerAuth(event.workspaceId);
    if (!auth) throw new Error("workspace has no active owner to embed a note for note.created");

    const outcome = await embedArtifact(auth, { artifactId });
    // Every other outcome is final: not_found and no_text have nothing to
    // index, "edited" lost a race to the commit-path pass, and "failed" is
    // recorded on the artifact where the note's own status shows it. Retrying
    // a refusal only hammers the provider. "busy" is different - another pass
    // holds the artifact lock right now, so the work is still owed.
    if (outcome.status === "skipped" && outcome.reason === "busy") {
      throw new OutboxParkError(5_000, "another embedding pass holds this note");
    }
  };
}

export const NOTE_CREATED_TOPIC = "note.created";
