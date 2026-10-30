import { and, desc, eq } from "drizzle-orm";
import { toolAllowed } from "../../../eve/polymath/agent/lib/policy";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import { NON_TERMINAL_RUN_STATES } from "@/domains/actions/executor";
import { getRunForGateway } from "@/domains/agents/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { claimAttempt, AttemptAlreadyClaimedError, findClaimedAttempt, settleAttempt } from "@/domains/actions/attempts";
import { createNoteInTx } from "./notes";

/*
 * Proposed notes. This mirrors the task-proposal path in work/proposals.ts
 * deliberately: a run (or an owner-invoked batch such as a meeting debrief)
 * cannot write a note itself, so the note lands in the review queue and
 * approval runs the exact approved revision through the same claim/settle
 * discipline. A retried approval must never create the note twice.
 *
 * The claim/settle machinery is duplicated rather than extracted because the
 * task path is proven under load; extracting a shared module is a follow-up
 * that should not ride on a new capability.
 */

const NOTES_PROPOSE_CAPABILITY = "notes.create";

export class NoteExecuteNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteExecuteNotAllowedError";
  }
}

export type NoteProposalPayload = {
  title: string;
  /** Markdown body. Rendered plain text is derived from it at execute time. */
  markdown: string;
};

/** Agent entry point. `dedupeKey` is the caller's own intent key; replays resolve the same proposal. */
export async function proposeNote(
  auth: Pick<AuthContext, "workspaceId"> & { userId?: string | null },
  input: NoteProposalPayload & { dedupeKey: string; runId?: string | null },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const title = input.title.trim().slice(0, 500);
  const markdown = input.markdown.slice(0, 50_000);
  return withTransaction(async (tx) => {
    const result = await createProposal(tx, auth, {
      capability: NOTES_PROPOSE_CAPABILITY,
      riskClass: "prepare",
      targetType: "note",
      title: `Add note: ${title}`,
      expectedEffect: `Creates the note "${title}" in your notes.`,
      dedupeKey: `notes:${input.dedupeKey}`,
      runId: input.runId ?? null,
    });
    if (!result.deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: result.proposalId,
        revisionNumber: 1,
        payload: { title, markdown },
        preview: { title, markdown },
        createdBy: auth.userId ?? null,
      });
    }
    return result;
  });
}

/*
 * Every check that can refuse, before an intent is claimed. Identical shape
 * to the task checkpoint: owner-created proposals carry no run to honour; an
 * agent-created one is checked against the run's frozen snapshot and state.
 */
async function prepare(auth: AuthContext, proposalId: string): Promise<void> {
  const [proposal] = await db
    .select({
      capability: actionProposals.capability,
      runId: actionProposals.runId,
      status: actionProposals.status,
      expiresAt: actionProposals.expiresAt,
    })
    .from(actionProposals)
    .where(and(eq(actionProposals.id, proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!proposal) throw new NoteExecuteNotAllowedError("That proposal does not exist in this workspace.");
  if (proposal.capability !== NOTES_PROPOSE_CAPABILITY) {
    throw new NoteExecuteNotAllowedError("That proposal is not a note proposal.");
  }
  if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
    throw new NoteExecuteNotAllowedError("This proposal expired before it was executed.");
  }

  if (proposal.runId) {
    const run = await getRunForGateway(proposal.runId, auth.workspaceId);
    if (!run) throw new NoteExecuteNotAllowedError("The run that proposed this note no longer exists.");
    if (!NON_TERMINAL_RUN_STATES.has(run.state)) {
      throw new NoteExecuteNotAllowedError("The run that proposed this note is no longer active.");
    }
    if (!toolAllowed(run.policySnapshot, NOTES_PROPOSE_CAPABILITY)) {
      throw new NoteExecuteNotAllowedError(`The run's policy snapshot does not include ${NOTES_PROPOSE_CAPABILITY}.`);
    }
  }
}

export type NoteOutcome =
  | { status: "executed"; artifactId: string }
  | { status: "unknown"; reconciliationId: string };

/** The outcome a prior attempt already settled on; a claimed-but-unsettled row is UNKNOWN. */
async function claimedOutcome(auth: AuthContext, proposalId: string): Promise<NoteOutcome | null> {
  const [prior] = await db
    .select()
    .from(actionAttempts)
    .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposalId)))
    .orderBy(desc(actionAttempts.attemptNumber))
    .limit(1);
  if (!prior) return null;
  if (prior.status === "unknown") return { status: "unknown", reconciliationId: prior.id };
  if (prior.status === "succeeded" && prior.providerObjectId) {
    return { status: "executed", artifactId: prior.providerObjectId };
  }
  // A failed attempt is a definitive refusal; the command is replay-safe, so
  // a later approval may try again. An unresolved one never does.
  return null;
}

