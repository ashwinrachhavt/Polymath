import { and, desc, eq, sql } from "drizzle-orm";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal } from "@/domains/actions/commands";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { externalAccounts } from "@/domains/integrations/schema";
import { withTransaction } from "@/lib/db-transaction";
import { contacts, correspondence } from "./schema";

/*
 * Outreach (ASH-139 C03): correspondence is drafted, edited and cancelled
 * here, and the approval gate is an action proposal linked on the row. The
 * provider send is deliberately not in this module: it runs through the
 * approval-bound send executor once the owner decides in Reviews.
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

    /*
     * Pin the recipient address at request time. The send executor compares
     * this against the contact's email at send time, so an address edited
     * after approval can never receive a message the owner did not see
     * addressed. Without an email there is nothing to approve a send to.
     */
    if (!draft.contactId) throw new ConflictError("Link a contact before requesting send approval.");
    const [contact] = await tx
      .select({ email: contacts.primaryEmail })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, auth.workspaceId), eq(contacts.id, draft.contactId)))
      .limit(1);
    if (!contact?.email) throw new ConflictError("The contact needs an email address before a send can be approved.");

    /*
     * Pin the sending account's provider identity, not just its row: a
     * reconnect swaps the Composio connected-account id on the SAME row, and
     * without this pin the approved send would leave from an account the
     * owner never reviewed. The executor compares at send time.
     */
    let connectedAccountId: string | null = null;
    if (draft.externalAccountId) {
      const [account] = await tx
        .select({ composioConnectedAccountId: externalAccounts.composioConnectedAccountId })
        .from(externalAccounts)
        .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.id, draft.externalAccountId)))
        .limit(1);
      connectedAccountId = account?.composioConnectedAccountId ?? null;
    }

    const { proposalId, deduplicated } = await createProposal(tx, auth, {
      capability: "send_mail",
      riskClass: "external_write",
      targetType: "correspondence",
      targetId: draft.id,
      title: `Send: ${draft.subject ?? "(no subject)"}`,
      expectedEffect: `Sends the drafted ${draft.channel} message as an external ${draft.channel} send to ${contact.email}.`,
      dedupeKey: `correspondence-send:${draft.id}`,
    });

    // The decision binds to a revision; without one nothing could be approved.
    // The payload is the exact content the executor re-checks before sending.
    if (!deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId,
        revisionNumber: 1,
        payload: {
          to: contact.email,
          contactId: draft.contactId,
          externalAccountId: draft.externalAccountId,
          connectedAccountId,
          subject: draft.subject,
          body: draft.body,
        },
        preview: { to: contact.email, subject: draft.subject, body: draft.body },
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

/*
 * Rows plus the linked send proposal's status, so the screen can show the
 * real next step - request approval, decide in Reviews, send the approved
 * draft - instead of a static "approval requested" label after the decision.
 */
export async function listCorrespondence(auth: AuthContext, input: { contactId?: string } = {}) {
  const rows = await db
    .select({ correspondence, proposalStatus: actionProposals.status })
    .from(correspondence)
    .leftJoin(
      actionProposals,
      and(eq(actionProposals.id, correspondence.actionProposalId), eq(actionProposals.workspaceId, auth.workspaceId)),
    )
    .where(
      input.contactId
        ? and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.contactId, input.contactId))
        : eq(correspondence.workspaceId, auth.workspaceId),
    )
    .orderBy(desc(correspondence.createdAt))
    .limit(100);
  return rows.map((row) => ({ ...row.correspondence, proposalStatus: row.proposalStatus }));
}
