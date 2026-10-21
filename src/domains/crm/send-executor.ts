import { and, desc, eq, inArray } from "drizzle-orm";
import { actionAttempts, actionProposals, actionReviews, actionRevisions, providerObservations } from "@/domains/actions/schema";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { externalAccounts } from "@/domains/integrations/schema";
import { withTransaction } from "@/lib/db-transaction";
import { contacts, correspondence } from "./schema";

/*
 * Send executor (ASH-161 C03 follow-up). Executes exactly one approved send:
 * the proposal must be approved against its newest revision, the draft must
 * not have been edited after the decision, and an active connected account
 * must exist. The provider is behind the MailSender port; the default port
 * refuses, so nothing leaves the system until a live adapter is wired on
 * purpose. An attempt row is written as `unknown` BEFORE the call and settled
 * after it, so a crash mid-send can never trigger a blind second send: an
 * unsettled attempt blocks retry until reconciled.
 */

export class SendNotAllowedError extends Error {
  readonly code = "send_not_allowed";
}

export class SenderNotConfiguredError extends Error {
  readonly code = "sender_not_configured";
}

/** Throw from a MailSender when the provider may or may not have sent. */
export class SendOutcomeUnknownError extends Error {
  readonly code = "send_outcome_unknown";
}

export interface MailSender {
  send(input: {
    to: string;
    subject: string;
    body: string;
    providerConnectedAccountId: string;
    idempotencyKey: string;
  }): Promise<{ providerObjectId: string; threadId?: string }>;
}

export const unconfiguredSender: MailSender = {
  async send() {
    throw new SenderNotConfiguredError("No provider send adapter is wired on this deployment.");
  },
};

type Prepared = {
  attemptId: string;
  draft: typeof correspondence.$inferSelect;
  to: string;
  providerConnectedAccountId: string;
  alreadySent?: boolean;
};

async function prepare(auth: AuthContext, correspondenceId: string): Promise<Prepared> {
  return withTransaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(correspondence)
      .where(and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.id, correspondenceId)))
      .limit(1);
    if (!draft) throw new SendNotAllowedError("That draft no longer exists.");
    if (draft.state === "sent") {
      return { attemptId: "", draft, to: "", providerConnectedAccountId: "", alreadySent: true };
    }
    if (draft.state !== "drafted" && draft.state !== "planned") {
      throw new SendNotAllowedError(`A ${draft.state} draft cannot be sent.`);
    }
    if (draft.direction !== "outbound" || draft.channel !== "email") {
      throw new SendNotAllowedError("Only outbound email drafts can be sent.");
    }
    if (!draft.actionProposalId) throw new SendNotAllowedError("Request send approval first.");

    const [proposal] = await tx
      .select()
      .from(actionProposals)
      .where(and(eq(actionProposals.workspaceId, auth.workspaceId), eq(actionProposals.id, draft.actionProposalId)))
      .limit(1);
    if (!proposal || proposal.status !== "approved" || !proposal.decidedAt) {
      throw new SendNotAllowedError("The send has not been approved.");
    }
    const [latest] = await tx
      .select({ id: actionRevisions.id, payload: actionRevisions.payload })
      .from(actionRevisions)
      .where(and(eq(actionRevisions.workspaceId, auth.workspaceId), eq(actionRevisions.proposalId, proposal.id)))
      .orderBy(desc(actionRevisions.revisionNumber))
      .limit(1);
    if (!latest) throw new SendNotAllowedError("The approval has no revision.");
    const [review] = await tx
      .select()
      .from(actionReviews)
      .where(and(eq(actionReviews.workspaceId, auth.workspaceId), eq(actionReviews.proposalId, proposal.id)))
      .orderBy(desc(actionReviews.createdAt))
      .limit(1);
    if (!review || review.decision !== "approved" || review.revisionId !== latest.id) {
      throw new SendNotAllowedError("The approval does not cover the current revision.");
    }
    const approved = latest.payload as { subject?: string | null; body?: string | null; contactId?: string | null; externalAccountId?: string | null };
    if (
      approved.subject !== draft.subject ||
      approved.body !== draft.body ||
      approved.contactId !== draft.contactId ||
      approved.externalAccountId !== draft.externalAccountId
    ) {
      throw new SendNotAllowedError("The draft changed after it was approved. Request approval again.");
    }
    if (!draft.externalAccountId) throw new SendNotAllowedError("Choose a connected account to send from.");
    if (!draft.contactId) throw new SendNotAllowedError("The draft has no recipient contact.");

    const [account] = await tx
      .select()
      .from(externalAccounts)
      .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.id, draft.externalAccountId)))
      .limit(1);
    if (!account || account.status !== "active" || !account.composioConnectedAccountId) {
      throw new SendNotAllowedError("The sending account is not connected and active.");
    }
    const [contact] = await tx
      .select({ email: contacts.primaryEmail })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, auth.workspaceId), eq(contacts.id, draft.contactId)))
      .limit(1);
    if (!contact?.email) throw new SendNotAllowedError("The contact has no email address.");

    const prior = await tx
      .select()
      .from(actionAttempts)
      .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposal.id)))
      .orderBy(desc(actionAttempts.attemptNumber));
    if (prior.some((a) => a.status === "succeeded")) {
      throw new SendNotAllowedError("An attempt already succeeded; reconcile the draft state instead of resending.");
    }
    if (prior.some((a) => a.status === "unknown" && a.reconciliation === "pending")) {
      throw new SendNotAllowedError("A previous attempt has an unknown outcome. Reconcile it before retrying.");
    }
    const [attempt] = await tx
      .insert(actionAttempts)
      .values({
        workspaceId: auth.workspaceId,
        proposalId: proposal.id,
        revisionId: latest.id,
        // Scoped by attempt number: a refused send may legitimately be retried
        // as a new attempt, while two claimers racing on the same number still
        // collide on the unique key.
        idempotencyKey: `send:${proposal.id}:${(prior[0]?.attemptNumber ?? 0) + 1}`,
        attemptNumber: (prior[0]?.attemptNumber ?? 0) + 1,
        status: "unknown",
        reconciliation: "pending",
      })
      .returning({ id: actionAttempts.id });
    return {
      attemptId: attempt.id,
      draft,
      to: contact.email,
      providerConnectedAccountId: account.composioConnectedAccountId,
    };
  });
}

