import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { artifactLinks, artifactVersions, artifacts, zettelSittingCards, zettelSittings } from "./schema";
import { CREATION_IDLE_MS, DECOMPOSE_MAX_CHARS, DECOMPOSE_PASTE_CHARS } from "./sitting-events";

/*
 * Sittings (plan 2026-10-29 §2, §14; Gate 2026-10-29): a writing context
 * whose cards join with a role. There is no lifecycle: no end action, no
 * ended_at writes, no open/closed states - the workspace is always there,
 * revisitable and writable at any time. "Ideas" is the user-facing
 * collection surface and "Sittings" the nav destination; "zettel" stays
 * internal-only (§0, §16).
 *
 * The §15.1 creation constants live in sitting-events.ts (the dependency-free
 * module client components can import) and are re-exported here for server
 * call sites.
 */
export { CREATION_IDLE_MS, DECOMPOSE_MAX_CHARS, DECOMPOSE_PASTE_CHARS };

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

/* The sittings list is plain history (Gate 2026-10-29: no lifecycle) - newest activity first. */
export async function listSittings(auth: AuthContext) {
  return db
    .select()
    .from(zettelSittings)
    .where(and(eq(zettelSittings.workspaceId, auth.workspaceId), isNull(zettelSittings.archivedAt)))
    .orderBy(desc(zettelSittings.updatedAt));
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

/*
 * Plan §2: a member deletes a sitting; join rows cascade, the artifacts
 * survive, and the deletion is audit-evented. There is no lifecycle (Gate
 * 2026-10-29): nothing distinguishes a deletable sitting from a record.
 */
export async function deleteSitting(auth: AuthContext, sittingId: string) {
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) throw sittingNotFound();
  await db.delete(zettelSittings).where(eq(zettelSittings.id, sitting.id));
  await recordAudit(auth, {
    action: "sitting.deleted",
    subjectType: "zettel_sitting",
    subjectId: sitting.id,
    summary: `Deleted sitting${sitting.topic ? ` "${sitting.topic}"` : ""}`,
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

/*
 * The sitting's working card for reopen hydration (§7): the first
 * created_here card joined to its CURRENT version, so a reopened surface can
 * bind saves to the right artifact/version and reconcile the draft instead
 * of starting blank and creating a duplicate card.
 */
export async function getSittingWritingCard(auth: AuthContext, sittingId: string) {
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) throw sittingNotFound();
  const [row] = await db
    .select({
      artifactId: zettelSittingCards.artifactId,
      versionNumber: artifactVersions.versionNumber,
      plainText: artifactVersions.plainText,
      content: artifactVersions.content,
      updatedAt: artifacts.updatedAt,
    })
    .from(zettelSittingCards)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, zettelSittingCards.artifactId),
        eq(artifacts.workspaceId, auth.workspaceId),
        isNull(artifacts.archivedAt),
      ),
    )
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(zettelSittingCards.sittingId, sitting.id), eq(zettelSittingCards.roleInSitting, "created_here")))
    .orderBy(asc(zettelSittingCards.position), asc(zettelSittingCards.createdAt))
    .limit(1);
  return row ?? null;
}

/*
 * §14.9 suggested links, per sitting: the semantic edges Track B proposed on
 * the sitting's cards. Accept promotes to an explicit "related" edge and
 * dismiss flips the edge to "dismissed" - the canonical store (relations.ts),
 * which re-embeds honor, so rejected suggestions never reappear (§11). This
 * is the repo's existing store, used instead of a second
 * metadata.dismissedCandidates list: one store, no read-modify-write mirror.
 */
export async function listSittingSuggestedLinks(
  auth: AuthContext,
  sittingId: string,
): Promise<{ artifactId: string; artifactTitle: string; targetId: string; targetTitle: string | null; score: number | null }[]> {
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) throw sittingNotFound();
  return db
    .select({
      artifactId: artifactLinks.artifactId,
      artifactTitle: artifacts.title,
      targetId: artifactLinks.targetId,
      targetTitle: artifactLinks.label,
      score: artifactLinks.score,
    })
    .from(artifactLinks)
    .innerJoin(zettelSittingCards, eq(zettelSittingCards.artifactId, artifactLinks.artifactId))
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .where(and(eq(zettelSittingCards.sittingId, sitting.id), eq(artifactLinks.workspaceId, auth.workspaceId), eq(artifactLinks.linkType, "semantic")))
    .orderBy(desc(artifactLinks.score));
}
