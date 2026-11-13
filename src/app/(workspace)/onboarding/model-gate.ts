import { resolveRunModel } from "@/domains/agents/models";
import { AllowanceExhaustedError, ModelUnavailableError, resolveModelRoute } from "@/domains/billing/resolver";

/*
 * The interview's credential gate (QA F7). The eve runtime resolves the run's
 * model on its first turn, so an unusable model used to surface only after the
 * start had minted a run row, an eve session, and a spend reservation. Asking
 * the billing resolver here, with the same model order the runtime applies
 * (the profile's pinned primary, else the catalog default), turns that into a
 * labelled start failure whose card carries the form fallback. It answers for
 * the workspace: its own key, the house key under the free allowance, or
 * neither.
 */

export type InterviewModelGate = { ok: true } | { ok: false; message: string };

const FORM_FALLBACK = "Answer as a form instead — the four questions work without one.";

export async function interviewModelGate(workspaceId: string, modelPolicy: unknown): Promise<InterviewModelGate> {
  const model = resolveRunModel(modelPolicy);
  // A catalog without the default would be its own defect; fail open to the
  // runtime's own error rather than block onboarding on a wrong guess.
  if (!model) return { ok: true };
  try {
    await resolveModelRoute(workspaceId, model.id, "chat");
    return { ok: true };
  } catch (cause) {
    if (cause instanceof AllowanceExhaustedError) return { ok: false, message: `${cause.message} ${FORM_FALLBACK}` };
    if (cause instanceof ModelUnavailableError) {
      return { ok: false, message: `The interview needs a model, and ${cause.message} ${FORM_FALLBACK}` };
    }
    throw cause;
  }
}
