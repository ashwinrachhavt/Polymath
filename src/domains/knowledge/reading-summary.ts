import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { defaultReadingSummarizer, type ReadingSummarizer } from "@/integrations/reading/summarizer";
import { createNote } from "./notes";
import { artifactLinks, documentExtractions, documents, zettelProposals } from "./schema";
import { currentExtractionIdSubquery } from "./versions";
import { zettelDedupeKey } from "./zettels";

/*
 * The reading summarizer's domain half (ASH-292). Producing a summary is
 * read-only: run the summarizer over the document's current extraction and
 * keep only what verifies - claims whose quote is not a verbatim passage of
 * the text are dropped, exactly the zettel pipeline's rule. Accepting a
 * summary is the only write: one note artifact ("Summary of <title>")
 * linked back to its source document, and one zettel proposal per verified
 * claim so every summarization flow feeds the zettel queue the issue asks
 * for. Both writes are idempotent (note idempotency key; the proposals'
 * dedupe key), so a retried accept folds instead of duplicating.
 */

export const MAX_SUMMARY_CHARS = 1_500;
export const MAX_SUMMARY_CLAIMS = 7;
export const MAX_SUMMARY_QUESTIONS = 5;
const MAX_CLAIM_CHARS = 400;
const MAX_QUESTION_CHARS = 200;

/** Re-locate a quote in the source text; returns the span or null. */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const needle = quote.trim();
  if (!needle) return null;
  const start = text.indexOf(needle);
  if (start < 0) return null;
  return { start, end: start + needle.length };
}

export type VerifiedReadingSummary = {
  summary: string;
  keyClaims: Array<{ claim: string; quote: string; start: number; end: number }>;
  openQuestions: string[];
  /** Claims the model offered but could not prove against the text. */
  droppedClaims: number;
};

/** Verify a raw model summary against the text it claims to describe. */
export function verifyReadingSummary(
  text: string,
  raw: { summary: string; keyClaims: Array<{ claim: string; quote: string }>; openQuestions: string[] },
): VerifiedReadingSummary {
  const keyClaims: VerifiedReadingSummary["keyClaims"] = [];
  let droppedClaims = 0;
  for (const c of raw.keyClaims) {
    const claim = c.claim?.trim();
    if (!claim || typeof c.quote !== "string") { droppedClaims++; continue; }
    const span = locateQuote(text, c.quote);
    if (!span) { droppedClaims++; continue; }
    keyClaims.push({ claim: claim.slice(0, MAX_CLAIM_CHARS), quote: c.quote.trim(), ...span });
    if (keyClaims.length >= MAX_SUMMARY_CLAIMS) break;
  }
  const openQuestions = raw.openQuestions
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_QUESTIONS)
    .map((q) => q.slice(0, MAX_QUESTION_CHARS));
  return { summary: raw.summary.trim().slice(0, MAX_SUMMARY_CHARS), keyClaims, openQuestions, droppedClaims };
}

async function loadCurrentExtraction(auth: AuthContext, documentId: string) {
  const [row] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text, title: documents.title })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(and(
      eq(documentExtractions.documentId, documentId),
      eq(documentExtractions.workspaceId, auth.workspaceId),
      eq(documentExtractions.status, "succeeded"),
      eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
    ))
    .limit(1);
  if (!row?.text) throw new ReadingSummaryError("document_not_found", "No such document, or it has no succeeded extraction.");
  return { id: row.id, text: row.text, title: row.title };
}

export class ReadingSummaryError extends Error {
  constructor(
    public readonly code: "document_not_found" | "empty_summary",
    message: string,
  ) {
    super(message);
    this.name = "ReadingSummaryError";
  }
}

/** Summarize a document's current extraction. Read-only; the accept path is below. */
export async function summarizeReading(
  auth: AuthContext,
  input: { documentId: string },
  summarizer?: ReadingSummarizer,
): Promise<VerifiedReadingSummary & { documentTitle: string }> {
  const extraction = await loadCurrentExtraction(auth, input.documentId);
  const engine = summarizer ?? defaultReadingSummarizer(auth.workspaceId);
  const raw = await engine.summarize(extraction.text);
  const verified = verifyReadingSummary(extraction.text, raw);
  if (!verified.summary && verified.keyClaims.length === 0) {
    throw new ReadingSummaryError("empty_summary", "The summarizer found nothing it could verify against the text.");
  }
  return { ...verified, documentTitle: extraction.title };
}

export function summaryToMarkdown(input: { summary: string; openQuestions: string[] }): string {
  const parts = [input.summary.trim()];
  if (input.openQuestions.length > 0) {
    parts.push(`Open questions\n${input.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Accept a summary: save it as a note linked to the source document, and
 * open one zettel proposal per verified claim (status proposed - the owner
 * still approves each card in the usual queue). Returns the note and the
 * number of proposals created.
 */
export async function acceptReadingSummary(
  auth: AuthContext,
  input: {
    documentId: string;
    summary: VerifiedReadingSummary;
    proposer: string;
    idempotencyKey: string;
  },
) {
  const [document] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new ReadingSummaryError("document_not_found", "No such document.");

  const text = summaryToMarkdown(input.summary);
  if (!text.trim()) throw new ReadingSummaryError("empty_summary", "There is no summary to save.");
  const title = `Summary of ${document.title}`.slice(0, 200);

  const note = await createNote(auth, {
    title,
    plainText: text,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    idempotencyKey: input.idempotencyKey,
  });

  // The extraction the summary was verified against, for proposal lineage.
  const extraction = await loadCurrentExtraction(auth, input.documentId);

  let proposals = 0;
  await withTransaction(async (tx) => {
    await tx
      .insert(artifactLinks)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: note.id,
        targetType: "document",
        targetId: document.id,
        linkType: "source",
        label: document.title.slice(0, 200),
        context: input.summary.summary.slice(0, 500),
      })
      .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });

    for (const c of input.summary.keyClaims) {
      const [row] = await tx
        .insert(zettelProposals)
        .values({
          workspaceId: auth.workspaceId,
          documentId: document.id,
          extractionId: extraction.id,
          title: c.claim.slice(0, 120),
          claim: c.claim,
          quote: c.quote,
          spanStart: c.start,
          spanEnd: c.end,
          dedupeKey: zettelDedupeKey(document.id, c.start, c.end),
          proposer: input.proposer,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing({ target: [zettelProposals.documentId, zettelProposals.dedupeKey] })
        .returning({ id: zettelProposals.id });
      if (row) proposals++;
    }

    await recordAudit(
      auth,
      {
        action: "reading_summary.accepted",
        subjectType: "document",
        subjectId: document.id,
        summary: `Accepted a reading summary of "${document.title}"`,
        metadata: { noteId: note.id, claims: input.summary.keyClaims.length, proposals },
      },
      tx,
    );
  });

  return { note, proposals };
}
