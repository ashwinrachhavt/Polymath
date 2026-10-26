"use server";

import { revalidatePath } from "next/cache";
import { acceptProposalAction, rejectProposalAction } from "@/app/(workspace)/command-center/inbox/actions";
import { decideProposalAction } from "@/app/(workspace)/reviews/actions";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * ASH-309: one-tap decisions from the homepage. These delegate to the same
 * guarded actions the owning surfaces run - an agent approval binds the
 * exact revision the card rendered (CAS on version + revision id), a capture
 * decision runs the same accept/reject path the inbox runs - then revalidate
 * the queue. Nothing here is a second, weaker path.
 */

export async function decideHomeAgentAction(input: {
  idempotencyKey: string;
  proposalId: string;
  expectedVersion: number;
  revisionId: string;
  decision: "approved" | "rejected";
}) {
  // A decision is a write: membership alone is never enough, here or in the
  // delegated action (both guard; the sweep reads this one).
  requireRole(await getAuthContext(), "member");
  const result = await decideProposalAction(input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function decideHomeCaptureAction(input: { proposalId: string; decision: "accepted" | "rejected" }) {
  requireRole(await getAuthContext(), "member");
  const result =
    input.decision === "accepted"
      ? await acceptProposalAction({ proposalId: input.proposalId })
      : await rejectProposalAction({ proposalId: input.proposalId });
  if (result.ok) revalidatePath("/");
  return result;
}
