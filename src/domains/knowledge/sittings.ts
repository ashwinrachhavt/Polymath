import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { artifacts, zettelSittingCards, zettelSittings } from "./schema";

/*
 * Sittings (plan 2026-10-29 §2, §14): a timed writing session whose cards
 * join with a role. "Ideas" is the user-facing collection surface and
 * "Sittings" the nav destination; "zettel" stays internal-only (§0, §16).
 *
 * The two creation constants live here as the single named source (§15.1):
 * CREATION_IDLE_MS is the editor-idle debounce that fires Track B (§14.2 -
 * the donor's 350ms felt twitchy for prose; 1.2s reads as intentional);
 * the DECOMPOSE_* pair bounds paste decomposition - at/above PASTE the
 * review opens, above MAX the input is rejected, never truncated (§4's
 * surfaced-omissions invariant).
 */
export const CREATION_IDLE_MS = 1200;
export const DECOMPOSE_PASTE_CHARS = 2000;
export const DECOMPOSE_MAX_CHARS = 20000;

/** Typed sitting errors: a stable code + one human sentence (§15.2 shape). */
export class SittingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SittingError";
  }
}

/** §15.4: a workspace-mismatched artifact is a typed error, never an SSE event. */
export const artifactWorkspaceMismatch = () =>
  new SittingError("ARTIFACT_WORKSPACE_MISMATCH", "That card belongs to another workspace.");

/** §15.8: ended sittings are records; the delete action refuses. */
export const sittingEnded = () => new SittingError("SITTING_ENDED", "Ended sittings are records.");

export const sittingNotFound = () => new SittingError("SITTING_NOT_FOUND", "No such sitting.");

export type SittingRole = "created_here" | "referenced_here" | "revised_here";

export async function createSitting(
  auth: AuthContext,
  input: { topic?: string; tags?: string[]; sourceContext?: string },
) {
  const [sitting] = await db
    .insert(zettelSittings)
    .values({
      workspaceId: auth.workspaceId,
      topic: input.topic ?? null,
      tags: input.tags ?? [],
      sourceContext: input.sourceContext ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return sitting;
}

/** Open sittings first (NULL ends sort first under DESC), then history, newest activity first. */
export async function listSittings(auth: AuthContext) {
  return db
    .select()
    .from(zettelSittings)
    .where(and(eq(zettelSittings.workspaceId, auth.workspaceId), isNull(zettelSittings.archivedAt)))
    .orderBy(desc(zettelSittings.endedAt), desc(zettelSittings.updatedAt));
}

/** A sitting in another workspace answers the same not-found as a missing one. */
export async function getSitting(auth: AuthContext, sittingId: string) {
  const [sitting] = await db
    .select()
    .from(zettelSittings)
    .where(and(eq(zettelSittings.id, sittingId), eq(zettelSittings.workspaceId, auth.workspaceId)))
    .limit(1);
  return sitting ?? null;
}

export async function endSitting(auth: AuthContext, sittingId: string, closingReflection?: string) {
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) throw sittingNotFound();
  if (sitting.endedAt) return sitting; // Ending twice is a no-op, never an error.
  const [ended] = await db
    .update(zettelSittings)
    .set({ endedAt: new Date(), closingReflection: closingReflection ?? null, updatedBy: auth.userId })
    .where(eq(zettelSittings.id, sitting.id))
    .returning();
  return ended;
}

/*
 * §15.8 + plan §2: a member deletes an OPEN sitting; join rows cascade, the
 * artifacts survive, and the deletion is audit-evented. Ended sittings are
 * records and refuse deletion.
 */
export async function deleteSitting(auth: AuthContext, sittingId: string) {
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) throw sittingNotFound();
  if (sitting.endedAt) throw sittingEnded();
  await db.delete(zettelSittings).where(eq(zettelSittings.id, sitting.id));
  await db.insert(auditEvents).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    actorKind: "user",
    action: "sitting.deleted",
    subjectType: "zettel_sitting",
    subjectId: sitting.id,
    summary: `Deleted sitting${sitting.topic ? ` "${sitting.topic}"` : ""}`,
    metadata: { endedAt: sitting.endedAt },
  });
}

/*
 * §15.4: the workspace-consistency check on insert. A foreign-workspace
 * artifact is a typed error thrown before the join exists - never an SSE
 * event. One card holds one role per sitting (UNIQUE(sitting, artifact)).
 */
export async function addCardToSitting(
  auth: AuthContext,
  input: { sittingId: string; artifactId: string; role: SittingRole; position?: number },
) {
  const sitting = await getSitting(auth, input.sittingId);
  if (!sitting) throw sittingNotFound();
  const [card] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  // Existence and tenancy together: a card that exists elsewhere is the same
  // typed mismatch as an explicit cross-workspace reference, so callers never
  // learn which workspace owns an id.
  if (!card) throw artifactWorkspaceMismatch();
  const [row] = await db
    .insert(zettelSittingCards)
    .values({
      workspaceId: auth.workspaceId,
      sittingId: sitting.id,
      artifactId: input.artifactId,
      roleInSitting: input.role,
      position: input.position ?? 0,
    })
    .returning();
  return row;
}

export async function listSittingCards(auth: AuthContext, sittingId: string) {
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) throw sittingNotFound();
  return db
    .select()
    .from(zettelSittingCards)
    .where(eq(zettelSittingCards.sittingId, sitting.id))
    .orderBy(asc(zettelSittingCards.position), asc(zettelSittingCards.createdAt));
}
