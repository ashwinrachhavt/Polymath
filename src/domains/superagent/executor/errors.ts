/** The executor's named error: a defer that counts no failure. */

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
