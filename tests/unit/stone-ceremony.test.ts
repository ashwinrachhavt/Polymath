// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The stone ceremony (ASH-311): a short, non-blocking reveal fired only by
 * the canonical quartzEarned award result.
 * value: protects=the ceremony shows the earned stone and the person's own
 * sentence, dismisses three ways (button, Escape, timer), never plays sound
 * without the explicit opt-in, and never traps focus or blocks the screen;
 * fails_when=the card claims an award, swallows the sentence, ignores
 * dismissal, or chimes by default; seam=the chime's AudioContext mocked at
 * the window boundary; no_claim=the ledger write and idempotency live in
 * recordDailyQuartz (integration tests own those), and CSS reduced-motion
 * stilling is stylesheet-level, not tested here.
 */

import { StoneCeremony } from "@/components/products/neuralflow/stone-ceremony";

const chimeSpy = vi.fn();

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return { type: "", frequency: { value: 0 }, connect: () => ({ connect: () => ({}) }), start: chimeSpy, stop: () => {} };
  }
  createGain() {
    return { gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => ({ connect: () => ({}) }) };
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  chimeSpy.mockClear();
  (window as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe("StoneCeremony", () => {
  it("announces the earned Quartz with the collection link", () => {
    render(h(StoneCeremony, { onDismiss: () => {} }));
    expect(screen.getByRole("status").textContent).toContain("Quartz earned");
    expect(screen.getByRole("status").textContent).toContain("First completed task of the day.");
    expect(screen.getByRole("link", { name: "View collection" }).getAttribute("href")).toBe("/apps/neuralflow/rewards");
  });

  it("echoes the person's own completion sentence as the reflection", () => {
    render(h(StoneCeremony, { sentence: "Shipped the revocation fix", onDismiss: () => {} }));
    expect(screen.getByRole("status").textContent).toContain("Shipped the revocation fix");
  });

  it("dismisses via the button, Escape, and the auto-dismiss timer", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(h(StoneCeremony, { onDismiss }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    onDismiss.mockClear();
    cleanup();
    render(h(StoneCeremony, { onDismiss }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    onDismiss.mockClear();
    cleanup();
    render(h(StoneCeremony, { onDismiss }));
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays silent by default and chimes only after the explicit opt-in", () => {
    render(h(StoneCeremony, { onDismiss: () => {} }));
    expect(chimeSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Soft chime/ }));
    expect(window.localStorage.getItem("polymath.stone-ceremony.chime")).toBe("on");
    expect(chimeSpy).toHaveBeenCalled();

    // A later ceremony reads the stored opt-in on mount.
    chimeSpy.mockClear();
    cleanup();
    render(h(StoneCeremony, { onDismiss: () => {} }));
    expect(chimeSpy).toHaveBeenCalled();
  });

  it("renders without throwing when AudioContext is unavailable", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    window.localStorage.setItem("polymath.stone-ceremony.chime", "on");
    render(h(StoneCeremony, { onDismiss: () => {} }));
    expect(screen.getByRole("status").textContent).toContain("Quartz earned");
  });
});
