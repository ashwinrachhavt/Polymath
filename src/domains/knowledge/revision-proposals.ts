import { and, desc, eq } from "drizzle-orm";
import { toolAllowed } from "../../../eve/alfred/agent/lib/policy";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import { NON_TERMINAL_RUN_STATES } from "@/domains/actions/executor";
import { getRunForGateway } from "@/domains/agents/queries";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { claimAttempt, AttemptAlreadyClaimedError, findClaimedAttempt, settleAttempt } from "@/domains/actions/attempts";
import { artifacts, artifactVersions } from "./schema";

/*
 * AI changes to a saved artifact arrive as proposals, never as edits. A run
 * that wants to revise a reviewed artifact proposes the new content against
 * the version it read; the owner approves in Reviews, and only then a new
 * version is appended. Two rules keep the person's judgment separate from
 * the AI draft on one record: versions stay append-only (the person's words
 * are never overwritten), and a proposal whose base version is no longer
 * current refuses at execution, because approving a change to words that
 * have since changed is approving a different change.
 */

const ARTIFACT_REVISE_CAPABILITY = "artifacts.revise";

export type ArtifactRevisionPayload = {
  artifactId: string;
  baseVersionId: string;
  content: Record<string, unknown>;
  plainText?: string;
  note?: string;
};

export class ArtifactReviseNotAllowedError extends Error {
  readonly code = "artifact_revise_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "ArtifactReviseNotAllowedError";
  }
}

/** Agent entry point. `dedupeKey` is the agent's own intent key; replays resolve the same proposal. */
export async function proposeArtifactRevision(
  auth: Pick<AuthContext, "workspaceId"> & { userId?: string | null },
  input: { artifactId: string; content: Record<string, unknown>; plainText?: string; note?: string; dedupeKey: string; runId?: string | null },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const [artifact] = await db
    .select({ id: artifacts.id, title: artifacts.title, status: artifacts.status, currentVersionId: artifacts.currentVersionId })
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!artifact) throw new ArtifactReviseNotAllowedError("That artifact does not exist in this workspace.");
  if (artifact.status === "archived") throw new ArtifactReviseNotAllowedError("An archived artifact takes no revisions.");
  if (!artifact.currentVersionId) throw new ArtifactReviseNotAllowedError("That artifact has no version to revise against.");
  const baseVersionId = artifact.currentVersionId;

  return withTransaction(async (tx) => {
    const result = await createProposal(tx, auth, {
      capability: ARTIFACT_REVISE_CAPABILITY,
      riskClass: "prepare",
      targetType: "artifact",
      targetId: artifact.id,
      title: `Revise: ${artifact.title}`,
      expectedEffect: `Appends the proposed content as a new version of "${artifact.title}". The current version is kept; nothing is overwritten.`,
      dedupeKey: `artifacts:${input.dedupeKey}`,
      runId: input.runId ?? null,
    });
    if (!result.deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: result.proposalId,
        revisionNumber: 1,
        payload: {
          artifactId: artifact.id,
          baseVersionId,
          content: input.content,
          ...(input.plainText ? { plainText: input.plainText } : {}),
          ...(input.note ? { note: input.note } : {}),
        } satisfies ArtifactRevisionPayload,
        preview: { title: artifact.title, note: input.note ?? null },
        createdBy: auth.userId ?? null,
      });
    }
    return result;
  });
}

async function prepare(auth: AuthContext, proposalId: string): Promise<void> {
  const [proposal] = await db
    .select({
      capability: actionProposals.capability,
      runId: actionProposals.runId,
      expiresAt: actionProposals.expiresAt,
    })
    .from(actionProposals)
    .where(and(eq(actionProposals.id, proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!proposal) throw new ArtifactReviseNotAllowedError("That proposal does not exist in this workspace.");
  if (proposal.capability !== ARTIFACT_REVISE_CAPABILITY) {
    throw new ArtifactReviseNotAllowedError("That proposal is not an artifact revision.");
  }
  if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
    throw new ArtifactReviseNotAllowedError("This proposal expired before it was executed.");
  }

  if (proposal.runId) {
    const run = await getRunForGateway(proposal.runId, auth.workspaceId);
    if (!run) throw new ArtifactReviseNotAllowedError("The run that proposed this revision no longer exists.");
    if (!NON_TERMINAL_RUN_STATES.has(run.state)) {
      throw new ArtifactReviseNotAllowedError("The run that proposed this revision is no longer active.");
    }
    if (!toolAllowed(run.policySnapshot, ARTIFACT_REVISE_CAPABILITY)) {
      throw new ArtifactReviseNotAllowedError(`The run's policy snapshot does not include ${ARTIFACT_REVISE_CAPABILITY}.`);
    }
  }
}

export type RevisionOutcome =
  | { status: "executed"; versionId: string }
  | { status: "unknown"; reconciliationId: string };

/** The outcome a prior attempt already settled on; a claimed-but-unsettled row is UNKNOWN. */
async function claimedOutcome(auth: AuthContext, proposalId: string): Promise<RevisionOutcome | null> {
  const [prior] = await db
    .select()
    .from(actionAttempts)
    .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposalId)))
    .orderBy(desc(actionAttempts.attemptNumber))
    .limit(1);
  if (!prior) return null;
  if (prior.status === "unknown") return { status: "unknown", reconciliationId: prior.id };
  if (prior.status === "succeeded" && prior.providerObjectId) {
    return { status: "executed", versionId: prior.providerObjectId };
  }
  // A failed attempt is a definitive refusal; the command is replay-safe, so a
  // later approval may try again. An unresolved one never does.
  return null;
}

