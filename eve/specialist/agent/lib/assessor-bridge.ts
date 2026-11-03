import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
// Type-only: the wiring shape reaches this bundle at build time and is erased
// before the eve agent boots.
import type { SuperagentAssessor } from "../../../../src/domains/superagent/assessor";
import { superagentForWorkspace } from "../../../../src/domains/superagent/wiring";
import { toolAllowed } from "./policy";

/*
 * How an eval session reaches the assessor. The session runs on the
 * specialist agent, but the assessor — its tools, its Engine, its Mercury
 * client — is composed per workspace by the app's own wiring (cached per
 * process, so every tool call of one session resolves the same composition
 * and `orchestrator_eval`'s in-memory judgment is visible to
 * `orchestrator_eval_decide`). Authorization is the run's frozen policy
 * snapshot: only a run pinned to the orchestrator_eval* tools may call them,
 * so no other specialist run sees a usable path into admission decisions.
 *
 * The run's subject marker (`superagent_assessment`) is what the eval seam
 * stamps onto every eval run it starts (assessor/eve.ts) — the same marker
 * the panel reads, so a tool call can only ever land on the assessment the
 * session itself belongs to.
 */

/** The run-subject marker the eval seam stamps onto its runs. */
export const ASSESSMENT_SUBJECT_TYPE = "superagent_assessment";

/** The slice of an eve session this bridge reads (workspace from auth attributes, run id from the session). */
interface BridgeSession {
  id: string;
  auth: { current: { attributes?: { workspaceId?: unknown } } | null };
}

export type ResolvedAssessment =
  { ok: true; assessmentId: string; assessor: SuperagentAssessor } | { ok: false; error: string };

/**
 * Resolve the one assessment this session may judge. Every capability check
 * happens here, before any tool body runs; the caller returns the error
 * result as-is rather than improvising its own.
 */
export async function resolveAssessment(session: BridgeSession, capability: string): Promise<ResolvedAssessment> {
  const workspaceId = session.auth.current?.attributes?.workspaceId;
  if (typeof workspaceId !== "string") return { ok: false, error: "no workspace in session" };

  const run = await getRunBySessionRef(session.id, workspaceId);
  if (!run) return { ok: false, error: "no Polymath run bound to this session" };
  if (!toolAllowed(run.policySnapshot, capability)) {
    return { ok: false, error: `${capability} is not in this run's policy snapshot` };
  }

  const assessmentId = ((run.subjects ?? []) as { type?: string; id?: string }[]).find(
    (subject) => subject?.type === ASSESSMENT_SUBJECT_TYPE,
  )?.id;
  if (typeof assessmentId !== "string" || assessmentId.length === 0) {
    return { ok: false, error: "this session is not bound to an admission assessment" };
  }

  // The composition reads the domain store, which caches in memory: hydrate
  // so the candidate this session judges comes from the database, not from a
  // cold cache that would read as "no such assessment".
  const host = await superagentForWorkspace(workspaceId);
  await host.hydrate();
  return { ok: true, assessmentId, assessor: host.assessor };
}
