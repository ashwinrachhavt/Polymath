import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProfiles, agentQuestions, agentRuns } from "./schema";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { toolDescription, toolLabel } from "./tool-labels";

/*
 * What the conversation surface needs about the run's actor: who it is, the
 * procedure it was given, and the tools its frozen snapshot allows.
 *
 * The profile is read for its instructions only. The model and the tool list
 * come from `agent_runs.policy_snapshot`, because a profile edited after the
 * run started must not change the story of what produced this answer.
 */

export type RunAgent = {
  name: string;
  model: string | null;
  instructions: string | null;
  /**
   * `id` is the raw capability name and is the list's identity. `name` is the
   * product-words label, which is not unique — several distinct tools share one
   * label ("Checked the wiki"), so keying a list by it rendered duplicate keys.
   */
  tools: { id: string; name: string; description: string | null }[];
};

export async function getRunAgent(workspaceId: string, runId: string): Promise<RunAgent | null> {
  const [row] = await db
    .select({
      model: agentRuns.model,
      policySnapshot: agentRuns.policySnapshot,
      profileName: agentProfiles.name,
      instructions: agentProfiles.instructions,
    })
    .from(agentRuns)
    .leftJoin(agentProfiles, eq(agentProfiles.id, agentRuns.agentProfileId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;

  const snapshot = (row.policySnapshot ?? {}) as { profileId?: unknown; allowedTools?: unknown };
  const allowed = Array.isArray(snapshot.allowedTools)
    ? snapshot.allowedTools.filter((tool): tool is string => typeof tool === "string")
    : [];

  return {
    name: row.profileName ?? "Polymath",
    model: row.model,
    instructions: row.instructions,
    // One entry per capability, named in product words. The catalog never
    // decides what may run — the snapshot does — so an unknown name is listed
    // rather than dropped: hiding a capability would misrepresent the run.
    //
    // Deduped on the raw name: a snapshot can allow the same capability twice
    // (a profile edited to add a tool it already had), and two identical rows
    // tell the reader nothing.
    tools: [...new Set(allowed)].map((raw) => ({
      id: raw,
      name: toolLabel(raw),
      description: toolDescription(raw),
    })),
  };
}

/** The run's oldest unanswered question, if it is waiting on one. */
export async function getOpenQuestion(workspaceId: string, runId: string) {
  const [row] = await db
    .select({
      id: agentQuestions.id,
      question: agentQuestions.question,
      context: agentQuestions.context,
      options: agentQuestions.options,
    })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        eq(agentQuestions.runId, runId),
        eq(agentQuestions.state, "open"),
      ),
    )
    .orderBy(desc(agentQuestions.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    context: row.context,
    options: Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === "string") : [],
  };
}

/**
 * The run's pending proposals. A run that wants to change something outside the
 * workspace stops here until the owner decides; the conversation shows the
 * first one and links to the full review.
 */
export async function listRunPendingProposals(workspaceId: string, runId: string) {
  return db
    .select({
      id: actionProposals.id,
      title: actionProposals.title,
      expectedEffect: actionProposals.expectedEffect,
      riskClass: actionProposals.riskClass,
      revisionId: actionRevisions.id,
      version: actionProposals.version,
    })
    .from(actionProposals)
    .leftJoin(actionRevisions, eq(actionRevisions.proposalId, actionProposals.id))
    .where(
      and(
        eq(actionProposals.workspaceId, workspaceId),
        eq(actionProposals.runId, runId),
        eq(actionProposals.status, "pending"),
      ),
    )
    .orderBy(desc(actionProposals.createdAt))
    .limit(5);
}
