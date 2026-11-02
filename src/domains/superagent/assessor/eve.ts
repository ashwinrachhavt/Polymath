/**
 * The eval seam: how the assessor sees the session runtime — the executor's
 * seam narrowed to one assessment. Four operations, no streaming, no event
 * bridging: start a create-once eval session pinned to the three eval tools,
 * carry it text, cancel it, and read back whether a session already exists
 * for the assessment (the effect replay check). The seam never decides.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import type { AgentEngine } from "@/domains/agents/engine";
import type { AuthContext } from "@/domains/identity/resolve";

/** The three tools an eval session is pinned to, frozen into its policy snapshot. */
export const EVAL_TOOLS = ["orchestrator_eval_read", "orchestrator_eval", "orchestrator_eval_decide"] as const;

/**
 * The judge's standing charter — the profile's own instructions. The bounded
 * candidate and the ported precedence order ride the per-eval brief instead,
 * so this says nothing about any candidate, only how to judge.
 */
export const ASSESSOR_CHARTER = [
  "You are the assessor. You judge whether one request should become work.",
  "Read the candidate with orchestrator_eval_read, record a judgment with orchestrator_eval, and finish with orchestrator_eval_decide.",
  "Judge only what the read tool shows you; do not invent context.",
  "Every judgment names a reason. An accept names a short title and a concrete scope.",
].join(" ");

/**
 * Materializes the dedicated assessor profile on first use. Exact-name lookup
 * only — `ensureProfile`'s first-profile fallback would bind eval sessions to
 * an arbitrary existing profile, and a judge that inherits someone else's
 * ceiling is not a judge. The profile's tool ceiling is the eval tools; each
 * run pins them again in its own snapshot.
 */
async function ensureAssessorProfile(workspaceId: string, profileName: string): Promise<void> {
  const [existing] = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, workspaceId), eq(agentProfiles.name, profileName)))
    .limit(1);
  if (existing) return;
  await db
    .insert(agentProfiles)
    .values({
      workspaceId,
      name: profileName,
      description: "The superagent assessor: judges admission candidates through the three eval tools.",
      instructions: ASSESSOR_CHARTER,
      allowedTools: [...EVAL_TOOLS],
    })
    .onConflictDoNothing({ target: [agentProfiles.workspaceId, agentProfiles.name] });
}

export type EvalRunState = (typeof agentRuns.$inferSelect)["state"];

/** The slice of an agent run row the assessor reads back. */
export interface LiveEval {
  agentRunId: string;
  state: EvalRunState;
}

export interface EveForAssessor {
  /** The newest agent run for this assessment in any state — the replay check reads it. */
  lastEval(input: { workspaceId: string; assessmentId: string }): Promise<LiveEval | undefined>;
  /** Start one create-once eval session; its brief opens the session's first turn. */
  start(input: {
    workspaceId: string;
    auth: AuthContext;
    assessmentId: string;
    objective: string;
    profileName: string;
    estimateUsd: string;
    allowedTools: string[];
  }): Promise<{ agentRunId: string }>;
  /** Carry text to the eval session between tool calls. */
  signal(input: { workspaceId: string; auth: AuthContext; agentRunId: string; text: string }): Promise<void>;
  /** Cancel the eval session; the conditional write makes two cancels safe. */
  cancel(input: { workspaceId: string; auth: AuthContext; agentRunId: string }): Promise<{ cancelled: boolean }>;
}

/**
 * Subjects carry the domain ownership of the agent run: one run belongs to
 * one assessment, so any consumer can trace a run back to the trigger it
 * judged and the panel can show which sessions ran.
 */
function assessmentSubjects(assessmentId: string): { type: string; id: string }[] {
  return [{ type: "superagent_assessment", id: assessmentId }];
}

/** The real seam over the AgentEngine and the run table. */
export function createEvalSeam(engine: AgentEngine): EveForAssessor {
  const byAssessment = async (workspaceId: string, assessmentId: string): Promise<LiveEval | undefined> => {
    const rows = await db
      .select({ id: agentRuns.id, state: agentRuns.state })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspaceId, workspaceId),
          sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "superagent_assessment", id: assessmentId }])}::jsonb`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? { agentRunId: row.id, state: row.state } : undefined;
  };

  return {
    lastEval: ({ workspaceId, assessmentId }) => byAssessment(workspaceId, assessmentId),
    start: async ({ workspaceId, auth, assessmentId, objective, profileName, estimateUsd, allowedTools }) => {
      // The dedicated profile materializes on first use; idempotent thereafter.
      await ensureAssessorProfile(workspaceId, profileName);
      const { runId: agentRunId } = await engine.start({
        auth,
        profileName,
        objective,
        subjects: assessmentSubjects(assessmentId),
        estimateUsd,
        // The eval tools are the whole session: a profile's own ceiling could
        // widen later without a code change, so the pin rides every start and
        // is frozen into the policy snapshot like the profile's own list.
        allowedTools,
        // The brief is run machinery — the bounded candidate — not a person's
        // words; it opens the session's first turn out of any chat transcript.
        objectiveInternal: true,
      });
      return { agentRunId };
    },
    signal: ({ auth, agentRunId, text }) => engine.signal(agentRunId, text, auth),
    cancel: ({ auth, agentRunId }) => engine.cancel(agentRunId, auth),
  };
}
