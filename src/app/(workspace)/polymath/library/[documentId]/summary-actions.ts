"use server";

import { acceptReadingSummary, summarizeReading, type VerifiedReadingSummary } from "@/domains/knowledge/reading-summary";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The reader's summarize actions (ASH-292). Summarizing runs one generation
 * call against the workspace's quota and returns the verified proposal -
 * nothing is written until the owner accepts. Accepting writes the note,
 * the source link, and the zettel proposals in one idempotent boundary, so
 * both steps need a real member: a viewer reads, a member summarizes.
 */

export async function summarizeReadingAction(
  documentId: string,
): Promise<{ ok: true; summary: VerifiedReadingSummary; documentTitle: string } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await summarizeReading(auth, { documentId });
    return { ok: true, summary: result, documentTitle: result.documentTitle };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not summarize this document." };
  }
}

export async function acceptReadingSummaryAction(input: {
  documentId: string;
  summary: VerifiedReadingSummary;
  idempotencyKey: string;
}): Promise<{ ok: true; noteId: string; proposals: number } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await acceptReadingSummary(auth, {
      documentId: input.documentId,
      summary: input.summary,
      proposer: "reading-summary",
      idempotencyKey: input.idempotencyKey,
    });
    return { ok: true, noteId: result.note.id, proposals: result.proposals };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save this summary." };
  }
}
