import type { AuthContext } from "@/domains/identity/resolve";
import { learningJobRunners } from "@/domains/learning/generation-jobs";
import { missionJobRunners } from "@/domains/learning/mission-jobs";
import type { GenerationJobResult } from "./schema";

/**
 * Does one job's work as its maker and says where the result lives.
 *
 * `input` is the stored jsonb, so the runner parses it. `generationKey` is
 * unique to this attempt: pass it wherever the work takes an idempotency key,
 * so a run that is delivered twice writes once. Throw GenerationJobFailure to
 * fail with copy the person can read.
 */
export type GenerationJobRunner = (
  auth: AuthContext,
  input: unknown,
  run: { generationKey: string },
) => Promise<GenerationJobResult>;

/** Every kind of generation job and the runner that does it. A new kind is one entry here. */
export function generationJobRunners(): Record<string, GenerationJobRunner> {
  return { ...learningJobRunners, ...missionJobRunners };
}