async function claim(auth: AuthContext, proposalId: string, revisionId: string): Promise<{ attemptId: string } | { prior: NoteOutcome }> {
  const prior = await claimedOutcome(auth, proposalId);
  if (prior) return { prior };

  const idempotencyKey = `notes-exec:${proposalId}`;
  try {
    const claimed = await withTransaction(async (tx) => {
      const [latest] = await tx
        .select({ attemptNumber: actionAttempts.attemptNumber })
        .from(actionAttempts)
        .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposalId)))
        .orderBy(desc(actionAttempts.attemptNumber))
        .limit(1);
      return claimAttempt(tx, {
        workspaceId: auth.workspaceId,
        proposalId,
        revisionId,
        idempotencyKey,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
      });
    });
    return { attemptId: claimed.attemptId };
  } catch (error) {
    if (!(error instanceof AttemptAlreadyClaimedError)) throw error;
    const winner = await withTransaction((tx) => findClaimedAttempt(tx, auth.workspaceId, idempotencyKey));
    return { prior: { status: "unknown", reconciliationId: winner?.id ?? proposalId } };
  }
}

/* The owner may revise the payload as free JSON, so execute re-validates. */
function parsePayload(payload: unknown): NoteProposalPayload {
  const p = payload as NoteProposalPayload;
  if (!p || typeof p.title !== "string" || !p.title.trim()) {
    throw new NoteExecuteNotAllowedError("The approved payload is not a valid note.");
  }
  if (typeof p.markdown !== "string" || !p.markdown.trim()) {
    throw new NoteExecuteNotAllowedError("The approved payload has no note body.");
  }
  return p;
}

/*
 * Markdown to the plain-text mirror artifactVersions carries. The note body
 * is stored as markdown source; the plainText column stays searchable, so
 * strip the lightest formatting rather than storing markup in it.
 */
function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
 * Phase two: claim, create, settle. createNoteInTx is a local transaction
 * rather than a provider call, but the discipline is the same: a claimed row
 * that never settles is UNKNOWN, and a retry reads that row instead of
 * creating a second note on a guess.
 */
async function execute(auth: AuthContext, proposalId: string, revisionId: string, payload: NoteProposalPayload): Promise<NoteOutcome> {
  await prepare(auth, proposalId);

  const claimed = await claim(auth, proposalId, revisionId);
  if ("prior" in claimed) return claimed.prior;
  const { attemptId } = claimed;

  let artifactId: string | null = null;
  let refused: Error | null = null;
  let ambiguous: Error | null = null;
  try {
    const note = await withTransaction(async (tx) =>
      createNoteInTx(tx, auth, {
        title: payload.title.trim(),
        plainText: plainTextFromMarkdown(payload.markdown),
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: payload.markdown }] }] },
      }),
    );
    artifactId = note.id;
  } catch (error) {
    // createNoteInTx refuses on nothing user-supplied except malformed input;
    // a validation throw is a refusal. Anything else may have committed and
    // lost its reply, so it settles UNKNOWN rather than failed.
    if (error instanceof Error && /invalid|violates|malformed/i.test(error.message)) {
      refused = error;
    } else {
      ambiguous = error instanceof Error ? error : new Error("Unknown note failure.");
    }
  }

  await withTransaction(async (tx) => {
    if (artifactId) {
      await settleAttempt(tx, { attemptId, outcome: "succeeded", providerObjectId: artifactId });
      return;
    }
    if (refused) {
      await settleAttempt(tx, { attemptId, outcome: "failed", errorCode: "command_refused" });
      return;
    }
    await settleAttempt(tx, {
      attemptId,
      outcome: "unknown",
      errorCode: "note_outcome_unknown",
      responseSummary: { message: ambiguous?.message ?? "The command did not answer." },
    });
  });

  if (refused) throw refused;
  if (artifactId) return { status: "executed", artifactId };
  return { status: "unknown", reconciliationId: attemptId };
}

/** One-tap approve: records the decision, then runs the approved revision. Safe to call again after a crash. */
export async function approveNoteProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<NoteOutcome> {
  try {
    await decideProposal(auth, {
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      decision: "approved",
      idempotencyKey: `notes-decide:${input.proposalId}`,
    });
  } catch (error) {
    // Already approved (a retry): fall through to the replay-safe execution.
    if (!(error instanceof ProposalConflictError)) throw error;
    const [p] = await db
      .select({ status: actionProposals.status })
      .from(actionProposals)
      .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (p?.status !== "approved") throw error;
  }
  const [revision] = await db
    .select({ payload: actionRevisions.payload })
    .from(actionRevisions)
    .where(and(eq(actionRevisions.id, input.revisionId), eq(actionRevisions.workspaceId, auth.workspaceId)))
    .orderBy(desc(actionRevisions.revisionNumber))
    .limit(1);
  if (!revision) throw new NoteExecuteNotAllowedError("The approved revision no longer exists.");
  return execute(auth, input.proposalId, input.revisionId, parsePayload(revision.payload));
}
