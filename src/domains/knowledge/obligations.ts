import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { createTask } from "@/domains/work/commands";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documentObligations, documents, fieldProposals } from "./schema";

/*
 * Document obligations: what paperwork a document implies, proposed by rules
 * (never a model), accepted or rejected by a human. A date in a document is
 * stored as dueFromDocument but never auto-promotes — the task's dueAt is set
 * only by the explicit `dueAt` argument on accept, because a machine reading
 * "due 2026-01-01" out of a PDF is exactly the silent control the spec forbids.
 */

type ObligationKind = "confirm_invoice_status" | "review_agreement" | "provide_missing_info";

/** The dedupe key shape is public: callers may target a specific proposal context. */
export function obligationDedupeKey(kind: string, documentId: string, fieldProposalId?: string) {
  return `${kind}:${documentId}:${fieldProposalId ?? "doc"}`;
}

type Rule = {
  kind: ObligationKind;
  note: string;
  /** Gates the rule off the proposal's kind and name; status is not a signal. */
  match: (p: { fieldKind: string; fieldName: string }) => boolean;
};

const RULES: Rule[] = [
  {
    kind: "confirm_invoice_status",
    note: "This document looks like an invoice with an unpaid or unknown total. Confirm whether it was paid.",
    match: (p) => p.fieldKind === "money" && /invoice_total/.test(p.fieldName),
  },
  {
    kind: "provide_missing_info",
    note: "This document has unresolved missing-field proposals. Supply the missing information.",
    match: (p) => /missing/.test(p.fieldName),
  },
  // Never fired by the field loop (match always false): this rule keys off the
  // document title, and the note is reused by the title-based hit below.
  {
    kind: "review_agreement",
    note: "This looks like an agreement. Review its terms and execution status.",
    match: () => false,
  },
];

export async function proposeObligation(
  auth: AuthContext,
  input: {
    documentId: string;
    fieldProposalId?: string;
    kind: string;
    note?: string;
    dueFromDocument?: Date;
    dedupeKey: string;
  },
) {
  const [obligation] = await db
    .insert(documentObligations)
    .values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      fieldProposalId: input.fieldProposalId ?? null,
      kind: input.kind,
      note: input.note ?? null,
      dueFromDocument: input.dueFromDocument ?? null,
      dedupeKey: input.dedupeKey,
      status: "proposed",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    // The unique index on (documentId, dedupeKey) is the idempotency: a replay
    // or a racing rules pass lands on the existing row.
    .onConflictDoNothing({ target: [documentObligations.documentId, documentObligations.dedupeKey] })
    .returning();
  return obligation ?? null;
}

/**
 * Human acceptance. One transaction: flip the obligation (version-checked), create
 * the task, link it to the document, write the audit row. The task's dueAt comes
 * only from the explicit argument — never from dueFromDocument.
 */
export async function acceptObligation(
  auth: AuthContext,
  input: { obligationId: string; dueAt?: Date },
): Promise<{ taskId: string }> {
  // Atomic via the shared pool: the flip, the task, the link, and the audit
  // row are one decision.
  return withTransaction(async (tx) => {
    // Version-checked flip is the idempotency guard: a second accept matches
    // only status='proposed', so it cannot create a second task.
    const [obligation] = await tx
      .update(documentObligations)
      .set({
        status: "accepted",
        decidedAt: new Date(),
        decidedBy: auth.userId,
        updatedAt: new Date(),
        version: sql`${documentObligations.version} + 1`,
      })
      .where(
        and(
          eq(documentObligations.id, input.obligationId),
          eq(documentObligations.workspaceId, auth.workspaceId),
          eq(documentObligations.status, "proposed"),
        ),
      )
      .returning();
    if (!obligation) throw new Error("obligation not found or already decided");

    const task = await createTask(
      auth,
      {
        title: obligation.note ?? obligation.kind,
        dueAt: input.dueAt, // only the human's explicit date, never dueFromDocument
        links: [
          { targetType: "document", targetId: obligation.documentId, label: obligation.kind },
        ],
      },
      tx,
    );
    await tx
      .update(documentObligations)
      .set({ taskId: task.id, updatedAt: new Date() })
      .where(eq(documentObligations.id, obligation.id));
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "obligation.accepted",
      subjectType: "document_obligation",
      subjectId: obligation.id,
      summary: `Accepted obligation "${obligation.kind}" and created task`,
      metadata: { taskId: task.id, documentId: obligation.documentId },
    });

    return { taskId: task.id };
  });
}

