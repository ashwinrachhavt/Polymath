/*
 * §14.2: Track B fires exactly once per pause. Every keystroke signals; each
 * signal re-arms the idle window and only the last one in a burst fires.
 * cancel() (unmount) drops a pending fire - Track B never fires for a pause
 * the writer did not finish.
 */
export function createIdleDebouncer(fire: () => void, idleMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    signal() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, idleMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
