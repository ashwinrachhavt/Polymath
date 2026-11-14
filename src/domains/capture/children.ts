import { and, asc, desc, eq } from "drizzle-orm";
import { blobObjects } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { documentExtractions, documents, files } from "@/domains/knowledge/schema";
import { readBlob } from "@/integrations/object-store/object-store";
import { db } from "@/lib/db";
import { captureDocuments, captures } from "./schema";

/*
 * A link capture's child documents: the pages its crawl (or the video its
 * absorption) filed into the library. The capture stays the person's note of
 * what they kept; the children are what can be read, quizzed and zettelized.
 * Every call is scoped to the caller's workspace on both sides.
 */

type Workspace = Pick<AuthContext, "workspaceId">;

/** True when the capture exists in this workspace. A job checks once before it links anything. */
export async function captureInWorkspace(auth: Workspace, captureId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, captureId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Records a document as one of the capture's children. Idempotent: a page
 * linked twice (a retried crawl, a redelivered run) keeps its first position.
 * The caller has checked the capture with captureInWorkspace; the document is
 * one it filed or found in the same workspace.
 */
export async function linkCaptureDocument(
  auth: Workspace,
  input: { captureId: string; documentId: string; position: number },
): Promise<void> {
  await db
    .insert(captureDocuments)
    .values({
      workspaceId: auth.workspaceId,
      captureId: input.captureId,
      documentId: input.documentId,
      position: input.position,
    })
    .onConflictDoNothing();
}

export type CaptureChild = { documentId: string; title: string; sourceUrl: string | null };

/** The capture's children in crawl order, root first. Bounded: a crawl files at most 30 pages. */
export async function listCaptureDocuments(auth: Workspace, captureId: string): Promise<CaptureChild[]> {
  return db
    .select({ documentId: documents.id, title: documents.title, sourceUrl: documents.sourceUrl })
    .from(captureDocuments)
    .innerJoin(
      documents,
      and(eq(documents.id, captureDocuments.documentId), eq(documents.workspaceId, captureDocuments.workspaceId)),
    )
    .where(and(eq(captureDocuments.workspaceId, auth.workspaceId), eq(captureDocuments.captureId, captureId)))
    .orderBy(asc(captureDocuments.position), asc(documents.title))
    .limit(100);
}

export type CaptureChildPage = {
  documentId: string;
  title: string;
  sourceUrl: string | null;
  /** The page's text as filed, or null when it cannot be read yet. */
  text: string | null;
  /** True when the text was cut for display. */
  shortened: boolean;
};

/** A page is shown to be read, not to be edited or exported whole: a very long one is cut. */
const MAX_READER_CHARS = 200_000;

/**
 * One child page of a capture, with its text, for the inbox reader. Null when
 * the document is not a child of this capture in this workspace. The text is
 * the current extraction's when there is one; a page whose extraction has not
 * run yet is read from its stored file instead (a crawled page is filed as
 * markdown), so the reader never waits on the extraction queue.
 */
export async function getCaptureChildPage(
  auth: Workspace,
  input: { captureId: string; documentId: string },
): Promise<CaptureChildPage | null> {
  const [doc] = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      sourceUrl: documents.sourceUrl,
      storageKey: blobObjects.storageKey,
    })
    .from(captureDocuments)
    .innerJoin(
      documents,
      and(eq(documents.id, captureDocuments.documentId), eq(documents.workspaceId, captureDocuments.workspaceId)),
    )
    .leftJoin(files, eq(files.id, documents.fileId))
    .leftJoin(blobObjects, eq(blobObjects.id, files.blobId))
    .where(
      and(
        eq(captureDocuments.workspaceId, auth.workspaceId),
        eq(captureDocuments.captureId, input.captureId),
        eq(captureDocuments.documentId, input.documentId),
      ),
    )
    .limit(1);
  if (!doc) return null;

  const [extraction] = await db
    .select({ text: documentExtractions.text })
    .from(documentExtractions)
    .where(
      and(
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documentExtractions.documentId, doc.documentId),
        eq(documentExtractions.status, "succeeded"),
      ),
    )
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  let text = extraction?.text ?? null;
  if (text === null && doc.storageKey) {
    text = await readBlob(doc.storageKey)
      .then((bytes) => new TextDecoder().decode(bytes))
      .catch(() => null);
  }
  const trimmed = text?.trim() || null;
  return {
    documentId: doc.documentId,
    title: doc.title,
    sourceUrl: doc.sourceUrl,
    text: trimmed === null ? null : trimmed.slice(0, MAX_READER_CHARS),
    shortened: trimmed !== null && trimmed.length > MAX_READER_CHARS,
  };
}
