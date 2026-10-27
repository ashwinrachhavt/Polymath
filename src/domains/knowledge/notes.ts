import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { escapeLike } from "@/lib/list-params";
import { ARTIFACT_EMBEDDING_OWNER_TYPE, embedArtifact, safeArtifactEmbedError, type ArtifactEmbedOutcome } from "./embedding";
import { artifactLinks, artifactVersions, artifacts, embeddings, recoveryCopies, workingDrafts } from "./schema";
import type { DraftTemplate } from "./templates";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";

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

/*
 * Wiki links (ASH-142 / D11): `[[Title]]` inside the markdown body resolves
 * against this workspace's notes by title, case-insensitively, mirroring the
 * preview's semantics — a title matching nothing stays in the text as written
 * and creates no edge, and a note never links to itself. Edges are
 * artifact_links rows; backlinks are the reverse read of the same row, so
 * there is one graph, not two stores.
 *
 * ASH-174: a note and a zettel are the same kind of thing in the graph, so a
 * title resolves against both kinds and the edge records which it found
 * (targetType "note" or "zettel"). Both are read back by the same
 * backlinks/outlinks queries.
 */
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

/** The artifact kinds a wiki link may resolve to (one graph over both). */
export const LINKABLE_KINDS = ["note", "zettel"] as const;

/** Kinds a note command may create: the two linkable kinds, and a transcript (a conversation projected into the graph). */
/*
 * The projections (thread-graph, document-graph) create their mirrors through
 * the same versioned container, so the mirror kinds join the union: a
 * "transcript" mirror of a conversation, a "document" mirror of a captured
 * source. Neither becomes a [[linkable]] card - LINKABLE_KINDS is unchanged.
 */
export type NoteKind = (typeof LINKABLE_KINDS)[number] | "transcript" | "document";

export function extractWikiLinkTitles(markdown: string): string[] {
  const titles = new Set<string>();
  for (const match of markdown.matchAll(WIKI_LINK)) {
    const title = match[1].trim();
    if (title) titles.add(title);
  }
  return [...titles];
}

function markdownOf(content: NoteContent, plainText?: string): string {
  if (typeof plainText === "string") return plainText;
  return typeof content.text === "string" ? content.text : "";
}

/** Reconcile this note's outgoing wiki edges with the body just saved. */
export async function syncNoteLinks(tx: TxDrizzle, auth: AuthContext, artifactId: string, markdown: string) {
  const titles = extractWikiLinkTitles(markdown);
  const candidates = titles.length
    ? await tx
        .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind })
        .from(artifacts)
        .where(and(eq(artifacts.workspaceId, auth.workspaceId), inArray(artifacts.kind, [...LINKABLE_KINDS]), isNull(artifacts.archivedAt)))
    : [];
  const byTitle = new Map(candidates.map((c) => [c.title.toLowerCase(), { id: c.id, kind: c.kind }]));
  const wanted = new Map<string, { label: string; kind: (typeof LINKABLE_KINDS)[number] }>();
  for (const title of titles) {
    const hit = byTitle.get(title.toLowerCase());
    if (hit && hit.id !== artifactId && !wanted.has(hit.id)) wanted.set(hit.id, { label: title, kind: hit.kind as (typeof LINKABLE_KINDS)[number] });
  }
  const existing = await tx
    .select({ id: artifactLinks.id, targetId: artifactLinks.targetId })
    .from(artifactLinks)
    .where(and(
      eq(artifactLinks.workspaceId, auth.workspaceId),
      eq(artifactLinks.artifactId, artifactId),
      inArray(artifactLinks.targetType, [...LINKABLE_KINDS]),
      eq(artifactLinks.linkType, "reference"),
    ));
  const stale = existing.filter((row) => !wanted.has(row.targetId)).map((row) => row.id);
  if (stale.length) await tx.delete(artifactLinks).where(inArray(artifactLinks.id, stale));
  const kept = new Set(existing.filter((row) => wanted.has(row.targetId)).map((row) => row.targetId));
  // A typed [[link]] toward a card already suggested upgrades that semantic
  // edge into the reference edge: one row per pair, score kept as provenance.
  const suggested = await tx
    .select({ id: artifactLinks.id, targetId: artifactLinks.targetId })
    .from(artifactLinks)
    .where(and(
      eq(artifactLinks.workspaceId, auth.workspaceId),
      eq(artifactLinks.artifactId, artifactId),
      inArray(artifactLinks.targetType, [...LINKABLE_KINDS]),
      inArray(artifactLinks.linkType, ["semantic", "dismissed"]),
    ));
  const upgradable = suggested.filter((row) => wanted.has(row.targetId) && !kept.has(row.targetId));
  for (const row of upgradable) {
    await tx.update(artifactLinks).set({ linkType: "reference", label: wanted.get(row.targetId)!.label }).where(eq(artifactLinks.id, row.id));
  }
  const upgraded = new Set(upgradable.map((row) => row.targetId));
  const fresh = [...wanted.entries()].filter(([id]) => !kept.has(id) && !upgraded.has(id));
  if (fresh.length) {
    await tx.insert(artifactLinks).values(
      fresh.map(([targetId, w]) => ({
        workspaceId: auth.workspaceId,
        artifactId,
        targetType: w.kind,
        targetId,
        label: w.label,
        linkType: "reference" as const,
      })),
    );
  }
}

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

