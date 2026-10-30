import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleDebouncer } from "@/components/polymath/zettels/idle-debounce";
import { CREATION_IDLE_MS } from "@/domains/knowledge/sittings";

// §14.2 (and the §11 adversarial case): the creation idle debounce fires
// Track B exactly once per pause, on the real clock window CREATION_IDLE_MS
// after the LAST keystroke of the burst - never once per keystroke, never
// early, and never after unmount.
describe("creation idle debounce (§14.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a burst of keystrokes fires exactly once, after the last one", () => {
    const fire = vi.fn();
    const d = createIdleDebouncer(fire, CREATION_IDLE_MS);
    d.signal();
    vi.advanceTimersByTime(500);
    d.signal();
    vi.advanceTimersByTime(500);
    d.signal();
    vi.advanceTimersByTime(CREATION_IDLE_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("a second pause fires exactly once more", () => {
    const fire = vi.fn();
    const d = createIdleDebouncer(fire, CREATION_IDLE_MS);
    d.signal();
    vi.advanceTimersByTime(CREATION_IDLE_MS);
    d.signal();
    vi.advanceTimersByTime(CREATION_IDLE_MS - 1);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("cancel (unmount) drops a pending fire - Track B never fires after it", () => {
    const fire = vi.fn();
    const d = createIdleDebouncer(fire, CREATION_IDLE_MS);
    d.signal();
    vi.advanceTimersByTime(CREATION_IDLE_MS - 1);
    d.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fire).not.toHaveBeenCalled();
  });
});
