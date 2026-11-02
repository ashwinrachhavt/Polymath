/** The executor's named errors: a defer that counts no failure, and a missing owner. */

/**
 * Throw from an effect handler to reschedule the effect without counting a
 * failure: the drain reschedules with backoff, and no health entry is raised.
 * The effects module owns the drain that interprets this marker; the class
 * lives here so the executor can defer on worker-slot pressure before the
 * wiring commit trades it for the effects module's own export.
 */
export class Later extends Error {
  readonly code = "later";
  constructor(message: string) {
    super(message);
    this.name = "Later";
  }
}

/**
 * A background run has no session to inherit an AuthContext from: the executor
 * resolves the workspace owner per operation. A workspace always has an owner
 * in the data model, so failing to resolve one is a structural fault worth its
 * own name — the launch reports it as a failed run, not as a retryable effect.
 */
export class OwnerUnavailableError extends Error {
  readonly code = "owner_unavailable";
  constructor() {
    super("No workspace owner could be resolved to run this ticket.");
    this.name = "OwnerUnavailableError";
  }
}
