import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { artifactVersions, artifacts, recoveryCopies, workingDrafts } from "./schema";

/*
 * The notes core (ASH-138 / B04): user-written rich notes on the artifact
 * tables that already exist for generated work, so a note and a generated
 * report are the same kind of thing with a different author.
 *
 * The model: the artifact row is the mutable pointer (title, current version,
 * optimistic-concurrency `version`); versions are immutable and append-only
 * ("what did it say when" is always answerable); the working draft is the
 * autosaved not-yet-committed state; recovery copies are the crash net.
 *
 * Every command is one transaction: auth context -> idempotency receipt ->
 * compare-and-set on the artifact version -> change -> audit + outbox. The
 * caller supplies a UUID per user intent; a replay returns the stored result.
 */

export class NoteNotFoundError extends Error {
  readonly code = "note_not_found";
  constructor() {
    super("That note does not exist in this workspace.");
  }
}
export class VersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor() {
    super("This note changed since you loaded it. Reload and try again.");
  }
}

/** Tiptap/ProseMirror document JSON, or a structured payload. */
export type NoteContent = Record<string, unknown>;

type Keyed = { idempotencyKey?: string };

async function emit(tx: TxDrizzle, auth: AuthContext, topic: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic, payload });
}

/** CAS-bump the artifact's version, or throw the reason the edit cannot land. */
async function claimVersion(tx: TxDrizzle, auth: AuthContext, artifactId: string, expectedVersion: number) {
  const [row] = await tx
    .update(artifacts)
    .set({ updatedAt: new Date(), updatedBy: auth.userId, version: sql`${artifacts.version} + 1` })
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, auth.workspaceId),
        eq(artifacts.version, expectedVersion),
        isNull(artifacts.archivedAt),
      ),
    )
    .returning({ id: artifacts.id, version: artifacts.version, title: artifacts.title, currentVersionId: artifacts.currentVersionId });
  if (row) return row;
  const [exists] = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)))
    .limit(1);
  throw exists ? new VersionConflictError() : new NoteNotFoundError();
}

export async function createNote(
  auth: AuthContext,
  input: Keyed & { title: string; content?: NoteContent; plainText?: string },
): Promise<{ id: string; versionId: string; version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "createNote", ...input }, async () => {
      const [artifact] = await tx
        .insert(artifacts)
        .values({ workspaceId: auth.workspaceId, kind: "note", title: input.title, createdBy: auth.userId, updatedBy: auth.userId })
        .returning({ id: artifacts.id, version: artifacts.version });
      const empty = { type: "doc", content: [] };
      const [version] = await tx
        .insert(artifactVersions)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: artifact.id,
          versionNumber: 1,
          content: input.content ?? empty,
          plainText: input.plainText ?? null,
          reason: "created",
          createdBy: auth.userId,
        })
        .returning({ id: artifactVersions.id });
      await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
      await recordAudit(
        auth,
        { action: "note.created", subjectType: "artifact", subjectId: artifact.id, summary: `Created note "${input.title}"`, metadata: { versionId: version.id } },
        tx,
      );
      await emit(tx, auth, "note.created", { artifactId: artifact.id, versionId: version.id });
      return { id: artifact.id, versionId: version.id, version: artifact.version };
    });
    return value;
  });
}

/*
 * The autosave: debounced client writes land here. The draft is not a new
 * version (a note with 400 versions from one sitting is noise); it replaces
 * the working draft under a version guard so two tabs cannot silently
 * overwrite each other, and leaves a recovery copy every few minutes.
 */
export async function autosaveNoteDraft(
  auth: AuthContext,
  input: Keyed & { artifactId: string; expectedVersion: number; content: NoteContent; plainText?: string },
): Promise<{ version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "autosaveNoteDraft", ...input }, async () => {
      const artifact = await claimVersion(tx, auth, input.artifactId, input.expectedVersion);
      await tx
        .insert(workingDrafts)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: artifact.id,
          content: input.content,
          baseVersionId: artifact.currentVersionId,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoUpdate({
          target: workingDrafts.artifactId,
          set: { content: input.content, baseVersionId: artifact.currentVersionId, updatedAt: new Date(), updatedBy: auth.userId },
        });
      const [latestCopy] = await tx
        .select({ createdAt: recoveryCopies.createdAt })
        .from(recoveryCopies)
        .where(and(eq(recoveryCopies.artifactId, artifact.id), eq(recoveryCopies.workspaceId, auth.workspaceId)))
        .orderBy(desc(recoveryCopies.createdAt))
        .limit(1);
      if (!latestCopy || Date.now() - latestCopy.createdAt.getTime() > 5 * 60 * 1000) {
        await tx.insert(recoveryCopies).values({ workspaceId: auth.workspaceId, artifactId: artifact.id, content: input.content });
      }
      await emit(tx, auth, "note.autosaved", { artifactId: artifact.id, version: artifact.version });
      return { version: artifact.version };
    });
    return value;
  });
}

/*
 * Committing a draft is what makes a version: the immutable snapshot is
 * appended, the pointer moves to it, and the draft is cleared - all under the
 * same version guard, so a commit cannot land on top of an unseen autosave
 * from another tab.
 */