export async function sendApprovedCorrespondence(
  auth: AuthContext,
  input: { correspondenceId: string; sender?: MailSender },
): Promise<{ state: "sent" | "failed" | "unknown"; providerObjectId?: string; alreadySent?: boolean }> {
  const sender = input.sender ?? unconfiguredSender;
  const prepared = await prepare(auth, input.correspondenceId);
  if (prepared.alreadySent) return { state: "sent", alreadySent: true };

  let outcome: { providerObjectId: string; threadId?: string } | null = null;
  let failure: { code: string; unknown: boolean } | null = null;
  try {
    outcome = await sender.send({
      to: prepared.to,
      subject: prepared.draft.subject ?? "",
      body: prepared.draft.body ?? "",
      providerConnectedAccountId: prepared.providerConnectedAccountId,
      idempotencyKey: prepared.attemptId,
    });
  } catch (error) {
    const unknown = error instanceof SendOutcomeUnknownError;
    failure = { code: error instanceof Error && "code" in error ? String(error.code) : "send_failed", unknown };
  }

  return withTransaction(async (tx) => {
    if (outcome) {
      await tx
        .update(actionAttempts)
        .set({ status: "succeeded", reconciliation: "not_needed", providerObjectId: outcome.providerObjectId, endedAt: new Date() })
        .where(eq(actionAttempts.id, prepared.attemptId));
      await tx
        .update(correspondence)
        .set({
          state: "sent",
          providerObjectId: outcome.providerObjectId,
          threadId: outcome.threadId ?? null,
          occurredAt: new Date(),
          updatedAt: new Date(),
          updatedBy: auth.userId,
        })
        .where(eq(correspondence.id, prepared.draft.id));
      await recordAudit(
        auth,
        { action: "correspondence.sent", subjectType: "correspondence", subjectId: prepared.draft.id, summary: "Approved message sent" },
        tx,
      );
      return { state: "sent" as const, providerObjectId: outcome.providerObjectId };
    }
    const unknown = failure?.unknown ?? false;
    await tx
      .update(actionAttempts)
      .set({
        status: unknown ? "unknown" : "failed",
        reconciliation: unknown ? "pending" : "not_needed",
        errorCode: failure?.code ?? "send_failed",
        endedAt: new Date(),
      })
      .where(eq(actionAttempts.id, prepared.attemptId));
    await recordAudit(
      auth,
      {
        action: unknown ? "correspondence.send_unknown" : "correspondence.send_failed",
        subjectType: "correspondence",
        subjectId: prepared.draft.id,
        summary: unknown ? "Send outcome unknown; reconcile before retrying" : `Send failed (${failure?.code})`,
      },
      tx,
    );
    return { state: unknown ? ("unknown" as const) : ("failed" as const) };
  });
}

