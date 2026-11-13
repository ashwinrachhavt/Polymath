import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { defaultReadingSummarizer, type ReadingSummarizer } from "@/integrations/reading/summarizer";
import { embedArtifact } from "./embedding";
import { createNote } from "./notes";
import { artifactLinks, documentExtractions, documents } from "./schema";
import { currentExtractionIdSubquery } from "./versions";
import { createZettelFromSource } from "./zettels";

/*
 * The reading summarizer's domain half (ASH-292). Producing a summary is
 * read-only: run the summarizer over the document's current extraction and
 * keep only what verifies - claims whose quote is not a verbatim passage of
 * the text are dropped, exactly the zettel pipeline's rule. Accepting a
 * summary is the only write: one note artifact ("Summary of <title>")
 * linked back to its source document, and one zettel card per verified
 * claim — the accept click is the permission, so the claim is a card, not a
 * proposal. Both writes are idempotent (note idempotency key; the cards'
 * span dedupe), so a retried accept folds instead of duplicating.
 */

export const MAX_SUMMARY_CHARS = 1_500;
export const MAX_SUMMARY_CLAIMS = 7;
export const MAX_SUMMARY_QUESTIONS = 5;
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
    if (!claim || typeof c.quote !== "string") {
      droppedClaims++;
      continue;
    }
    const span = locateQuote(text, c.quote);
    if (!span) {
      droppedClaims++;
      continue;
    }
    keyClaims.push({ claim: claim, quote: c.quote.trim(), ...span });
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
    .where(
      and(
        eq(documentExtractions.documentId, documentId),
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documentExtractions.status, "succeeded"),
        eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
      ),
    )
    .limit(1);
  if (!row?.text)
    throw new ReadingSummaryError("document_not_found", "No such document, or it has no succeeded extraction.");
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
  const engine = summarizer ?? (await defaultReadingSummarizer(auth.workspaceId));
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
 * create one zettel card per verified claim (the accept click is the
 * permission — no proposal row waits behind it). Returns the note and the
 * number of cards created.
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

  // The extraction the summary was verified against, for claim_evidence lineage.
  const extraction = await loadCurrentExtraction(auth, input.documentId);

  const createdIds: string[] = [];
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

    // One card per verified claim, written by the same creation core every
    // zettelize surface uses. Its span gate is the retried accept's fold: the
    // same claim quote of the same document is already a card.
    for (const c of input.summary.keyClaims) {
      const result = await createZettelFromSource(
        auth,
        {
          source: { kind: "document", documentId: document.id },
          title: c.claim,
          content: c.claim,
          quote: c.quote,
          span: { start: c.start, end: c.end },
          extractionId: extraction.id,
          proposer: input.proposer,
          auditMetadata: { readingSummaryNoteId: note.id },
        },
        tx,
      );
      if ("artifactId" in result) createdIds.push(result.artifactId);
    }

    await recordAudit(
      auth,
      {
        action: "reading_summary.accepted",
        subjectType: "document",
        subjectId: document.id,
        summary: `Accepted a reading summary of "${document.title}"`,
        metadata: { noteId: note.id, claims: input.summary.keyClaims.length, created: createdIds.length },
      },
      tx,
    );
  });

  // The cards were written on our transaction, so the embeds are ours too:
  // best-effort, exactly as a bare creation embeds itself.
  for (const artifactId of createdIds) {
    try {
      await embedArtifact(auth, { artifactId });
    } catch (cause) {
      console.error(
        `embedArtifact after reading-summary claim card failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  return { note, created: createdIds.length };
}
