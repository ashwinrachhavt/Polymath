import { and, desc, eq, inArray } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { getDocumentReview, type DocumentReview } from "./queries";
import { documentExtractions } from "./schema";

/*
 * The Files preview pane: one read that answers "what is this document, what
 * did we read from it, and what has happened to it". Read-only; every number
 * comes from rows that already exist (review composition, extraction runs,
 * audit events), so the pane can never say something the record does not.
 */

export type PreviewActivity = {
  id: string;
  at: string;
  kind: "audit" | "extraction";
  summary: string;
};

export type DocumentPreview = {
  review: DocumentReview;
  /** First readable lines of the latest successful extraction, never the whole text. */
  excerpt: string | null;
  activity: PreviewActivity[];
};

const EXCERPT_CHARS = 1200;

export async function getDocumentPreview(auth: AuthContext, documentId: string): Promise<DocumentPreview | null> {
  const review = await getDocumentReview(auth, { documentId });
  if (!review) return null;

  const [extractions, audits] = await Promise.all([
    db
      .select({
        id: documentExtractions.id,
        status: documentExtractions.status,
        extractor: documentExtractions.extractor,
        text: documentExtractions.text,
        createdAt: documentExtractions.createdAt,
      })
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.workspaceId, auth.workspaceId)))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(10),
    db
      .select({
        id: auditEvents.id,
        summary: auditEvents.summary,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          inArray(auditEvents.subjectType, ["document", "file"]),
          eq(auditEvents.subjectId, documentId),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(20),
  ]);

  const readable = extractions.find((e) => e.status === "succeeded" && e.text);
  const excerpt = readable?.text ? readable.text.trim().slice(0, EXCERPT_CHARS) : null;

  const activity: PreviewActivity[] = [
    ...audits.map((a) => ({ id: a.id, at: a.createdAt.toISOString(), kind: "audit" as const, summary: a.summary })),
    ...extractions.map((e) => ({
      id: e.id,
      at: e.createdAt.toISOString(),
      kind: "extraction" as const,
      summary: `Read by ${e.extractor ?? "extractor"}: ${e.status}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return { review, excerpt, activity };
}
