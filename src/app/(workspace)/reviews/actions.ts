"use server";

import { revalidatePath } from "next/cache";
import { decideProposal, reviseProposal } from "@/domains/actions/commands";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Reviews decisions (canonical queue). Every write carries the idempotency
 * key the card minted on first click (retries replay, never double-decide),
 * the version the card rendered, and - for a decision - the exact revision
 * the owner inspected. Nothing here executes the proposal.
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

export async function decideProposalAction(input: {
  idempotencyKey: string;
  proposalId: string;
  expectedVersion: number;
  revisionId: string;
  decision: "approved" | "rejected";
  note?: string;
}): Promise<Result> {
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
    return fail(error);
  }
  revalidate();
  return { ok: true };
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
