"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acceptFieldProposal, deferFieldProposal, partyAttribute, rejectFieldProposal } from "@/domains/knowledge/fields";
import { acceptAssertions, acceptParty, type PartyDecision } from "@/domains/knowledge/parties";
import { acceptObligation, rejectObligation } from "@/domains/knowledge/obligations";
import { captureUrl } from "@/domains/knowledge/capture-url";
import { acceptZettel, proposeZettels, rejectZettel } from "@/domains/knowledge/zettels";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import { applyTitle } from "@/domains/knowledge/naming";
import { documentParties, fieldProposals } from "@/domains/knowledge/schema";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";

/*
 * The review workbench's mutation surface. Every action re-checks the row's
 * status or version in its WHERE clause — the database guard is the
 * idempotency, so a double-submit or a stale client throws rather than
 * silently succeeding, and the caller shows that as an error state.
 *
 * Authorization: deciding is a write, so every action requires member or
 * above (viewers read only). Resource scope is enforced at the source: every
 * domain read and write filters on the caller's workspace, so a foreign id is
 * "not found" and never fetched.
 */

const uuid = z.string().uuid();

const revalidate = () => revalidatePath("/alfred/knowledge");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

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

const partyDecision: z.ZodType<PartyDecision> = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), contactId: uuid.optional(), companyId: uuid.optional() }),
  z.object({
    action: z.literal("create"),
    contact: z.object({ fullName: z.string().trim().min(1).max(300), primaryEmail: z.string().email().optional() }).optional(),
    company: z.object({ name: z.string().trim().min(1).max(300), domain: z.string().max(253).optional() }).optional(),
  }),
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("leave_unresolved") }),
]);

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
    .parse({ fieldProposalId, acceptedValue: acceptedValue || undefined });
  const auth = await authorize();
  try {
    await acceptFieldProposal(auth, parsed);
  } catch (cause) {
    wrap("This field", cause);
  }
  revalidate();
  return { ok: true };
}

export async function rejectField(fieldProposalId: string): Promise<{ ok: true }> {
  const parsed = uuid.parse(fieldProposalId);
  const auth = await authorize();
  try {
    await rejectFieldProposal(auth, { fieldProposalId: parsed });
  } catch (cause) {
    wrap("This field", cause);
  }
  revalidate();
  return { ok: true };
}

/** The proposal stays in the queue; only the fact that the owner saw it is recorded. */
export async function deferField(fieldProposalId: string): Promise<{ ok: true }> {
  const parsed = uuid.parse(fieldProposalId);
  const auth = await authorize();
  await deferFieldProposal(auth, { fieldProposalId: parsed });
  revalidate();
  return { ok: true };
}

/**
 * One party decision. When the decision resolves to a contact or company, the
 * document's already-accepted fields that were read from this party's block
 * are written to the assertion ledger for that record. Fields of another
 * party, or document-level facts like the total, never land on it.
 */
export async function acceptPartyDecision(
  partyId: string,
  decision: PartyDecision,
): Promise<{ ok: true }> {
  const parsed = z.object({ partyId: uuid, decision: partyDecision }).parse({ partyId, decision });
  const auth = await authorize();

  const [party] = await db
    .select({ id: documentParties.id, documentId: documentParties.documentId, partyRole: documentParties.partyRole })
    .from(documentParties)
    .where(
      and(eq(documentParties.id, parsed.partyId), eq(documentParties.workspaceId, auth.workspaceId)),
    )
    .limit(1);
  if (!party) throw new Error("party not found in workspace");

  try {
    const result = await acceptParty(auth, { partyId: parsed.partyId, decision: parsed.decision });
    const subjectId = result.contactId ?? result.companyId;

    if (subjectId) {
      const acceptedFields = await db
        .select({
          id: fieldProposals.id,
          extractionId: fieldProposals.extractionId,
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
            eq(fieldProposals.partyRole, party.partyRole),
          ),
        );
      if (acceptedFields.length > 0) {
        await acceptAssertions(auth, {
          documentId: party.documentId,
          assertions: acceptedFields.map((field) => ({
            subjectType: result.contactId ? ("contact" as const) : ("company" as const),
            subjectId,
            attribute: partyAttribute(field.fieldName, party.partyRole),
            value: field.acceptedValue ?? field.normalizedValue,
            fieldProposalId: field.id,
            extractionId: field.extractionId,
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
  const auth = await authorize();
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
  const auth = await authorize();
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
  const auth = await authorize();
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

export type CaptureUrlActionResult = { ok: true; message: string } | { ok: false; message: string };

/*
 * Paste a URL, get the same document an upload would make. Failures come back
 * as a message rather than a throw: a site that is down is an ordinary outcome,
 * not an application error. The document stays in the inbox as "Could not
 * read" with the reason on its extraction row; pasting the URL again retries.
 */
export async function captureUrlAction(url: string): Promise<CaptureUrlActionResult> {
  const auth = await authorize();
  const result = await captureUrl(auth, { url: z.string().max(2000).parse(url) });
  revalidate();
  if (!result.ok) return { ok: false, message: result.error };
  if (!result.extraction.ok) return { ok: false, message: result.extraction.error };
  return {
    ok: true,
    message: result.created ? "Captured. It is in the inbox." : "That address is already in the inbox.",
  };
}

/** Ask for zettel proposals from one succeeded document. Proposes only; nothing becomes knowledge yet. */
export async function proposeZettelsAction(documentId: string): Promise<{ ok: true; created: number }> {
  const id = uuid.parse(documentId);
  const auth = await authorize();
  try {
    const created = await proposeZettels(auth, { documentId: id });
    revalidate();
    return { ok: true, created: created.length };
  } catch (cause) {
    if (cause instanceof EmbeddingUnconfiguredError) {
      throw new Error("Zettel proposals need OPENROUTER_API_KEY to be set.");
    }
    if (cause instanceof Error && /no succeeded extraction/.test(cause.message)) {
      throw new Error("This document has no extracted text yet.");
    }
    throw cause;
  }
}

/** Accept writes the concept and the evidence link; reject writes only the decision. */
export async function acceptZettelAction(proposalId: string): Promise<{ ok: true }> {
  const id = uuid.parse(proposalId);
  const auth = await authorize();
  try {
    await acceptZettel(auth, { proposalId: id });
    revalidate();
    return { ok: true };
  } catch (cause) {
    wrap("This zettel", cause);
  }
}

export async function rejectZettelAction(proposalId: string): Promise<{ ok: true }> {
  const id = uuid.parse(proposalId);
  const auth = await authorize();
  try {
    await rejectZettel(auth, { proposalId: id });
    revalidate();
    return { ok: true };
  } catch (cause) {
    wrap("This zettel", cause);
  }
}
