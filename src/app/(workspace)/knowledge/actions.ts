"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditEvents } from "@/domains/audit/schema";
import { acceptAssertions, acceptParty, type PartyDecision } from "@/domains/knowledge/parties";
import { acceptObligation, rejectObligation } from "@/domains/knowledge/obligations";
import { applyTitle } from "@/domains/knowledge/naming";
import { documentParties, fieldProposals } from "@/domains/knowledge/schema";
import { getAuthContext } from "@/lib/auth";
import { db } from "@/lib/db";

/*
 * The review workbench's mutation surface. Every action re-checks the row's
 * status or version in its WHERE clause — the database guard is the
 * idempotency, so a double-submit or a stale client throws rather than
 * silently succeeding, and the caller shows that as an error state.
 */

const uuid = z.string().uuid();

const revalidate = () => revalidatePath("/knowledge");

function isAlreadyDecided(cause: unknown) {
  return cause instanceof Error && /already decided/.test(cause.message);
}

function alreadyDecided(what: string): Error {
  return new Error(`${what} was already decided. Reload to see the current state.`);
}

function wrap(what: string, cause: unknown): never {
  if (isAlreadyDecided(cause)) throw alreadyDecided(what);
  throw cause;
}

/*
 * Granularity rule: one decision per call, no bulk accept. Batch review is
 * DM-spec §6 acceptance and lands with corpus data.
 */

export async function acceptField(
  fieldProposalId: string,
  acceptedValue?: string | null,
): Promise<{ ok: true }> {
  const parsed = z
    .object({
      fieldProposalId: uuid,
      acceptedValue: z.string().trim().min(1).max(500).nullable().optional(),
    })
    .parse({ fieldProposalId, acceptedValue: acceptedValue ?? undefined });
  const auth = await getAuthContext();

  // Read first so the blocked case is a visible reason, not a throw: a
  // proposal with no readable value and no typed correction cannot be
  // accepted — the value is the whole point of the field.
  const [proposal] = await db
    .select({
      id: fieldProposals.id,
      documentId: fieldProposals.documentId,
      fieldName: fieldProposals.fieldName,
      normalizedValue: fieldProposals.normalizedValue,
      status: fieldProposals.status,
    })
    .from(fieldProposals)
    .where(
      and(
        eq(fieldProposals.id, parsed.fieldProposalId),
        eq(fieldProposals.workspaceId, auth.workspaceId),
      ),
    )
    .limit(1);
  if (!proposal) throw new Error("field proposal not found in workspace");
  if (proposal.status !== "proposed") throw alreadyDecided("This field");

  const hasValue = acceptedValue != null && acceptedValue.trim().length > 0;
  if (proposal.normalizedValue == null && !hasValue) {
    throw new Error(
      "This value couldn't be read with confidence — type the value to accept it.",
    );
  }

  const [row] = await db
    .update(fieldProposals)
    .set({
      status: "accepted",
      // A typed correction wins over the machine's reading; the raw value on
      // the row is never edited.
      acceptedValue: hasValue ? parsed.acceptedValue ?? null : null,
      decidedAt: new Date(),
      decidedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${fieldProposals.version} + 1`,
    })
    .where(
      and(
        eq(fieldProposals.id, proposal.id),
        eq(fieldProposals.status, "proposed"),
        eq(fieldProposals.workspaceId, auth.workspaceId),
      ),
    )
    .returning({ id: fieldProposals.id });
  if (!row) throw alreadyDecided("This field");

  await db.insert(auditEvents).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    actorKind: "user",
    action: "field_proposal.accepted",
    subjectType: "field_proposal",
    subjectId: proposal.id,
    summary: `Accepted ${proposal.fieldName}`,
    metadata: { documentId: proposal.documentId, acceptedValue: hasValue ? acceptedValue : null },
  });

  revalidate();
  return { ok: true };
}

export async function rejectField(fieldProposalId: string): Promise<{ ok: true }> {
  const fieldProposalId_ = uuid.parse(fieldProposalId);
  const auth = await getAuthContext();
  const [row] = await db
    .update(fieldProposals)
    .set({
      status: "rejected",
      decidedAt: new Date(),
      decidedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${fieldProposals.version} + 1`,
    })
    .where(
      and(
        eq(fieldProposals.id, fieldProposalId_),
        eq(fieldProposals.status, "proposed"),
        eq(fieldProposals.workspaceId, auth.workspaceId),
      ),
    )
    .returning({ id: fieldProposals.id, fieldName: fieldProposals.fieldName, documentId: fieldProposals.documentId });
  if (!row) throw alreadyDecided("This field");

  await db.insert(auditEvents).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    actorKind: "user",
    action: "field_proposal.rejected",
    subjectType: "field_proposal",
    subjectId: row.id,
    summary: `Rejected ${row.fieldName}`,
    metadata: { documentId: row.documentId },
  });

  revalidate();
  return { ok: true };
}

