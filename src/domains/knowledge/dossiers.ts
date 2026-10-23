import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documentExtractions, documents, dossierSources, dossiers, sources } from "./schema";
import { agentRuns } from "@/domains/agents/schema";

/*
 * Dossiers: a name plus a set of documents in this workspace. A dossier is a
 * boundary, so it only ever holds documents the caller's workspace owns:
 * attaching a foreign or unknown id fails the whole command and writes nothing.
 * Each attachment pins the document's latest succeeded extraction hash, so the
 * dossier says which version of the text it was built from.
 */

export class DossierError extends Error {
  constructor(public readonly code: "documents_not_found" | "dossier_not_found" | "invalid_name", message: string) {
    super(message);
    this.name = "DossierError";
  }
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function sourceFor(tx: Tx, auth: AuthContext, doc: { fileId: string | null; sourceUrl: string | null; title: string }): Promise<string> {
  // A capture that has landed has a file; a queued URL or YouTube capture does
  // not yet. Both belong in the notebook the moment they are captured, so the
  // address is the fallback key: documents.sourceUrl is canonical and unique
  // per workspace, so a queued video is found here and joins its source when
  // the transcript lands.
  if (doc.fileId || doc.sourceUrl) {
    const [existing] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.workspaceId, auth.workspaceId),
          doc.fileId ? eq(sources.fileId, doc.fileId) : undefined,
          doc.sourceUrl ? eq(sources.url, doc.sourceUrl) : undefined,
        ),
      )
      .limit(1);
    if (existing) return existing.id;
  }
  const [created] = await tx
    .insert(sources)
    .values({ workspaceId: auth.workspaceId, kind: "document", title: doc.title, fileId: doc.fileId, createdBy: auth.userId, updatedBy: auth.userId })
    .returning({ id: sources.id });
  return created.id;
}

/** Attach inside an open transaction. Throws if any id is not a live document of this workspace. */
async function attach(tx: Tx, auth: AuthContext, dossierId: string, documentIds: string[]) {
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return 0;
  const docs = await tx
    .select({ id: documents.id, fileId: documents.fileId, sourceUrl: documents.sourceUrl, title: documents.title })
    .from(documents)
    .where(and(inArray(documents.id, ids), eq(documents.workspaceId, auth.workspaceId), sql`${documents.archivedAt} is null`));
  if (docs.length !== ids.length) {
    throw new DossierError("documents_not_found", "One or more documents are not in this workspace.");
  }
  let attached = 0;
  for (const doc of docs) {
    const [latest] = await tx
      .select({ contentHash: documentExtractions.contentHash })
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, doc.id), eq(documentExtractions.workspaceId, auth.workspaceId), eq(documentExtractions.status, "succeeded")))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1);
    const sourceId = await sourceFor(tx, auth, doc);
    const rows = await tx
      .insert(dossierSources)
      .values({ workspaceId: auth.workspaceId, dossierId, sourceId, pinnedContentHash: latest?.contentHash ?? null })
      .onConflictDoNothing({ target: [dossierSources.dossierId, dossierSources.sourceId] })
      .returning({ id: dossierSources.id });
    attached += rows.length;
  }
  return attached;
}

export async function createDossier(auth: AuthContext, input: { name: string; documentIds: string[] }) {
  const name = input.name.trim();
  if (!name || name.length > 200) throw new DossierError("invalid_name", "Give the dossier a name of up to 200 characters.");
  return withTransaction(async (tx) => {
    const [dossier] = await tx
      .insert(dossiers)
      .values({ workspaceId: auth.workspaceId, title: name, createdBy: auth.userId, updatedBy: auth.userId })
      .returning({ id: dossiers.id, title: dossiers.title });
    await attach(tx, auth, dossier.id, input.documentIds); // a foreign id throws and rolls the dossier back too
    return dossier;
  });
}

