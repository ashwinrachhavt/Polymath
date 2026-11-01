import { modelById, resolveModelId } from "@/domains/agents/models";

/*
 * The interview's credential gate (QA F7). The eve runtime resolves the run's
 * model on its first turn, so an unconfigured provider key used to surface
 * only after the start had minted a run row, an eve session, and a spend
 * reservation — the interview died mid-conversation with the profile already
 * created. Resolving here the same model the runtime would resolve (the
 * profile's pinned primary, else the catalog default) turns that into a
 * labelled start failure whose card carries the form fallback.
 *
 * Pure by design: the profile's model_policy comes in as an argument, so the
 * gate is unit-testable without a database.
 */

export type InterviewModelGate = { ok: true } | { ok: false; message: string };

export function interviewModelGate(
  modelPolicy: unknown,
  env: Record<string, string | undefined> = process.env,
): InterviewModelGate {
  const primary =
    typeof modelPolicy === "object" && modelPolicy !== null
      ? (modelPolicy as { primary?: unknown }).primary
      : null;
  // A missing or unrecognized pin resolves to the catalog default — the same
  // fallback the runtime applies, which is why the keyless harness failed on
  // "Gemini 3.5 Flash Lite" rather than on an unknown-model error.
  const model = modelById(resolveModelId(primary));
  // A catalog without the default would be its own defect; fail open to the
  // runtime's own error rather than block onboarding on a wrong guess.
  if (!model) return { ok: true };
  const key = env[model.keyEnv];
  if (typeof key === "string" && key.trim().length > 0) return { ok: true };
  return {
    ok: false,
    message: `The interview needs a model, and this deployment has no ${model.keyEnv}, so the agent cannot speak. Answer as a form instead — the four questions work without one.`,
  };
}