/*
 * Defer is not a status — the enum's superseded means "replaced by a newer
 * extraction", which a deferral is not. Deferring records that the owner saw
 * the proposal and moved on; the row stays proposed and stays in the queue.
 * A durable deferred state is DM-spec §6 work, with the status to hold it.
 */
export async function deferField(fieldProposalId: string): Promise<{ ok: true }> {
  const fieldProposalId_ = uuid.parse(fieldProposalId);
  const auth = await getAuthContext();
  const [row] = await db
    .select({
      id: fieldProposals.id,
      documentId: fieldProposals.documentId,
      fieldName: fieldProposals.fieldName,
    })
    .from(fieldProposals)
    .where(
      and(
        eq(fieldProposals.id, fieldProposalId_),
        eq(fieldProposals.workspaceId, auth.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new Error("field proposal not found in workspace");

  await db.insert(auditEvents).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    actorKind: "user",
    action: "field_proposal.deferred",
    subjectType: "field_proposal",
    subjectId: row.id,
    summary: `Deferred ${row.fieldName}`,
    metadata: { documentId: row.documentId },
  });

  revalidate();
  return { ok: true };
}

/**
 * One party decision. When the decision resolves to a contact or company, the
 * document's already-accepted fields are written to the assertion ledger for
 * that record — the human approving the party is what admits the document's
 * facts about it.
 */
export async function acceptPartyDecision(
  partyId: string,
  decision: PartyDecision,
): Promise<{ ok: true }> {
  const parsed = z.object({ partyId: uuid }).parse({ partyId });
  const auth = await getAuthContext();

  const [party] = await db
    .select({ id: documentParties.id, documentId: documentParties.documentId })
    .from(documentParties)
    .where(
      and(eq(documentParties.id, parsed.partyId), eq(documentParties.workspaceId, auth.workspaceId)),
    )
    .limit(1);
  if (!party) throw new Error("party not found in workspace");

  try {
    const result = await acceptParty(auth, { partyId: parsed.partyId, decision });
    const subjectId = result.contactId ?? result.companyId;

    if (subjectId) {
      const acceptedFields = await db
        .select({
          id: fieldProposals.id,
          fieldName: fieldProposals.fieldName,
          acceptedValue: fieldProposals.acceptedValue,
          normalizedValue: fieldProposals.normalizedValue,
          evidenceSpans: fieldProposals.evidenceSpans,
        })
        .from(fieldProposals)
        .where(
          and(
            eq(fieldProposals.documentId, party.documentId),
            eq(fieldProposals.workspaceId, auth.workspaceId),
            eq(fieldProposals.status, "accepted"),
          ),
        );
      if (acceptedFields.length > 0) {
        await acceptAssertions(auth, {
          documentId: party.documentId,
          assertions: acceptedFields.map((field) => ({
            subjectType: result.contactId ? ("contact" as const) : ("company" as const),
            subjectId,
            attribute: field.fieldName,
            value: (field.acceptedValue ?? field.normalizedValue) as Record<string, unknown>,
            fieldProposalId: field.id,
            evidenceSpans: field.evidenceSpans as unknown[],
          })),
        });
      }
    }

    revalidate();
    return { ok: true };
  } catch (cause) {
    wrap("This party", cause);
  }
}

/** Accept or reject one obligation; acceptance creates the task inside the domain. */
export async function acceptDocumentObligation(
  obligationId: string,
  dueAt?: string,
): Promise<{ ok: true }> {
  const parsed = z
    .object({ obligationId: uuid, dueAt: z.string().min(1).optional() })
    .parse({ obligationId, dueAt: dueAt || undefined });
  const auth = await getAuthContext();
  try {
    await acceptObligation(auth, {
      obligationId: parsed.obligationId,
      dueAt: parsed.dueAt ? new Date(parsed.dueAt) : undefined,
    });
    revalidate();
    return { ok: true };
  } catch (cause) {
    wrap("This obligation", cause);
  }
}

export async function rejectDocumentObligation(obligationId: string): Promise<{ ok: true }> {
  const obligationId_ = uuid.parse(obligationId);
  const auth = await getAuthContext();
  try {
    await rejectObligation(auth, { obligationId: obligationId_ });
    revalidate();
    return { ok: true };
  } catch (cause) {
    wrap("This obligation", cause);
  }
}

export async function applyTitleAction(
  documentId: string,
  title: string,
  expectedVersion: number,
): Promise<{ ok: true }> {
  const parsed = z
    .object({
      documentId: uuid,
      title: z.string().trim().min(1).max(500),
      expectedVersion: z.number().int().positive(),
    })
    .parse({ documentId, title, expectedVersion });
  const auth = await getAuthContext();
  try {
    await applyTitle(auth, parsed);
    revalidate();
    return { ok: true };
  } catch (cause) {
    if (cause instanceof Error && /stale version/.test(cause.message)) {
      throw alreadyDecided("This title");
    }
    throw cause;
  }
}
