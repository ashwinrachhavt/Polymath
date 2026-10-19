import { and, desc, eq, sql } from "drizzle-orm";
import { actionRevisions } from "@/domains/actions/schema";
import { createProposal } from "@/domains/actions/commands";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { externalAccounts } from "@/domains/integrations/schema";
import { withTransaction } from "@/lib/db-transaction";
import { contacts, correspondence } from "./schema";

/*
 * Outreach (ASH-139 C03): correspondence is drafted, edited, cancelled, and
 * approved - never sent from here. The approval gate is an action proposal
 * linked on the row; the actual provider send is a later slice that executes
 * an accepted proposal and comes back with a provider identity. No external
 * effect exists in this module.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

export async function draftCorrespondence(
  auth: AuthContext,
  input: {
    contactId: string;
    channel?: string;
    subject?: string;
    body: string;
    /** The connected account the send will go out from (checked at send time). */
    externalAccountId?: string;
    idempotencyKey?: string;
  },
) {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "draftCorrespondence", ...input }, async () => {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, auth.workspaceId), eq(contacts.id, input.contactId)))
        .limit(1);
      if (!contact) throw new ConflictError("That contact does not exist in this workspace.");

      if (input.externalAccountId) {
        const [account] = await tx
          .select({ id: externalAccounts.id })
          .from(externalAccounts)
          .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.id, input.externalAccountId)))
          .limit(1);
        if (!account) throw new ConflictError("That connected account does not exist in this workspace.");
      }

      const [row] = await tx
        .insert(correspondence)
        .values({
          workspaceId: auth.workspaceId,
          externalAccountId: input.externalAccountId ?? null,
          contactId: input.contactId,
          direction: "outbound",
          channel: input.channel ?? "email",
          subject: input.subject ?? null,
          body: input.body,
          state: "drafted",
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "correspondence.drafted", subjectType: "correspondence", subjectId: row.id, summary: `Draft to contact: ${input.subject ?? "(no subject)"}` },
        tx,
      );
      return row;
    });
    return value;
  });
}

/** Edits are open only while the draft has not been sent or cancelled. */
export async function updateCorrespondenceDraft(
  auth: AuthContext,
  input: { correspondenceId: string; expectedVersion: number; subject?: string; body?: string },
) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(correspondence)
      .set({
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        version: sql`${correspondence.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(correspondence.workspaceId, auth.workspaceId),
          eq(correspondence.id, input.correspondenceId),
          eq(correspondence.version, input.expectedVersion),
          sql`${correspondence.state} in ('planned', 'drafted')`,
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The draft changed or is no longer editable. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "correspondence.edited", subjectType: "correspondence", subjectId: updated.id, summary: "Draft edited" },
      tx,
    );
    return updated;
  });
}

export async function cancelCorrespondence(auth: AuthContext, input: { correspondenceId: string; expectedVersion: number }) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(correspondence)
      .set({ state: "cancelled", version: sql`${correspondence.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(
        and(
          eq(correspondence.workspaceId, auth.workspaceId),
          eq(correspondence.id, input.correspondenceId),
          eq(correspondence.version, input.expectedVersion),
          sql`${correspondence.state} in ('planned', 'drafted')`,
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The draft changed or can no longer be cancelled. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "correspondence.cancelled", subjectType: "correspondence", subjectId: updated.id, summary: "Draft cancelled" },
      tx,
    );
    return updated;
  });
}

/**
 * The approval gate: link an action proposal asking for the send. The draft
 * stays `drafted`; a Review decision accepts the proposal, and the execution
 * slice - which does not exist yet - performs the provider send and marks the
 * row `sent` with the provider identity. Requesting twice returns the same
 * proposal (the dedupe key is the draft id).
 */
export async function requestSendApproval(auth: AuthContext, input: { correspondenceId: string; expectedVersion: number }) {
  return withTransaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(correspondence)
      .where(and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.id, input.correspondenceId)))
      .limit(1);
    if (!draft) throw new StaleWriteError("That draft no longer exists. Reload and try again.");
    if (draft.version !== input.expectedVersion) {
      throw new StaleWriteError("The draft changed since you loaded it. Reload and try again.");
    }
    if (draft.state !== "drafted" && draft.state !== "planned") {
      throw new ConflictError(`A ${draft.state} draft cannot be sent.`);
    }
    if (draft.actionProposalId) {
      return { correspondence: draft, proposalId: draft.actionProposalId, alreadyRequested: true };
    }

    const { proposalId, deduplicated } = await createProposal(tx, auth, {
      capability: "send_mail",
      riskClass: "external_write",
      targetType: "correspondence",
      targetId: draft.id,
      title: `Send: ${draft.subject ?? "(no subject)"}`,
      expectedEffect: `Sends the drafted ${draft.channel} message as an external ${draft.channel} send to the linked contact.`,
      dedupeKey: `correspondence-send:${draft.id}`,
    });

    // The decision binds to a revision; without one nothing could be approved.
    // The payload is the exact content the executor re-checks before sending.
    if (!deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId,
        revisionNumber: 1,
        payload: { contactId: draft.contactId, externalAccountId: draft.externalAccountId, subject: draft.subject, body: draft.body },
        preview: { subject: draft.subject, body: draft.body },
        createdBy: auth.userId,
      });
    }
    const [updated] = await tx
      .update(correspondence)
      .set({ actionProposalId: proposalId, version: sql`${correspondence.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(correspondence.id, draft.id), eq(correspondence.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new StaleWriteError("The draft changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "correspondence.send_requested", subjectType: "correspondence", subjectId: draft.id, summary: "Send approval requested" },
      tx,
    );
    return { correspondence: updated, proposalId, alreadyRequested: false };
  });
}

export async function listCorrespondence(auth: AuthContext, input: { contactId?: string } = {}) {
  return db
    .select()
    .from(correspondence)
    .where(
      input.contactId
        ? and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.contactId, input.contactId))
        : eq(correspondence.workspaceId, auth.workspaceId),
    )
    .orderBy(desc(correspondence.createdAt))
    .limit(100);
}