/*
 * Closes an UNKNOWN send attempt (ASH-191). An unknown outcome blocks every
 * retry until it is resolved, which is correct — but without this command the
 * block was permanent and the only exit was editing the database by hand.
 *
 * The caller supplies what the provider shows: a message exists (`sent` with its
 * id) or it does not (`absent`). Observation is recorded, so the decision is
 * auditable rather than a state flip. A `sent` observation settles the attempt
 * and marks the draft sent; an `absent` observation settles the attempt as
 * failed and leaves the draft editable for a fresh, separately approved send.
 *
 * Resolution is guarded on the attempt still being unknown-and-pending, so two
 * operators cannot both settle it and a late resolution cannot rewrite history.
 */
export async function resolveUnknownSend(
  auth: AuthContext,
  input: {
    attemptId: string;
    observation: { observedState: "sent"; providerObjectId: string } | { observedState: "absent" };
    /** How the caller learned it: a provider read, or a person checking their mailbox. */
    source: "provider_read" | "human_check";
  },
): Promise<{ resolved: boolean; settledAs?: "sent" | "absent" }> {
  return withTransaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(actionAttempts)
      .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.id, input.attemptId)))
      .limit(1);
    if (!attempt) throw new SendNotAllowedError("That send attempt is not in this workspace.");

    const provider = input.source === "provider_read" ? "provider" : "human";

    /*
     * A later observer who finds evidence contrary to the settlement still gets
     * recorded. Dropping it is the invisible work this table exists to prevent —
     * someone looked at the provider, decided something, and the system forgot.
     * The settlement itself stays closed: observations are append-only evidence,
     * not a second decision.
     */
    if (attempt.status !== "unknown" || attempt.reconciliation !== "pending") {
      await tx.insert(providerObservations).values({
        workspaceId: auth.workspaceId,
        attemptId: attempt.id,
        proposalId: attempt.proposalId,
        provider,
        providerObjectId: input.observation.observedState === "sent" ? input.observation.providerObjectId : null,
        observedState: input.observation.observedState,
        detail: { resolvedBy: auth.userId, arrivedAfterSettlement: true, settledStatus: attempt.status },
      });
      return { resolved: false };
    }

    const sent = input.observation.observedState === "sent";
    const providerObjectId =
      input.observation.observedState === "sent" ? input.observation.providerObjectId : attempt.providerObjectId;
    const settled = await tx
      .update(actionAttempts)
      .set({
        status: sent ? "succeeded" : "failed",
        reconciliation: "resolved",
        providerObjectId,
        // Kept, not replaced: the original unknown-outcome summary is the record
        // of what the provider did, and the resolution is a separate column's story.
        responseSummary: {
          ...(typeof attempt.responseSummary === "object" && attempt.responseSummary !== null
            ? (attempt.responseSummary as Record<string, unknown>)
            : {}),
          resolution: { resolvedBy: input.source, observedState: input.observation.observedState },
        },
        endedAt: new Date(),
      })
      .where(and(eq(actionAttempts.id, attempt.id), eq(actionAttempts.reconciliation, "pending")))
      .returning({ id: actionAttempts.id });
    if (settled.length === 0) return { resolved: false };

    await tx.insert(providerObservations).values({
      workspaceId: auth.workspaceId,
      attemptId: attempt.id,
      proposalId: attempt.proposalId,
      provider,
      providerObjectId,
      observedState: input.observation.observedState,
      detail: { resolvedBy: auth.userId },
    });

    if (input.observation.observedState === "sent") {
      // State-guarded and row-counted. An earlier reconciliation could have run
      // while this attempt was still pending, so the update must not resurrect a
      // cancelled draft or claim a draft it did not actually move.
      const moved = await tx
        .update(correspondence)
        .set({
          state: "sent",
          providerObjectId: input.observation.providerObjectId,
          occurredAt: new Date(),
          updatedAt: new Date(),
          updatedBy: auth.userId,
        })
        .where(
          and(
            eq(correspondence.workspaceId, auth.workspaceId),
            eq(correspondence.actionProposalId, attempt.proposalId),
            inArray(correspondence.state, ["planned", "drafted", "sent"]),
          ),
        )
        .returning({ id: correspondence.id });
      if (moved.length === 0) {
        throw new SendNotAllowedError(
          "The message was found, but its draft is no longer in a state that can record a send. Reconcile the draft by hand.",
        );
      }
    }

    await recordAudit(
      auth,
      {
        action: sent ? "correspondence.send_reconciled_sent" : "correspondence.send_reconciled_absent",
        subjectType: "action_attempt",
        subjectId: attempt.id,
        summary: sent ? "Unknown send reconciled: the message exists" : "Unknown send reconciled: nothing was sent",
      },
      tx,
    );
    return { resolved: true, settledAs: sent ? "sent" : "absent" };
  });
}