export async function attachDocuments(auth: AuthContext, input: { dossierId: string; documentIds: string[] }) {
  return withTransaction(async (tx) => {
    const [dossier] = await tx
      .select({ id: dossiers.id })
      .from(dossiers)
      .where(and(eq(dossiers.id, input.dossierId), eq(dossiers.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!dossier) throw new DossierError("dossier_not_found", "No such dossier.");
    return { attached: await attach(tx, auth, input.dossierId, input.documentIds) };
  });
}

export async function listDossiers(auth: AuthContext) {
  return db
    .select({
      id: dossiers.id,
      title: dossiers.title,
      documentCount: sql<number>`(select count(*)::int from ${dossierSources} ds where ds.dossier_id = "dossiers"."id")`,
    })
    .from(dossiers)
    .where(and(eq(dossiers.workspaceId, auth.workspaceId), sql`${dossiers.archivedAt} is null`))
    .orderBy(desc(dossiers.updatedAt));
}

/** The document ids a dossier holds, or null when the dossier is not in this workspace. */
export async function dossierDocumentIds(auth: AuthContext, dossierId: string): Promise<string[] | null> {
  const [dossier] = await db
    .select({ id: dossiers.id })
    .from(dossiers)
    .where(and(eq(dossiers.id, dossierId), eq(dossiers.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!dossier) return null;
  const rows = await db
    .select({ id: documents.id })
    .from(dossierSources)
    .innerJoin(sources, eq(sources.id, dossierSources.sourceId))
    .innerJoin(
      documents,
      and(
        eq(documents.workspaceId, auth.workspaceId),
        // A landed capture binds by file; a queued URL or YouTube capture has
        // no file yet and binds by its canonical address until the bytes land.
        or(
          and(eq(documents.fileId, sources.fileId), isNotNull(documents.fileId)),
          and(isNotNull(sources.url), eq(documents.sourceUrl, sources.url)),
        ),
      ),
    )
    .where(and(eq(dossierSources.dossierId, dossierId), eq(dossierSources.workspaceId, auth.workspaceId)));
  return [...new Set(rows.map((r) => r.id))];
}

/** One dossier with its documents, or null when it is not in this workspace. */
export async function getDossierDetail(auth: AuthContext, dossierId: string) {
  const [dossier] = await db
    .select({ id: dossiers.id, title: dossiers.title })
    .from(dossiers)
    .where(and(eq(dossiers.id, dossierId), eq(dossiers.workspaceId, auth.workspaceId), sql`${dossiers.archivedAt} is null`))
    .limit(1);
  if (!dossier) return null;
  const docs = await db
    .select({ id: documents.id, title: documents.title, mimeType: documents.mimeType })
    .from(dossierSources)
    .innerJoin(sources, eq(sources.id, dossierSources.sourceId))
    .innerJoin(
      documents,
      and(
        eq(documents.workspaceId, auth.workspaceId),
        // Same rule as dossierDocumentIds: file binding for landed captures,
        // address binding for captures still in the queue.
        or(
          and(eq(documents.fileId, sources.fileId), isNotNull(documents.fileId)),
          and(isNotNull(sources.url), eq(documents.sourceUrl, sources.url)),
        ),
      ),
    )
    .where(and(eq(dossierSources.dossierId, dossierId), eq(dossierSources.workspaceId, auth.workspaceId)));
  const seen = new Set<string>();
  return { ...dossier, documents: docs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))) };
}

/** The workspace's filed documents, for the attach picker. */
/*
 * The documents a dossier can pick up. Each row carries its latest extraction
 * status so the picker can say which ones are unread yet (a dossier pins the
 * latest succeeded text, and a document without one contributes nothing).
 */
export async function listAttachableDocuments(auth: AuthContext) {
  const docs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), sql`${documents.archivedAt} is null`, sql`${documents.fileId} is not null`))
    .orderBy(desc(documents.createdAt))
    .limit(200);
  if (docs.length === 0) return docs.map((doc) => ({ ...doc, extractionStatus: null as string | null }));
  const extractions = await db
    .select({ documentId: documentExtractions.documentId, status: documentExtractions.status })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.workspaceId, auth.workspaceId), inArray(documentExtractions.documentId, docs.map((doc) => doc.id))))
    .orderBy(desc(documentExtractions.createdAt));
  const latest = new Map<string, string>();
  for (const row of extractions) if (!latest.has(row.documentId)) latest.set(row.documentId, row.status);
  return docs.map((doc) => ({ ...doc, extractionStatus: latest.get(doc.id) ?? null }));
}

/** The runs bound to a dossier (Studio Generate binds with a dossier subject), newest first. */
export async function listDossierRuns(auth: AuthContext, dossierId: string, limit = 5) {
  return db
    .select({ id: agentRuns.id, state: agentRuns.state, objective: agentRuns.objective, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, auth.workspaceId), sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "dossier", id: dossierId }])}::jsonb`))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}
