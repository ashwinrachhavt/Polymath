import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documentClassificationProposals, documents } from "./schema";
import { classifyDocument, type DocumentType } from "./vocabulary";

/*
 * B02 (ASH-143): classification runs at the end of the proposal pass, so a
 * document is classified as soon as it is read (ASH-202). A high-confidence
 * rules verdict is accepted in the same pass - the document-type catalogue is
 * only useful if uploading is enough - while medium and low confidence stay
 * proposals for the owner to decide. A model proposer plugs in behind the
 * same row with its own proposer id. One open proposal per (document,
 * proposer); accepting sets documents.doc_type - the single doc-type signal
 * obligations and naming consume - in the same transaction.
 */

export const RULES_CLASSIFIER = "rules@v1";

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

/** Propose a doc type from the extraction. Skips silently when a type is already accepted or proposed. */
export async function proposeClassification(
  auth: AuthContext,
  input: { documentId: string; extractionId: string | null; text: string; fieldNames: string[]; filename?: string | null },
): Promise<{ proposed: boolean; docType?: DocumentType }> {
  const [doc] = await db
    .select({ docType: documents.docType })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc || doc.docType) return { proposed: false };

  const result = classifyDocument({
    text: input.text,
    fieldNames: input.fieldNames,
    filename: input.filename,
  });
  if (result.docType === "other" && result.signals.length === 0) return { proposed: false };

  // High confidence is accepted on the spot: the catalogue classifies on
  // upload, and the proposal row still records the basis for the decision.
  // Anything shakier waits for the owner as an open proposal.
  if (result.confidence === "high") {
    await withTransaction(async (tx) => {
      await tx.insert(documentClassificationProposals).values({
        workspaceId: auth.workspaceId,
        documentId: input.documentId,
        extractionId: input.extractionId ?? null,
        proposedType: result.docType,
        confidence: result.confidence,
        signals: result.signals,
        proposer: RULES_CLASSIFIER,
        status: "accepted",
        decidedBy: auth.userId,
        decidedAt: sql`now()`,
        createdBy: auth.userId,
      });
      // The re-check inside the transaction keeps a concurrent manual accept
      // the winner: doc_type is only ever written where it is still unset.
      await tx
        .update(documents)
        .set({
          docType: result.docType,
          updatedAt: sql`now()`,
          updatedBy: auth.userId,
          version: sql`${documents.version} + 1`,
        })
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.workspaceId, auth.workspaceId),
            isNull(documents.docType),
          ),
        );
      await recordAudit(
        auth,
        {
          action: "document.classified",
          subjectType: "document",
          subjectId: input.documentId,
          summary: `Classified as ${result.docType} (${RULES_CLASSIFIER}, high confidence, accepted on upload)`,
        },
        tx,
      );
    });
    return { proposed: false, docType: result.docType };
  }

  const inserted = await db
    .insert(documentClassificationProposals)
    .values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      extractionId: input.extractionId ?? null,
      proposedType: result.docType,
      confidence: result.confidence,
      signals: result.signals,
      proposer: RULES_CLASSIFIER,
      createdBy: auth.userId,
    })
    // One open proposal per (document, proposer); a re-run of the same
    // extraction must not stack duplicates or revive a rejected one.
    .onConflictDoNothing()
    .returning({ id: documentClassificationProposals.id });
  return { proposed: inserted.length > 0, docType: result.docType };
}

async function decideClassification(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; decision: "accepted" | "rejected" },
) {
  return withTransaction(async (tx) => {
    const [proposal] = await tx
      .update(documentClassificationProposals)
      .set({
        status: input.decision,
        decidedBy: auth.userId,
        decidedAt: sql`now()`,
        updatedAt: sql`now()`,
        version: sql`${documentClassificationProposals.version} + 1`,
      })
      .where(
        and(
          eq(documentClassificationProposals.id, input.proposalId),
          eq(documentClassificationProposals.workspaceId, auth.workspaceId),
          eq(documentClassificationProposals.status, "proposed"),
          eq(documentClassificationProposals.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!proposal) throw new StaleWriteError("That classification was already decided. Reload to see the current state.");

    if (input.decision === "accepted") {
      // The doc-type signal is born here: version-checked so two accepts
      // racing on one document cannot both write.
      await tx
        .update(documents)
        .set({
          docType: proposal.proposedType,
          updatedAt: sql`now()`,
          updatedBy: auth.userId,
          version: sql`${documents.version} + 1`,
        })
        .where(and(eq(documents.id, proposal.documentId), eq(documents.workspaceId, auth.workspaceId)));
      await recordAudit(
        auth,
        {
          action: "document.classified",
          subjectType: "document",
          subjectId: proposal.documentId,
          summary: `Classified as ${proposal.proposedType} (${proposal.proposer}, ${proposal.confidence})`,
        },
        tx,
      );
    }
    return proposal;
  });
}

export const acceptClassification = (auth: AuthContext, input: { proposalId: string; expectedVersion: number }) =>
  decideClassification(auth, { ...input, decision: "accepted" });

export const rejectClassification = (auth: AuthContext, input: { proposalId: string; expectedVersion: number }) =>
  decideClassification(auth, { ...input, decision: "rejected" });

/** The workbench's open classification proposal for one document, if any. */
export async function getOpenClassification(auth: AuthContext, documentId: string) {
  const [row] = await db
    .select()
    .from(documentClassificationProposals)
    .where(
      and(
        eq(documentClassificationProposals.workspaceId, auth.workspaceId),
        eq(documentClassificationProposals.documentId, documentId),
        eq(documentClassificationProposals.status, "proposed"),
      ),
    )
    .limit(1);
  return row ?? null;
}
