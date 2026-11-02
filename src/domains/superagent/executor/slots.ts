/** Worker slots, as pure admission rules: how many ticket runs may execute at once, and the spare slot a person's message can always use. */
import { latestRun, type Ticket, type Trigger } from "../core/model";

export interface ExecutorConfig {
  /** The eve agent profile ticket runs execute under. */
  profileName: string;
  /**
   * The most ticket runs that may execute at once. One of them is the spare
   * slot: a launch caused by a person's message may take it even when every
   * other slot is busy, so a person is never queued behind the agent's own
   * work. At least 2 — with one slot there is nothing to spare.
   */
  maxRunning: number;
  /** The spend reservation per run, before anything executes (settled at close by the run bridge). */
  estimateUsd: string;
}

export const EXECUTOR_DEFAULTS: ExecutorConfig = {
  profileName: "polymath",
  maxRunning: 2,
  estimateUsd: "0.25",
};

/**
 * The executor's settings, read once at wiring time. Invalid configuration
 * throws here rather than surfacing as a failed run at first launch: the
 * process cannot start at all if its slot rules are unintelligible.
 */
export function parseExecutorConfig(env: Record<string, string | undefined> = process.env): ExecutorConfig {
  let maxRunning = EXECUTOR_DEFAULTS.maxRunning;
  const rawMax = env.POLYMATH_SUPERAGENT_MAX_RUNNING;
  if (rawMax !== undefined && rawMax !== "") {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed)) {
      throw new Error(`POLYMATH_SUPERAGENT_MAX_RUNNING must be an integer, got ${JSON.stringify(rawMax)}`);
    }
    maxRunning = parsed;
  }
  if (maxRunning < 2) {
    throw new Error(
      "POLYMATH_SUPERAGENT_MAX_RUNNING must be at least 2: one working slot, and the spare a person's message can always use.",
    );
  }
  const profileName = env.POLYMATH_SUPERAGENT_PROFILE?.trim() || EXECUTOR_DEFAULTS.profileName;
  const estimateUsd = env.POLYMATH_SUPERAGENT_ESTIMATE_USD?.trim() || EXECUTOR_DEFAULTS.estimateUsd;
  if (!/^\d+(\.\d+)?$/.test(estimateUsd)) {
    throw new Error(
      `POLYMATH_SUPERAGENT_ESTIMATE_USD must be a decimal amount in dollars, got ${JSON.stringify(estimateUsd)}`,
    );
  }
  return { profileName, maxRunning, estimateUsd };
}

/**
 * Whether this ticket's launch is a person's wake — the spare slot's tenant. A
 * person's undelivered message waits on the run, or the person is retrying
 * work that reported blocked or failed (only a person can retry a ticket).
 * Context-only inputs, read for background on a thread the ticket follows,
 * are not the person talking to the ticket and do not qualify.
 */
export function spareEligible(
  ticket: Ticket,
  triggerOf: (id: string) => Trigger | undefined = () => undefined,
): boolean {
  // The person's message that opened the ticket still waits on its first run:
  // create carries the origin in the objective, not as an input.
  if (triggerOf(ticket.origin.triggerId)?.human) return true;
  const humanWaits = ticket.inputs.some(
    (input) => input.kind === "trigger" && input.human && !input.context && ticket.undelivered.includes(input.id),
  );
  if (humanWaits) return true;
  const report = latestRun(ticket)?.report;
  return report?.state === "blocked" || report?.state === "failed";
}

/** Whether a launch may start now, given how many ticket runs are already executing. */
export type LaunchAdmission = "admit" | "defer";

/**
 * The spare-slot rule as one comparison. Regular launches queue once only
 * `maxRunning - 1` slots are busy — the last free slot is held for a person —
 * and a personal launch may take it. The count comes from the domain's own
 * state at drain time, so the rule is durable (a deferred launch re-drives
 * from the effect queue) and reads the same in every process.
 */
export function admission(runningCount: number, personal: boolean, maxRunning: number): LaunchAdmission {
  return runningCount < (personal ? maxRunning : maxRunning - 1) ? "admit" : "defer";
}