async function claim(auth: AuthContext, proposalId: string, revisionId: string): Promise<{ attemptId: string } | { prior: RevisionOutcome }> {
  const prior = await claimedOutcome(auth, proposalId);
  if (prior) return { prior };

  const idempotencyKey = `artifacts-exec:${proposalId}`;
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
function parsePayload(payload: unknown): ArtifactRevisionPayload {
  const p = payload as ArtifactRevisionPayload;
  if (!p || typeof p.artifactId !== "string" || typeof p.baseVersionId !== "string" || !p.content || typeof p.content !== "object" || Array.isArray(p.content)) {
    throw new ArtifactReviseNotAllowedError("The approved payload is not a valid artifact revision.");
  }
  return p;
}

/*
 * Phase two: claim, append, settle. The base-version check lives inside the
 * write transaction so a person editing between approval and execution turns
 * the approval into a named refusal, never a silent clobber.
 */
async function execute(auth: AuthContext, proposalId: string, revisionId: string, payload: ArtifactRevisionPayload): Promise<RevisionOutcome> {
  await prepare(auth, proposalId);

  const claimed = await claim(auth, proposalId, revisionId);
  if ("prior" in claimed) return claimed.prior;
  const { attemptId } = claimed;

  let versionId: string | null = null;
  let refused: ArtifactReviseNotAllowedError | null = null;
  let ambiguous: Error | null = null;
  try {
    versionId = await withTransaction(async (tx) => {
      const [artifact] = await tx
        .select({ currentVersionId: artifacts.currentVersionId, title: artifacts.title, status: artifacts.status })
        .from(artifacts)
        .where(and(eq(artifacts.id, payload.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!artifact) throw new ArtifactReviseNotAllowedError("That artifact does not exist in this workspace.");
      if (artifact.status === "archived") throw new ArtifactReviseNotAllowedError("An archived artifact takes no revisions.");
      if (artifact.currentVersionId !== payload.baseVersionId) {
        throw new ArtifactReviseNotAllowedError(
          "The artifact changed after this revision was proposed. Re-read the current version and propose again.",
        );
      }
      const [last] = await tx
        .select({ n: artifactVersions.versionNumber })
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, payload.artifactId), eq(artifactVersions.workspaceId, auth.workspaceId)))
        .orderBy(desc(artifactVersions.versionNumber))
        .limit(1);
      const [version] = await tx
        .insert(artifactVersions)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: payload.artifactId,
          versionNumber: (last?.n ?? 0) + 1,
          content: payload.content,
          plainText: payload.plainText ?? null,
          reason: "edited",
          note: payload.note ?? `Proposed revision${proposalId ? ` (proposal ${proposalId})` : ""}`,
          createdBy: auth.userId,
        })
        .returning({ id: artifactVersions.id });
      await tx
        .update(artifacts)
        .set({ currentVersionId: version.id, embedError: null })
        .where(and(eq(artifacts.id, payload.artifactId), eq(artifacts.workspaceId, auth.workspaceId)));
      await recordAudit(
        auth,
        {
          action: "artifact.revision.approved",
          subjectType: "artifact",
          subjectId: payload.artifactId,
          summary: `Approved a proposed revision of "${artifact.title}"`,
        },
        tx,
      );
      return version.id;
    });
  } catch (error) {
    if (error instanceof ArtifactReviseNotAllowedError) {
      refused = error;
    } else {
      // The append may have committed and lost its reply. Settling failed
      // would invite a retry on a guess; UNKNOWN cannot double-append.
      ambiguous = error instanceof Error ? error : new Error("Unknown artifact failure.");
    }
  }

  await withTransaction(async (tx) => {
    if (versionId) {
      await settleAttempt(tx, { attemptId, outcome: "succeeded", providerObjectId: versionId });
      return;
    }
    if (refused) {
      await settleAttempt(tx, { attemptId, outcome: "failed", errorCode: refused.code });
      return;
    }
    await settleAttempt(tx, {
      attemptId,
      outcome: "unknown",
      errorCode: "artifact_outcome_unknown",
      responseSummary: { message: ambiguous?.message ?? "The command did not answer." },
    });
  });

  if (refused) throw refused;
  if (versionId) return { status: "executed", versionId };
  return { status: "unknown", reconciliationId: attemptId };
}

/** One-tap approve: records the decision, then runs the approved revision. Safe to call again after a crash. */
export async function approveArtifactRevision(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<RevisionOutcome> {
  try {
    await decideProposal(auth, {
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      decision: "approved",
      idempotencyKey: `artifacts-decide:${input.proposalId}`,
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
  if (!revision) throw new Error("revision not found");
  return execute(auth, input.proposalId, input.revisionId, parsePayload(revision.payload));
}
