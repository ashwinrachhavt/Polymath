"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { decideProposal, ProposalConflictError, reviseProposal } from "@/domains/actions/commands";
import { LOCAL_WRITERS } from "./local-writes";
import { executeApprovedEffect, supportsEffect, type EffectOutcome } from "@/domains/actions/executor";
import { refusalMessage } from "@/domains/actions/refusal-message";
import { actionProposals, actionReviews } from "@/domains/actions/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Reviews decisions (canonical queue). Every write carries the idempotency
 * key the card minted on first click (retries replay, never double-decide),
 * the version the card rendered, and - for a decision - the exact revision
 * the owner inspected.
 *
 * Approving an external write is the one path that executes: the decision
 * commits, then the approved-effect executor runs the exact revision. A retry
 * that finds the proposal already approved falls through to the executor, the
 * way `approveCalendarProposal` does, because the executor is replay-safe on
 * the proposal's intent key. A rejected or merely recorded decision never
 * executes.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const revalidate = () => {
  revalidatePath("/reviews");
  revalidatePath("/command-center/briefing");
};

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "The review write failed." };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * decided: the decision row committed before the failure (an executor or
 * post-approval step refused). The card's decided state is server truth, so
 * the client keeps its decided card + alert and must NOT refresh them away;
 * a refresh is only honest when the decision itself never landed.
 */
type DecideResult =
  | { ok: true; outcome: EffectOutcome | null }
  | { ok: false; error: string; decided?: boolean };

export async function decideProposalAction(input: {
  idempotencyKey: string;
  proposalId: string;
  expectedVersion: number;
  revisionId: string;
  decision: "approved" | "rejected";
  note?: string;
}): Promise<DecideResult> {
  const auth = await authorize();
  if (!UUID.test(input.proposalId) || !UUID.test(input.revisionId) || !UUID.test(input.idempotencyKey)) {
    return { ok: false, error: "Malformed review decision." };
  }
  if (input.decision !== "approved" && input.decision !== "rejected") {
    return { ok: false, error: "Malformed review decision." };
  }
  try {
    await decideProposal(auth, { ...input, note: input.note?.slice(0, 2000) });
  } catch (error) {
    if (input.decision !== "approved" || !(error instanceof ProposalConflictError)) {
      return fail(error);
    }
    // A retry after the decision committed: the executor decides whether that
    // approval has already been spent.
    const [proposal] = await db
      .select({ status: actionProposals.status })
      .from(actionProposals)
      .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (proposal?.status !== "approved") return fail(error);
  }

  if (input.decision !== "approved") {
    revalidate();
    return { ok: true, outcome: null };
  }

  // Only a capability with a provider executor runs here. A calendar change
  // has its own executor and its own screen; approving it in this queue must
  // not try to send it, and must not fail the decision either.
  const [proposal] = await db
    .select({ capability: actionProposals.capability })
    .from(actionProposals)
    .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  // A local write has no provider executor: the approval itself is the
  // whole decision, run through the domain's replay-safe apply, and the
  // approved revision becomes the record. The registry in ./local-writes is
  // the same source the card's decision-only caveat reads.
  const writer = proposal ? LOCAL_WRITERS[proposal.capability] : undefined;
  if (writer) {
    try {
      await writer.apply(auth, {
        proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
        revisionId: input.revisionId,
      });
    } catch (error) {
      revalidate();
      const message = error instanceof Error ? error.message : writer.failure;
      return { ok: false, error: message, decided: true };
    }
    revalidate();
    return { ok: true, outcome: null };
  }

  if (!proposal || !supportsEffect(proposal.capability)) {
    revalidate();
    return { ok: true, outcome: null };
  }

  let outcome: EffectOutcome | null = null;
  try {
    outcome = await executeApprovedEffect(auth, { proposalId: input.proposalId });
  } catch (error) {
    // The decision is committed; a refusal to execute is a state the card
    // must show, not a rollback of the approval. The card's client alert
    // only lives until the next render, so the refusal also lands in the
    // review history - the persisted record a reloaded card renders. No
    // attempt row: the refusal happened before any claim and the approval
    // stands. The write is serialized per proposal (the advisory-lock
    // pattern spending claims use) and deduped on the exact revision, so
    // concurrent retries cannot stack duplicate rows while a re-approval of
    // a NEW revision records its own refusal. The persisted message is the
    // bounded, printable refusal line, never a raw provider body.
    const message = refusalMessage(error);
    const note = `Execution refused: ${message}`;
    await withTransaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`refusal:${input.proposalId}`}, 0))`);
      const existing = await tx
        .select({ id: actionReviews.id })
        .from(actionReviews)
        .where(
          and(
            eq(actionReviews.proposalId, input.proposalId),
            eq(actionReviews.revisionId, input.revisionId),
            eq(actionReviews.note, note),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(actionReviews).values({
          workspaceId: auth.workspaceId,
          proposalId: input.proposalId,
          revisionId: input.revisionId,
          decision: "approved",
          note,
          reviewedBy: null,
        });
      }
    });
    revalidate();
    return { ok: false, error: message, decided: true };
  }
  revalidate();
  return { ok: true, outcome };
}

const MAX_PAYLOAD_BYTES = 100_000;

export async function reviseProposalAction(input: {
  idempotencyKey: string;
  proposalId: string;
  expectedVersion: number;
  payloadText: string;
}): Promise<Result<{ revisionId: string; revisionNumber: number; version: number }>> {
  const auth = await authorize();
  if (!UUID.test(input.proposalId) || !UUID.test(input.idempotencyKey)) {
    return { ok: false, error: "Malformed revision." };
  }
  if (input.payloadText.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: "Payload is over 100 KB. Split the proposal instead." };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.payloadText);
  } catch {
    return { ok: false, error: "Payload is not valid JSON." };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Payload must be a JSON object." };
  }
  try {
    const revised = await reviseProposal(auth, {
      idempotencyKey: input.idempotencyKey,
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      payload,
    });
    revalidate();
    return { ok: true, revisionId: revised.revisionId, revisionNumber: revised.revisionNumber, version: revised.version };
  } catch (error) {
    return fail(error);
  }
}
