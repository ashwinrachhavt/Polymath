/*
 * The one interval in the client that asks the server how background work is
 * doing. It runs only while the tab is visible: a hidden tab stops reading,
 * and a tab that comes back reads at once instead of waiting out the interval.
 * With a dozen tabs left open overnight that is the difference between a dozen
 * pollers and one.
 *
 * Prefer the push channel (components/jobs/generation-jobs.tsx) for anything
 * that is a generation job. This is for work that is not one yet.
 */

export type PollTick = (context: {
  /** Ends the poll for good; a later return to the tab does not restart it. */
  stop: () => void;
  /** True when this read is the one a tab made on becoming visible again. */
  resumed: boolean;
}) => void | Promise<void>;

/** Reads now and every `intervalMs` while the tab is visible. Returns a function that stops it. */
export function pollWhileVisible(tick: PollTick, intervalMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const disarm = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const stop = () => {
    stopped = true;
    disarm();
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const arm = (resumed: boolean) => {
    if (stopped || timer !== undefined) return;
    void tick({ stop, resumed });
    // The first read may have stopped the poll; arming after it would outlive that.
    if (stopped) return;
    timer = setInterval(() => void tick({ stop, resumed: false }), intervalMs);
  };
  function onVisibility() {
    if (document.visibilityState === "visible") arm(true);
    else disarm();
  }

  document.addEventListener("visibilitychange", onVisibility);
  if (document.visibilityState === "visible") arm(false);
  return stop;
}