/*
 * The row-level half of createNote, exposed for a caller that already holds a
 * transaction and its own receipt (the capture inbox's convert-to-note, which
 * must commit the note and the capture's lineage edge atomically). Same
 * audit and outbox rows as createNote.
 */
export async function createNoteInTx(
  tx: TxDrizzle,
  auth: AuthContext,
  input: {
    title: string;
    content?: NoteContent;
    plainText?: string;
    kind?: NoteKind;
    /** The scaffold this note started from; null (the default) is a plain note. */
    template?: DraftTemplate | null;
  },
): Promise<{ id: string; versionId: string; version: number }> {
  const [artifact] = await tx
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: input.kind ?? "note",
      title: input.title,
      template: input.template ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
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
  await tx.update(artifacts).set({ currentVersionId: version.id, embedError: null }).where(eq(artifacts.id, artifact.id));
  await recordAudit(
    auth,
    { action: "note.created", subjectType: "artifact", subjectId: artifact.id, summary: `Created ${input.kind ?? "note"} "${input.title}"`, metadata: { versionId: version.id, kind: input.kind ?? "note" } },
    tx,
  );
  await emit(tx, auth, "note.created", { artifactId: artifact.id, versionId: version.id });
  return { id: artifact.id, versionId: version.id, version: artifact.version };
}

