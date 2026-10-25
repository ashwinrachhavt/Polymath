import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { embedArtifact } from "./embedding";
import { commitNoteSnapshot, createNoteInTx } from "./notes";
import { artifactLinks, artifactVersions, artifacts, documentExtractions, documents } from "./schema";

/*
 * A captured document - an upload, a URL fetch, a crawl page, a converted
 * text capture - is the "sources I captured" of the search spec, and until
 * now none of it was in the search index at all. Same projection as
 * thread-graph: one `document` artifact per document, the same versioned,
 * embeddable container every other card lives in, with a `source` edge back
 * to the document row and the document's reserved artifact_id column filled.
 * That one projection is all it takes for a captured source to be searched
 * (keyword AND meaning legs), related, and shown with its connections.
 *
 * The text is the latest succeeded extraction, so the mirror appears when
 * there is something to read and follows re-extractions. Syncing again
 * writes a new version only when the text changed; a title rename is applied
 * to the mirror on the next sync. The document stays the canonical record -
 * the artifact is its searchable mirror.
 */

export class DocumentNotFoundError extends Error {
  constructor() {
    super("That document does not exist in this workspace.");
    this.name = "DocumentNotFoundError";
  }
}

export async function syncDocumentToGraph(auth: AuthContext, documentId: string): Promise<{ artifactId: string | null; created: boolean }> {
  const [doc] = await db
    .select({ id: documents.id, title: documents.title, artifactId: documents.artifactId })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) throw new DocumentNotFoundError();

  const [extraction] = await db
    .select({ text: documentExtractions.text })
    .from(documentExtractions)
    .where(and(
      eq(documentExtractions.workspaceId, auth.workspaceId),
      eq(documentExtractions.documentId, documentId),
      eq(documentExtractions.status, "succeeded"),
    ))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  const text = extraction?.text?.trim() ?? "";
  // No succeeded text yet (or ever): nothing to mirror. Like a thread with
  // no messages, this completes quietly - a later extraction re-triggers.
  if (!text) return { artifactId: doc.artifactId ?? null, created: false };

  const [existing] = await db
    .select({ id: artifacts.id, title: artifacts.title, version: artifacts.version, currentText: artifactVersions.plainText })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(
      eq(artifactLinks.workspaceId, auth.workspaceId),
      eq(artifactLinks.targetType, "document"),
      eq(artifactLinks.targetId, documentId),
      eq(artifactLinks.linkType, "source"),
    ))
    .limit(1);

  const content = { format: "markdown", text };
  if (existing) {
    // A sync with nothing new writes nothing: no empty versions, no re-embed.
    if (existing.currentText !== text) {
      await commitNoteSnapshot(auth, { idempotencyKey: randomUUID(), artifactId: existing.id, expectedVersion: existing.version, content, plainText: text, note: "Source text updated" });
      try {
        await embedArtifact(auth, { artifactId: existing.id });
      } catch (cause) {
        console.error(`embedArtifact for document failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (existing.title !== doc.title) {
      await db.update(artifacts).set({ title: doc.title, updatedAt: new Date(), updatedBy: auth.userId }).where(eq(artifacts.id, existing.id));
    }
    if (doc.artifactId !== existing.id) {
      await db.update(documents).set({ artifactId: existing.id, updatedAt: new Date(), updatedBy: auth.userId }).where(eq(documents.id, documentId));
    }
    return { artifactId: existing.id, created: false };
  }

  const created = await withTransaction(async (tx) => {
    const note = await createNoteInTx(tx, auth, { title: doc.title, content, plainText: text, kind: "document" });
    await tx.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: note.id,
      targetType: "document",
      targetId: documentId,
      label: doc.title,
      linkType: "source",
    });
    await tx.update(documents).set({ artifactId: note.id, updatedAt: new Date(), updatedBy: auth.userId }).where(eq(documents.id, documentId));
    return note;
  });
  try {
    await embedArtifact(auth, { artifactId: created.id });
  } catch (cause) {
    console.error(`embedArtifact for document failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { artifactId: created.id, created: true };
}
