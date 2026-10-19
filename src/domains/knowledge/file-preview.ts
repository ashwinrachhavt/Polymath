import { and, desc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { getDocumentActivity, getDocumentVersions } from "./library";
import { getDocumentReview, type DocumentReview } from "./queries";
import { documentExtractions } from "./schema";

/*
 * The Files preview pane: one read that answers "what is this document, what
 * did we read from it, what versions exist, and what has happened to it".
 * Read-only; activity and versions come from the library domain's own
 * append-only sources, so the pane can never say something the record does not.
 */

export type PreviewActivity = { key: string; at: string; kind: string; summary: string };
export type PreviewVersion = { extractionId: string; at: string; status: string; reader: string | null; hash: string; error: string | null; current: boolean };

export type DocumentPreview = {
  review: DocumentReview;
  /** First readable lines of the latest successful extraction, never the whole text. */
  excerpt: string | null;
  activity: PreviewActivity[];
  versions: PreviewVersion[];
};

const EXCERPT_CHARS = 1200;

export async function getDocumentPreview(auth: AuthContext, documentId: string): Promise<DocumentPreview | null> {
  const review = await getDocumentReview(auth, { documentId });
  if (!review) return null;

  const [activity, versions, readable] = await Promise.all([
    getDocumentActivity(auth, { documentId, limit: 40 }),
    getDocumentVersions(auth, { documentId }),
    db
      .select({ text: documentExtractions.text })
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.workspaceId, auth.workspaceId), eq(documentExtractions.status, "succeeded")))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1),
  ]);

  const text = readable[0]?.text?.trim();
  const newestOk = versions.find((v) => v.status === "succeeded")?.extractionId;
  return {
    review,
    excerpt: text ? text.slice(0, EXCERPT_CHARS) : null,
    activity: activity.map((a, i) => ({ key: `${a.kind}-${i}-${a.at.toISOString()}`, at: a.at.toISOString(), kind: a.kind, summary: a.summary })),
    versions: versions.map((v) => ({
      extractionId: v.extractionId,
      at: v.createdAt.toISOString(),
      status: v.status,
      reader: v.proposer,
      hash: v.contentHash.slice(0, 8),
      error: v.error,
      current: v.extractionId === newestOk,
    })),
  };
}
