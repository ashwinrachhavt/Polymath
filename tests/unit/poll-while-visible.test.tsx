import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "@/lib/poll-while-visible";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("pollWhileVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads at once, then on every interval while the tab is visible", async () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 2_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });

  it("stops reading while the tab is hidden", async () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 2_000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads straight away when the tab comes back, and says it was a resume", async () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 2_000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick.mock.calls[0][0].resumed).toBe(false);
    expect(tick.mock.calls[1][0].resumed).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(tick.mock.calls[2][0].resumed).toBe(false);
    stop();
  });

  it("does not start a second interval when visibility flips back to visible twice", async () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 2_000);
    setVisibility("visible");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("is over for good once a tick stops it, even if the tab is hidden and shown again", async () => {
    const tick = vi.fn(({ stop }: { stop: () => void }) => stop());
    pollWhileVisible(tick, 2_000);
    expect(tick).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("the returned stop ends the poll and detaches the visibility listener", async () => {
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 2_000);
    stop();
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("does not start when the tab is already hidden, and starts when it is shown", async () => {
    setVisibility("hidden");
    const tick = vi.fn();
    const stop = pollWhileVisible(tick, 2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });
});
