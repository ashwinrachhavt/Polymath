import { and, asc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { documents } from "@/domains/knowledge/schema";
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