export async function commitNoteSnapshot(
  auth: AuthContext,
  input: Keyed & {
    artifactId: string;
    expectedVersion: number;
    content: NoteContent;
    plainText?: string;
    note?: string;
  },
): Promise<{ versionId: string; versionNumber: number; version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "commitNoteSnapshot", ...input }, async () => {
      const artifact = await claimVersion(tx, auth, input.artifactId, input.expectedVersion);
      const [max] = await tx
        .select({ n: sql<number>`coalesce(max(${artifactVersions.versionNumber}), 0)` })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifact.id));
      const [snapshot] = await tx
        .insert(artifactVersions)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: artifact.id,
          versionNumber: max.n + 1,
          content: input.content,
          plainText: input.plainText ?? null,
          reason: "edited",
          note: input.note ?? null,
          createdBy: auth.userId,
        })
        .returning({ id: artifactVersions.id, versionNumber: artifactVersions.versionNumber });
      await tx.update(artifacts).set({ currentVersionId: snapshot.id }).where(eq(artifacts.id, artifact.id));
      await tx.delete(workingDrafts).where(and(eq(workingDrafts.artifactId, artifact.id), eq(workingDrafts.workspaceId, auth.workspaceId)));
      await recordAudit(
        auth,
        {
          action: "note.snapshot",
          subjectType: "artifact",
          subjectId: artifact.id,
          summary: `Saved version ${snapshot.versionNumber} of "${artifact.title}"`,
          metadata: { versionId: snapshot.id, versionNumber: snapshot.versionNumber },
        },
        tx,
      );
      await emit(tx, auth, "note.snapshot", { artifactId: artifact.id, versionId: snapshot.id, versionNumber: snapshot.versionNumber });
      return { versionId: snapshot.id, versionNumber: snapshot.versionNumber, version: artifact.version };
    });
    return value;
  });
}

export async function renameNote(
  auth: AuthContext,
  input: Keyed & { artifactId: string; expectedVersion: number; title: string },
): Promise<{ version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "renameNote", ...input }, async () => {
      const artifact = await claimVersion(tx, auth, input.artifactId, input.expectedVersion);
      await tx.update(artifacts).set({ title: input.title }).where(eq(artifacts.id, artifact.id));
      await recordAudit(
        auth,
        { action: "note.renamed", subjectType: "artifact", subjectId: artifact.id, summary: `Renamed note to "${input.title}"`, metadata: {} },
        tx,
      );
      await emit(tx, auth, "note.renamed", { artifactId: artifact.id });
      return { version: artifact.version };
    });
    return value;
  });
}

export type NoteListItem = {
  id: string;
  title: string;
  status: string;
  version: number;
  updatedAt: Date;
  excerpt: string | null;
  hasDraft: boolean;
};

export async function listNotes(auth: AuthContext, limit = 50): Promise<NoteListItem[]> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        status: artifacts.status,
        version: artifacts.version,
        updatedAt: artifacts.updatedAt,
        excerpt: artifactVersions.plainText,
        draftArtifactId: workingDrafts.artifactId,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .leftJoin(workingDrafts, eq(workingDrafts.artifactId, artifacts.id))
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note"), isNull(artifacts.archivedAt)))
      .orderBy(desc(artifacts.updatedAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, hasDraft: row.draftArtifactId !== null, draftArtifactId: undefined }) as unknown as NoteListItem);
  });
}

export type NoteDetail = {
  id: string;
  title: string;
  status: string;
  version: number;
  currentVersionId: string | null;
  content: NoteContent | null;
  draft: { content: NoteContent; baseVersionId: string | null; updatedAt: Date } | null;
};

export async function getNote(auth: AuthContext, artifactId: string): Promise<NoteDetail | null> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        status: artifacts.status,
        version: artifacts.version,
        currentVersionId: artifacts.currentVersionId,
        content: artifactVersions.content,
        draftContent: workingDrafts.content,
        draftBaseVersionId: workingDrafts.baseVersionId,
        draftUpdatedAt: workingDrafts.updatedAt,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .leftJoin(workingDrafts, eq(workingDrafts.artifactId, artifacts.id))
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      version: row.version,
      currentVersionId: row.currentVersionId,
      content: (row.content as NoteContent | null) ?? null,
      draft: row.draftContent ? { content: row.draftContent as NoteContent, baseVersionId: row.draftBaseVersionId, updatedAt: row.draftUpdatedAt! } : null,
    };
  });
}

/*
 * Draft recovery: after a crash the editor asks here. The working draft wins
 * (it is newer by definition); the latest recovery copy is the fallback when
 * the draft row itself was lost.
 */
export async function recoverNoteDraft(
  auth: AuthContext,
  artifactId: string,
): Promise<{ content: NoteContent; source: "draft" | "recovery"; baseVersionId: string | null } | null> {
  return withTransaction(async (tx) => {
    const [draft] = await tx
      .select({ content: workingDrafts.content, baseVersionId: workingDrafts.baseVersionId })
      .from(workingDrafts)
      .where(and(eq(workingDrafts.artifactId, artifactId), eq(workingDrafts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (draft) return { content: draft.content as NoteContent, source: "draft", baseVersionId: draft.baseVersionId };
    const [copy] = await tx
      .select({ content: recoveryCopies.content })
      .from(recoveryCopies)
      .where(and(eq(recoveryCopies.artifactId, artifactId), eq(recoveryCopies.workspaceId, auth.workspaceId)))
      .orderBy(desc(recoveryCopies.createdAt))
      .limit(1);
    if (!copy) return null;
    return { content: copy.content as NoteContent, source: "recovery", baseVersionId: null };
  });
}
