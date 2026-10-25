import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { JevRequestError, JevUnconfiguredError, type JevAnswer } from "@/integrations/jev/client";
import { JevDisabledError, jevClassifier, type ClassifyJudger } from "@/integrations/jev/provider";
import { JEV_QUESTIONS_VERSION, documentQuestions } from "@/integrations/jev/questions";
import { db } from "@/lib/db";
import { documentClassificationProposals, documents } from "./schema";
import { classifyDocument, documentTypes, type DocumentType } from "./vocabulary";

/*
 * The document-side Jev proposer (ASH-272): a second proposer behind the
 * same document_classification_proposals row the rules classifier writes.
 * The rules verdict is free, so Jev spends only on genuine uncertainty -
 * this runs only when the rules said "other" or low confidence, and a
 * statement/high verdict (the scoped auto-accept, ASH-202) skips it
 * entirely. The Choice over documentTypes is paired with the null-case Noul
 * ("is this any of the listed types at all?"), so "nothing fits" is a
 * probability, not a forced pick; >= 0.7 on both writes one open proposal
 * with proposer "jev@v1", anything less writes nothing.
 *
 * One open proposal per (document, proposer) is the existing invariant;
 * onConflictDoNothing keeps a re-run from stacking duplicates.
 */

export const JEV_CLASSIFIER = "jev@v1";

const DOC_YES = 0.7;

export async function proposeJevClassification(
  auth: AuthContext,
  input: { documentId: string; extractionId: string | null; text: string; fieldNames: string[]; filename?: string | null },
  deps: { judger?: ClassifyJudger } = {},
): Promise<{ proposed: boolean; docType?: DocumentType; skipped: "settled" | "disabled" | null }> {
  const [doc] = await db
    .select({ docType: documents.docType })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc || doc.docType) return { proposed: false, skipped: "settled" };

  // The rules verdict decides whether Jev spends anything at all.
  const rules = classifyDocument({ text: input.text, fieldNames: input.fieldNames, filename: input.filename });
  const uncertain = rules.docType === "other" || rules.confidence === "low";
  if (!uncertain) return { proposed: false, skipped: "settled" };

  let answers: Record<string, JevAnswer>;
  try {
    const result = await (deps.judger ?? jevClassifier(auth.workspaceId)).judge({
      state: input.text.slice(0, 12_000),
      questions: documentQuestions(documentTypes),
    });
    answers = result.answers;
  } catch (cause) {
    if (cause instanceof JevDisabledError || cause instanceof JevUnconfiguredError) {
      return { proposed: false, skipped: "disabled" };
    }
    if (cause instanceof JevRequestError) throw cause; // transient: let the proposal pass retry
    throw cause;
  }

  const choice = answers.docType;
  const fits = answers.docTypeFits;
  if (
    !choice || choice.type !== "choice" || !fits || fits.type !== "noul" ||
    fits.noul < DOC_YES || (choice.probabilities[choice.choice] ?? 0) < DOC_YES
  ) {
    return { proposed: false, skipped: null };
  }
  const docType = choice.choice as DocumentType;
  if (!documentTypes.includes(docType)) return { proposed: false, skipped: null };

  const inserted = await db
    .insert(documentClassificationProposals)
    .values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      extractionId: input.extractionId ?? null,
      proposedType: docType,
      confidence: "medium",
      signals: [
        `jev choice ${docType} p=${(choice.probabilities[docType] ?? 0).toFixed(2)}`,
        `fits p=${fits.noul.toFixed(2)}`,
        `questions ${JEV_QUESTIONS_VERSION}`,
      ],
      proposer: JEV_CLASSIFIER,
      createdBy: auth.userId,
    })
    .onConflictDoNothing()
    .returning({ id: documentClassificationProposals.id });
  return { proposed: inserted.length > 0, docType, skipped: null };
}
