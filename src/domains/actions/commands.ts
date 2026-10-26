import { and, desc, eq, sql } from "drizzle-orm";
import type { TxDrizzle } from "@/lib/db-transaction";
import { actionProposals } from "./schema";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { requireRole } from "@/lib/auth/guards";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { checkSenderAlias, senderAliasPolicy } from "./policy";
import { actionReviews, actionRevisions } from "./schema";

/*
 * Capabilities whose execution sends through a connected provider account.
 * Every revision of one pins the EXACT sender identity at creation time -
 * the external_accounts row, the provider's connected-account id, and the
 * owner-visible label - so the review card shows who would send BEFORE the
 * decision, and the approval binds that unchanged revision. The executor
 * refuses the effect when the live resolution no longer matches the pin,
 * and refuses any revision that carries no pin at all.
 */
/*
 * Capabilities whose revision pins the account it will act through. A pin is
 * what makes an approval bind to an identity: a reconnect or a default change
 * would otherwise let a reviewed write land in a different account.
 */
const ACCOUNT_PIN_PROVIDERS: Record<string, string> = {
  "gmail.send": "gmail",
  "notion.page.append": "notion",
  "notion.page.create": "notion",
};

export type SenderAccountPin =
  | { resolved: true; externalAccountId: string; connectedAccountId: string; alias: string; sender: string }
  | { resolved: false; alias: string | null; provider: string; reason?: string };

/** Resolve the sender identity a revision of this capability would send from. */
export async function senderAccountPin(
  auth: AuthContext,
  capability: string,
  accountAlias: string | null,
): Promise<SenderAccountPin | null> {
  const provider = ACCOUNT_PIN_PROVIDERS[capability];
  if (!provider) return null;
  // ASH-289: a sending grant scopes to explicitly authorized aliases. An
  // unauthorized alias never binds into a revision, and with a list
  // configured an unnamed sender resolves only inside it - the one connected
  // account is never substituted silently.
  const policy = await senderAliasPolicy(auth.workspaceId, capability);
  const verdict = checkSenderAlias(policy, accountAlias);
  if (!verdict.allowed) return { resolved: false, alias: accountAlias, provider, reason: verdict.reason };
  const resolved = await resolveConnectedAccount(
    auth,
    provider,
    accountAlias ?? undefined,
    policy.configured ? policy.aliases : undefined,
  );
  if (!resolved.ok) return { resolved: false, alias: accountAlias, provider, reason: resolved.message };
  return {
    resolved: true,
    externalAccountId: resolved.externalAccountId,
    connectedAccountId: resolved.connectedAccountId,
    alias: resolved.alias,
    sender: resolved.displayName ?? resolved.alias,
  };
}

/** Fold the pin into the payload (binding) and the preview (what the reviewer sees). */
export function withSenderAccountPin(
  pin: SenderAccountPin | null,
  payload: Record<string, unknown>,
  preview: Record<string, unknown> | null,
): { payload: Record<string, unknown>; preview: Record<string, unknown> | null } {
  if (!pin) return { payload, preview };
  return { payload: { ...payload, accountPin: pin }, preview: { ...(preview ?? {}), accountPin: pin } };
}


/*
 * The only write path that turns model intent into an external effect. A tool
 * never calls a provider: it proposes, and the proposal carries the preview, the
 * risk class, and the dedupe key a human decides on.
 *
 * Dedupe is the guardrail, not a convenience. `(workspace_id, dedupe_key)` is
 * unique, so a replayed run — a resumed step, an at-least-once hook, a retry —
 * resolves the existing proposal instead of creating a second effect. The
 * insert loses the race on purpose and the read that follows returns the winner.
 */

