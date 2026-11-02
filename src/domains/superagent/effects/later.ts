/**
 * The defer that counts no failure. A handler that throws `Later` is saying
 * "look again later": the work is not finished, but nothing went wrong — the
 * next input has not landed yet, or another pass is already on the row.
 *
 * The drain pass parks the effect for `retryAfterMs` and leaves its failure
 * counters alone, so a long sequence of honest defers never raises the health
 * entry. Only real errors do that.
 */
export class Later extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly reason = "the work is not finished",
  ) {
    super(`${reason} — parked for ${retryAfterMs}ms`);
    this.name = "Later";
  }
}