export async function createNote(
  auth: AuthContext,
  input: Keyed & { title: string; content?: NoteContent; plainText?: string; kind?: NoteKind },
): Promise<{ id: string; versionId: string; version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "createNote", ...input }, async () => createNoteInTx(tx, auth, input));
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
      await syncNoteLinks(tx, auth, artifact.id, markdownOf(input.content, input.plainText));
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
  const value = await withTransaction(async (tx) => {
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
      await tx.update(artifacts).set({ currentVersionId: snapshot.id, embedError: null }).where(eq(artifacts.id, artifact.id));
      await tx.delete(workingDrafts).where(and(eq(workingDrafts.artifactId, artifact.id), eq(workingDrafts.workspaceId, auth.workspaceId)));
      await syncNoteLinks(tx, auth, artifact.id, markdownOf(input.content, input.plainText));
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
  // A committed version is the text the card embeds from; refresh its
  // semantic relations best-effort, after the commit has landed, and never
  // blocking the save.
  try {
    await embedArtifact(auth, { artifactId: input.artifactId });
  } catch (cause) {
    console.error(`embedArtifact after commit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return value;
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

/** Category tags: normalized lowercase, deduped, same shape document tags use. */
export function normalizeNoteTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length >= 1 && tag.length <= 40) seen.add(tag);
  }
  return [...seen].slice(0, 12);
}

export async function setNoteTags(
  auth: AuthContext,
  input: Keyed & { artifactId: string; expectedVersion: number; tags: string[] },
): Promise<{ version: number; tags: string[] }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "setNoteTags", ...input }, async () => {
      const artifact = await claimVersion(tx, auth, input.artifactId, input.expectedVersion);
      const tags = normalizeNoteTags(input.tags);
      await tx.update(artifacts).set({ tags }).where(eq(artifacts.id, artifact.id));
      await recordAudit(
        auth,
        { action: "note.tags_changed", subjectType: "artifact", subjectId: artifact.id, summary: `Tagged note "${artifact.title}" as ${tags.length ? tags.join(", ") : "untagged"}`, metadata: { tags } },
        tx,
      );
      await emit(tx, auth, "note.tags_changed", { artifactId: artifact.id, tags });
      return { version: artifact.version, tags };
    });
    return value;
  });
}

/** Distinct category tags across this workspace's notes and zettels, for filter chips. */
export async function listNoteTags(auth: AuthContext): Promise<string[]> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ tag: sql<string>`jsonb_array_elements_text(${artifacts.tags})` })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), inArray(artifacts.kind, [...LINKABLE_KINDS]), isNull(artifacts.archivedAt)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((row) => row.tag);
  });
}

export type NoteListItem = {
  id: string;
  title: string;
  kind: string;
  status: string;
  version: number;
  updatedAt: Date;
  excerpt: string | null;
  hasDraft: boolean;
  tags: string[];
};

/** tags is jsonb; the notes surface only ever stores a list of strings there. */
function readTags(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

/*
 * The list previews what the person last wrote, not the last checkpoint: an
 * autosave-only note (the normal case) has no artifactVersions row yet, so a
 * preview keyed on plainText alone rendered blank until the first explicit
 * checkpoint. Draft content is uncapped, so the excerpt clamps to 500 chars;
 * the page trims markdown for display.
 */
const noteExcerptSql = sql<string | null>`coalesce(
  left(${workingDrafts.content} ->> 'text', 500),
  ${artifactVersions.plainText}
)`;

export async function listNotes(auth: AuthContext, limit = 50, kinds: readonly ("note" | "zettel")[] = LINKABLE_KINDS): Promise<NoteListItem[]> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        status: artifacts.status,
        version: artifacts.version,
        updatedAt: artifacts.updatedAt,
        excerpt: noteExcerptSql,
        tags: artifacts.tags,
        draftArtifactId: workingDrafts.artifactId,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .leftJoin(workingDrafts, eq(workingDrafts.artifactId, artifacts.id))
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), inArray(artifacts.kind, [...kinds]), isNull(artifacts.archivedAt)))
      .orderBy(desc(artifacts.updatedAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, hasDraft: row.draftArtifactId !== null, draftArtifactId: undefined }) as unknown as NoteListItem);
  });
}

/** One page of notes for the sidebar list; the total honours search and the drafts filter. */
export async function pageNotes(
  auth: AuthContext,
  input: { query?: string; draftsOnly?: boolean; tag?: string; kinds?: readonly ("note" | "zettel")[]; limit: number; offset: number },
): Promise<{ items: NoteListItem[]; total: number }> {
  return withTransaction(async (tx) => {
    const filters = [eq(artifacts.workspaceId, auth.workspaceId), inArray(artifacts.kind, [...(input.kinds ?? LINKABLE_KINDS)]), isNull(artifacts.archivedAt)];
    if (input.draftsOnly) filters.push(isNotNull(workingDrafts.artifactId));
    if (input.tag?.trim()) filters.push(sql`${artifacts.tags} @> ${JSON.stringify([input.tag.trim().toLowerCase()])}::jsonb`);
    if (input.query?.trim()) {
      const like = `%${escapeLike(input.query.trim())}%`;
      filters.push(or(ilike(artifacts.title, like), ilike(artifactVersions.plainText, like))!);
    }
    const where = and(...filters);
    const rows = await tx
        .select({
          id: artifacts.id,
          title: artifacts.title,
          kind: artifacts.kind,
          status: artifacts.status,
          version: artifacts.version,
          updatedAt: artifacts.updatedAt,
          excerpt: noteExcerptSql,
          tags: artifacts.tags,
          draftArtifactId: workingDrafts.artifactId,
        })
        .from(artifacts)
        .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .leftJoin(workingDrafts, eq(workingDrafts.artifactId, artifacts.id))
        .where(where)
        .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
        .limit(input.limit)
        .offset(input.offset);
    const [totalRow] = await tx
      .select({ n: count() })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .leftJoin(workingDrafts, eq(workingDrafts.artifactId, artifacts.id))
      .where(where);
    return {
      total: totalRow?.n ?? 0,
      items: rows.map(({ draftArtifactId, ...row }) => ({ ...row, tags: readTags(row.tags), hasDraft: draftArtifactId !== null })),
    };
  });
}

export type NoteDetail = {
  id: string;
  title: string;
  kind: string;
  status: string;
  version: number;
  currentVersionId: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  content: NoteContent | null;
  draft: { content: NoteContent; baseVersionId: string | null; updatedAt: Date } | null;
  /** Last indexing failure, if the embedding pass recorded one on this artifact. */
  embedError: string | null;
  /** Whether the CURRENT committed version has vectors - the note answers meaning search. */
  indexed: boolean;
};

export async function getNote(auth: AuthContext, artifactId: string): Promise<NoteDetail | null> {
  // A malformed id would reach Postgres as a uuid cast error and 500; it is
  // the same "no note here" as any other miss.
  if (!z.string().uuid().safeParse(artifactId).success) return null;
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        status: artifacts.status,
        version: artifacts.version,
        currentVersionId: artifacts.currentVersionId,
        tags: artifacts.tags,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
        embedError: artifacts.embedError,
        // The coverage check countMeaningUncovered applies fleet-wide, per note:
        // vectors exist for the version the card currently points at.
        indexed: sql<boolean>`exists (select 1 from ${embeddings} where ${embeddings.workspaceId} = ${auth.workspaceId} and ${embeddings.ownerType} = ${ARTIFACT_EMBEDDING_OWNER_TYPE} and ${embeddings.ownerId} = ${artifacts.id} and ${embeddings.sourceVersionId} = ${artifacts.currentVersionId})`,
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
    // The Notes editor autosaves prose over the row's content, so a
    // machine-structured kind (a report, a deck, an infographic) must never
    // open here: the guard is the same one the workbench's isGeneratableKind
    // applies in reverse. getDraftDetail serves those.
    if (!row || !(LINKABLE_KINDS as readonly string[]).includes(row.kind)) return null;
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      version: row.version,
      currentVersionId: row.currentVersionId,
      tags: readTags(row.tags),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // Mapped, never raw: the column is plain text and the UI renders it,
      // so only authored categories may reach the screen (#255's lesson).
      embedError: safeArtifactEmbedError(row.embedError),
      indexed: row.indexed,
      content: (row.content as NoteContent | null) ?? null,
      draft: row.draftContent ? { content: row.draftContent as NoteContent, baseVersionId: row.draftBaseVersionId, updatedAt: row.draftUpdatedAt! } : null,
    };
  });
}

/*
 * Retry a note's meaning indexing on demand (the notes-side counterpart of
 * the notebook source retry). The commit path embeds best-effort and records
 * a failure on artifacts.embed_error without blocking the save, so a note
 * written while the provider was unconfigured stays out of meaning search
 * until someone asks again. Same artifact guard as getNote: the row must be
 * this workspace's live note/zettel, or the retry would index something the
 * caller cannot see. The outcome is embedArtifact's own: succeeded / skipped
 * (no text) / failed (reason recorded on the artifact again).
 */
export async function retryNoteEmbedding(
  auth: AuthContext,
  input: { artifactId: string; provider?: EmbeddingProvider; batchTimeoutMs?: number },
): Promise<ArtifactEmbedOutcome> {
  if (!z.string().uuid().safeParse(input.artifactId).success) throw new NoteNotFoundError();
  const row = await withTransaction(async (tx) => {
    const [found] = await tx
      .select({ id: artifacts.id, kind: artifacts.kind })
      .from(artifacts)
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)))
      .limit(1);
    return found ?? null;
  });
  if (!row || !(LINKABLE_KINDS as readonly string[]).includes(row.kind)) throw new NoteNotFoundError();
  return embedArtifact(auth, { artifactId: row.id, provider: input.provider, batchTimeoutMs: input.batchTimeoutMs });
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

export type NoteVersionItem = {
  id: string;
  versionNumber: number;
  reason: string;
  note: string | null;
  createdAt: Date;
};

/** Immutable history for the editor's history dialog — newest first. */
export async function listNoteVersions(auth: AuthContext, artifactId: string, limit = 50): Promise<NoteVersionItem[]> {
  return withTransaction(async (tx) => {
    const [owned] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)))
      .limit(1);
    if (!owned) return [];
    return tx
      .select({
        id: artifactVersions.id,
        versionNumber: artifactVersions.versionNumber,
        reason: artifactVersions.reason,
        note: artifactVersions.note,
        createdAt: artifactVersions.createdAt,
      })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.workspaceId, auth.workspaceId)))
      .orderBy(desc(artifactVersions.versionNumber))
      .limit(limit);
  });
}

export type NoteLinkItem = {
  id: string;
  title: string;
  /** The card kind on the other end of the edge. */
  kind: string;
  /** Why the edge exists; "reference" is an explicit [[Title]]. */
  linkType: string;
  /** The passage or reason recorded with the edge, when there is one. */
  context: string | null;
  /** First line of the other card, so a backlink reads as what the note is. */
  excerpt: string | null;
};

const excerptOf = (text: string | null) => {
  if (!text) return null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  return line ? line.slice(0, 240) : null;
};

/** Where this note points: resolved [[Title]] targets, newest link first. */
export async function listNoteOutlinks(auth: AuthContext, artifactId: string): Promise<NoteLinkItem[]> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        linkType: artifactLinks.linkType,
        context: artifactLinks.context,
        plainText: artifactVersions.plainText,
      })
      .from(artifactLinks)
      .innerJoin(artifacts, eq(artifacts.id, artifactLinks.targetId))
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.artifactId, artifactId),
          notInArray(artifactLinks.linkType, ["semantic", "dismissed"]),
          inArray(artifactLinks.targetType, [...LINKABLE_KINDS]),
          isNull(artifacts.archivedAt),
        ),
      )
      .orderBy(desc(artifactLinks.createdAt));
    return rows.map(({ plainText, ...row }) => ({ ...row, excerpt: excerptOf(plainText) }));
  });
}

/** What points here: notes and zettels whose body resolves a [[Title]] to this one. */
export async function listNoteBacklinks(auth: AuthContext, artifactId: string): Promise<NoteLinkItem[]> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        linkType: artifactLinks.linkType,
        context: artifactLinks.context,
        plainText: artifactVersions.plainText,
      })
      .from(artifactLinks)
      .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          inArray(artifactLinks.targetType, [...LINKABLE_KINDS]),
          eq(artifactLinks.targetId, artifactId),
          notInArray(artifactLinks.linkType, ["semantic", "dismissed"]),
          isNull(artifacts.archivedAt),
        ),
      )
      .orderBy(desc(artifactLinks.createdAt));
    return rows.map(({ plainText, ...row }) => ({ ...row, excerpt: excerptOf(plainText) }));
  });
}

/** The document a zettel was decomposed from, via its `source` edge. */
export async function listNoteSources(auth: AuthContext, artifactId: string) {
  return withTransaction(async (tx) => {
    return tx
      .select({ id: artifactLinks.targetId, title: artifactLinks.label, context: artifactLinks.context })
      .from(artifactLinks)
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.artifactId, artifactId),
          eq(artifactLinks.targetType, "document"),
          eq(artifactLinks.linkType, "source"),
        ),
      )
      .orderBy(desc(artifactLinks.createdAt));
  });
}

/*
 * Synthesis: combine two or more cards into one new zettel. The new card is a
 * first-class zettel (same store, same editor) whose lineage is recorded as
 * explicit 'source' edges to every parent, so each parent shows it as a
 * backlink and the new card lists its parents as outlinks.
 */
export async function synthesizeZettel(
  auth: AuthContext,
  input: Keyed & { sourceIds: string[]; title?: string; body?: string },
): Promise<{ id: string; version: number }> {
  const ids = [...new Set(input.sourceIds)];
  if (ids.length < 2) throw new SynthesisError("Pick at least two cards to combine.");
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "synthesizeZettel", ...input }, async () => {
      const parents = await tx
        .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind })
        .from(artifacts)
        .where(and(
          eq(artifacts.workspaceId, auth.workspaceId),
          inArray(artifacts.id, ids),
          inArray(artifacts.kind, [...LINKABLE_KINDS]),
          isNull(artifacts.archivedAt),
        ));
      if (parents.length !== ids.length) throw new SynthesisError("Those cards are not all available.");
      const ordered = ids.map((id) => parents.find((p) => p.id === id)!);
      const title = (input.title?.trim() || ordered.map((p) => p.title).join(" + ")).slice(0, 300);
      const text = input.body?.trim() || `Combines: ${ordered.map((p) => p.title).join("; ")}.\n\nWrite the idea that only exists because these two meet.`;
      const created = await createNoteInTx(tx, auth, {
        title,
        kind: "zettel",
        content: { format: "markdown", text },
        plainText: text,
      });
      await tx.insert(artifactLinks).values(
        ordered.map((p) => ({
          workspaceId: auth.workspaceId,
          artifactId: created.id,
          targetType: p.kind,
          targetId: p.id,
          label: p.title,
          linkType: "source" as const,
          context: "Synthesized from this card.",
        })),
      );
      return { id: created.id, version: created.version };
    });
    return value;
  });
}

export class SynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthesisError";
  }
}
