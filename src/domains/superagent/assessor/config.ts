/**
 * The assessor's configuration, parsed from the environment at wiring time —
 * never read lazily inside a request, so a bad value fails loudly at boot
 * (the executor's slots.ts discipline).
 */
export interface AssessorConfig {
  /** The dedicated eve profile every eval session runs on. */
  profileName: string;
  /** How many eval sessions may run at once across the workspace. */
  maxConcurrent: number;
  /** The admit probability at or above which a candidate passes the seam. */
  admitThreshold: number;
  /** The spend estimate reserved for one eval session. */
  estimateUsd: string;
}

export const ASSESSOR_DEFAULTS: AssessorConfig = {
  profileName: "superagent-assessor",
  maxConcurrent: 2,
  admitThreshold: 0.5,
  estimateUsd: "0.10",
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be an integer of at least 1`);
  return parsed;
}

function fractionFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be a number between 0 and 1`);
  return parsed;
}

function stringFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = raw.trim();
  if (!parsed) throw new Error(`${name} must not be empty`);
  return parsed;
}

export function parseAssessorConfig(): AssessorConfig {
  return {
    profileName: stringFromEnv("POLYMATH_SUPERAGENT_ASSESSOR_PROFILE", ASSESSOR_DEFAULTS.profileName),
    maxConcurrent: intFromEnv("POLYMATH_SUPERAGENT_EVALS_MAX", ASSESSOR_DEFAULTS.maxConcurrent),
    admitThreshold: fractionFromEnv("POLYMATH_SUPERAGENT_DECIDE_THRESHOLD", ASSESSOR_DEFAULTS.admitThreshold),
    estimateUsd: stringFromEnv("POLYMATH_SUPERAGENT_EVAL_ESTIMATE_USD", ASSESSOR_DEFAULTS.estimateUsd),
  };
}