export async function createProposal(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: {
    capability: string;
    riskClass: "prepare" | "external_write" | "sensitive_write";
    targetType?: string;
    targetId?: string;
    accountAlias?: string;
    title: string;
    expectedEffect: string;
    dedupeKey: string;
    runId?: string | null;
    expiresAt?: Date | null;
  },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const inserted = await tx
    .insert(actionProposals)
    .values({
      workspaceId: ctx.workspaceId,
      capability: input.capability,
      riskClass: input.riskClass,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      accountAlias: input.accountAlias ?? null,
      title: input.title,
      expectedEffect: input.expectedEffect,
      dedupeKey: input.dedupeKey,
      runId: input.runId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoNothing({ target: [actionProposals.workspaceId, actionProposals.dedupeKey] })
    .returning({ id: actionProposals.id });
  if (inserted.length > 0) return { proposalId: inserted[0].id, deduplicated: false };

  const [existing] = await tx
    .select({ id: actionProposals.id })
    .from(actionProposals)
    .where(
      and(
        eq(actionProposals.workspaceId, ctx.workspaceId),
        eq(actionProposals.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  // ponytail: racy caller deleted the row between insert and select; treat as
  // retryable failure, not a TypeError, when the contract next changes.
  if (!existing) throw new Error("proposal vanished during dedupe resolve");
  return { proposalId: existing.id, deduplicated: true };
}


/*
 * Human decisions on proposals (Reviews v2). A decision is one transaction:
 * idempotency receipt → compare-and-set on (version, still pending) → status
 * flip + review row → audit + outbox, committed together or not at all.
 *
 * Nothing here executes. Approving marks the proposal approved and binds the
 * decision to the exact revision seen; the attempt step is a separate gate
 * (execution settings, executor) that this command never opens.
 */

export class ProposalNotFoundError extends Error {
  readonly code = "proposal_not_found";
  constructor() {
    super("That proposal does not exist in this workspace.");
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalConflictError extends Error {
  readonly code = "proposal_conflict";
  constructor() {
    super("This proposal changed since you loaded it. Reload and try again.");
    this.name = "ProposalConflictError";
  }
}

export class StaleRevisionError extends Error {
  readonly code = "stale_revision";
  constructor() {
    super("The payload changed since you loaded it. Inspect the new revision before deciding.");
    this.name = "StaleRevisionError";
  }
}

async function emit(tx: TxDrizzle, auth: AuthContext, topic: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic, payload });
}

/** The revision a fresh decision must name: the newest one on the proposal. */
async function latestRevisionId(tx: TxDrizzle, workspaceId: string, proposalId: string) {
  const [latest] = await tx
    .select({ id: actionRevisions.id, revisionNumber: actionRevisions.revisionNumber })
    .from(actionRevisions)
    .where(and(eq(actionRevisions.workspaceId, workspaceId), eq(actionRevisions.proposalId, proposalId)))
    .orderBy(desc(actionRevisions.revisionNumber))
    .limit(1);
  return latest ?? null;
}

export async function decideProposal(
  auth: AuthContext,
  input: {
    idempotencyKey?: string;
    proposalId: string;
    expectedVersion: number;
    revisionId: string;
    decision: "approved" | "rejected";
    note?: string;
  },
): Promise<{ id: string; version: number; replayed: boolean }> {
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "decideProposal", ...input },
      async () => {
        const latest = await latestRevisionId(tx, auth.workspaceId, input.proposalId);
        if (!latest) throw new ProposalNotFoundError();
        if (latest.id !== input.revisionId) throw new StaleRevisionError();

        // ADR 0006 Q5 (owner-approved): the owner approves anything that
        // leaves the workspace or touches sensitive data; an admin may
        // approve internal preparation. Rejecting stays open to members.
        if (input.decision === "approved") {
          const [risk] = await tx
            .select({ riskClass: actionProposals.riskClass })
            .from(actionProposals)
            .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
            .limit(1);
          if (!risk) throw new ProposalNotFoundError();
          requireRole(auth, risk.riskClass === "prepare" ? "admin" : "owner");
        }

        const [row] = await tx
          .update(actionProposals)
          .set({
            status: input.decision,
            decidedAt: new Date(),
            decidedBy: auth.userId,
            updatedAt: new Date(),
            updatedBy: auth.userId,
            version: sql`${actionProposals.version} + 1`,
          })
          .where(
            and(
              eq(actionProposals.id, input.proposalId),
              eq(actionProposals.workspaceId, auth.workspaceId),
              eq(actionProposals.version, input.expectedVersion),
              eq(actionProposals.status, "pending"),
            ),
          )
          .returning({ id: actionProposals.id, version: actionProposals.version, title: actionProposals.title });
        if (!row) {
          const [exists] = await tx
            .select({ id: actionProposals.id })
            .from(actionProposals)
            .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
            .limit(1);
          if (!exists) throw new ProposalNotFoundError();
          throw new ProposalConflictError();
        }

        await tx.insert(actionReviews).values({
          workspaceId: auth.workspaceId,
          proposalId: input.proposalId,
          revisionId: input.revisionId,
          decision: input.decision,
          note: input.note?.trim() || null,
          reviewedBy: auth.userId,
        });

        await recordAudit(
          auth,
          {
            action: "actions.proposal_decided",
            subjectType: "action_proposal",
            subjectId: row.id,
            summary: `${input.decision === "approved" ? "Approved" : "Rejected"} proposal: ${row.title}`,
            metadata: { decision: input.decision, revisionId: input.revisionId },
          },
          tx,
        );
        await emit(tx, auth, "actions.proposal.decided", {
          proposalId: row.id,
          decision: input.decision,
          revisionId: input.revisionId,
        });
        return { id: row.id, version: row.version };
      },
    );
    return { ...value, replayed };
  });
}

/*
 * Editing the payload appends an immutable revision and bumps the proposal's
 * version, which is what invalidates every decision rendered against the old
 * revision: their expectedVersion and revisionId no longer match. Only a
 * pending proposal can be revised — a decided one is history, and a changed
 * intent is a new proposal (revisionOf) from its agent, not an edit.
 */
export async function reviseProposal(
  auth: AuthContext,
  input: {
    idempotencyKey?: string;
    proposalId: string;
    expectedVersion: number;
    payload: unknown;
    preview?: unknown;
  },
): Promise<{ id: string; version: number; revisionId: string; revisionNumber: number; replayed: boolean }> {
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "reviseProposal", ...input },
      async () => {
        const [proposal] = await tx
          .select({
            id: actionProposals.id,
            status: actionProposals.status,
            title: actionProposals.title,
            capability: actionProposals.capability,
            accountAlias: actionProposals.accountAlias,
          })
          .from(actionProposals)
          .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
          .limit(1);
        if (!proposal) throw new ProposalNotFoundError();
        if (proposal.status !== "pending") throw new ProposalConflictError();

        const [row] = await tx
          .update(actionProposals)
          .set({
            updatedAt: new Date(),
            updatedBy: auth.userId,
            version: sql`${actionProposals.version} + 1`,
          })
          .where(
            and(
              eq(actionProposals.id, input.proposalId),
              eq(actionProposals.workspaceId, auth.workspaceId),
              eq(actionProposals.version, input.expectedVersion),
              eq(actionProposals.status, "pending"),
            ),
          )
          .returning({ id: actionProposals.id, version: actionProposals.version });
        if (!row) throw new ProposalConflictError();

        const latest = await latestRevisionId(tx, auth.workspaceId, input.proposalId);
        const revisionNumber = (latest?.revisionNumber ?? 0) + 1;
        // The pin is resolved as the revision is written, so the reviewer
        // sees the exact sender before deciding; the approval then binds
        // this revision unchanged.
        const pinned = withSenderAccountPin(
          await senderAccountPin(auth, proposal.capability, proposal.accountAlias),
          input.payload as Record<string, unknown>,
          (input.preview ?? null) as Record<string, unknown> | null,
        );
        const [revision] = await tx
          .insert(actionRevisions)
          .values({
            workspaceId: auth.workspaceId,
            proposalId: input.proposalId,
            revisionNumber,
            payload: pinned.payload,
            preview: pinned.preview,
            createdBy: auth.userId,
          })
          .returning({ id: actionRevisions.id });

        await recordAudit(
          auth,
          {
            action: "actions.proposal_revised",
            subjectType: "action_proposal",
            subjectId: row.id,
            summary: `New payload revision ${revisionNumber} on proposal: ${proposal.title}`,
            metadata: { revisionId: revision.id, revisionNumber },
          },
          tx,
        );
        await emit(tx, auth, "actions.proposal.revised", {
          proposalId: row.id,
          revisionId: revision.id,
          revisionNumber,
        });
        return { id: row.id, version: row.version, revisionId: revision.id, revisionNumber };
      },
    );
    return { ...value, replayed };
  });
}
