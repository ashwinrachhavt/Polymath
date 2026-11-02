import { redactText } from "./event-bridge";

/*
 * The event bridge's fail-loud bookkeeping. `guarded()` in the eve hooks keeps
 * a mirror write from ever breaking the user's turn, but a swallowed failure
 * is an invisible one: usage that never reached the ledger, a close that
 * never settled. A guarded failure is therefore logged as one structured,
 * redacted line (a log drain can alert on it) and counted. No outbox this
 * round — the payload is not replayable, dedupe makes a re-emit harmless, and
 * the stuck-reservation reconciler heals the residue (locked decision).
 */

let failureCount = 0;

/**
 * Records one guarded bridge failure: counts it and emits a single
 * structured, redacted error line. Returns the running count.
 */
export function reportBridgeFailure(label: string, cause: unknown): number {
  failureCount += 1;
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(
    JSON.stringify({
      level: "error",
      scope: "event-bridge",
      op: label,
      failureCount,
      error: redactText(message),
    }),
  );
  return failureCount;
}

/** The counter hook: the process-local count of swallowed bridge write failures. */
export function bridgeFailureCount(): number {
  return failureCount;
}