export async function rejectObligation(auth: AuthContext, input: { obligationId: string }) {
  const [obligation] = await db
    .update(documentObligations)
    .set({
      status: "rejected",
      decidedAt: new Date(),
      decidedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${documentObligations.version} + 1`,
    })
    .where(
      and(
        eq(documentObligations.id, input.obligationId),
        eq(documentObligations.workspaceId, auth.workspaceId),
        eq(documentObligations.status, "proposed"),
      ),
    )
    .returning();
  if (!obligation) throw new Error("obligation not found or already decided");
  return obligation;
}

/**
 * Marks the obligation superseded by a newer one. The accepted task is left
 * alone on purpose: the human may still need to do it, and cancelling a user's
 * task because a document changed would be the machine taking control. If a
 * replacement task exists, the caller annotates the task instead.
 */
export async function supersedeObligation(
  auth: AuthContext,
  input: { obligationId: string; supersededById: string },
) {
  const [obligation] = await db
    .update(documentObligations)
    .set({
      status: "superseded",
      supersededBy: input.supersededById,
      decidedAt: new Date(),
      decidedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${documentObligations.version} + 1`,
    })
    .where(
      and(
        eq(documentObligations.id, input.obligationId),
        eq(documentObligations.workspaceId, auth.workspaceId),
        // Supersede is the amendment path: an accepted obligation (with its
        // task) is exactly the one a follow-up document can replace. Only
        // already-superseded or rejected rows are terminal here.
        inArray(documentObligations.status, ["proposed", "accepted"]),
      ),
    )
    .returning();
  if (!obligation) throw new Error("obligation not found or already decided");
  return obligation;
}

/**
 * Deterministic rules pass over the field proposals that already exist for a
 * document. No model, no due-date inference: each rule proposes at most one
 * obligation, keyed so re-running finds its twin. A doc type with no matching
 * rule proposes nothing — "unknown" is a valid outcome.
 */
export async function proposeObligationsFromDocument(
  auth: AuthContext,
  input: { documentId: string },
) {
  const [document] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new Error("document not found in workspace");

  const proposals = await db
    .select({
      id: fieldProposals.id,
      fieldKind: fieldProposals.fieldKind,
      fieldName: fieldProposals.fieldName,
    })
    .from(fieldProposals)
    .where(
      and(eq(fieldProposals.documentId, input.documentId), eq(fieldProposals.workspaceId, auth.workspaceId)),
    );

  // kind -> the matched rule and the proposal that fired it (null when the
  // rule keys off the document itself, as the agreement title rule does).
  const ruleHits = new Map<ObligationKind, { rule: Rule; proposalId: string | null }>();
  for (const p of proposals) {
    for (const rule of RULES) {
      if (rule.match(p) && !ruleHits.has(rule.kind)) ruleHits.set(rule.kind, { rule, proposalId: p.id });
    }
  }
  // The agreement rule keys off the document itself, not a field proposal.
  if (/agreement|contract/i.test(document.title) && !ruleHits.has("review_agreement")) {
    ruleHits.set("review_agreement", {
      rule: RULES.find((r) => r.kind === "review_agreement")!,
      proposalId: null,
    });
  }

  const created: string[] = [];
  for (const [kind, { rule, proposalId }] of ruleHits) {
    const obligation = await proposeObligation(auth, {
      documentId: input.documentId,
      fieldProposalId: proposalId ?? undefined,
      kind,
      note: rule.note,
      dedupeKey: obligationDedupeKey(kind, input.documentId, proposalId ?? undefined),
    });
    if (obligation) created.push(obligation.id);
  }
  return created;
}
