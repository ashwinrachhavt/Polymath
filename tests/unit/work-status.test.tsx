import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkStatus, useWorkPoll, type WorkState } from "@/components/work-status";

const WORKING: WorkState = { phase: "working", label: "Reading…" };
const GIVE_UP = "Still working — the surface will catch up.";

describe("WorkStatus", () => {
  it("renders nothing on an idle state", () => {
    expect(renderToStaticMarkup(createElement(WorkStatus, { state: null }))).toBe("");
  });

  it("renders the server's label verbatim as a status line", () => {
    const html = renderToStaticMarkup(createElement(WorkStatus, { state: WORKING }));
    expect(html).toContain("Reading…");
    expect(html).toContain('role="status"');
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("alert");
  });

  it("a failure announces itself as an alert", () => {
    const html = renderToStaticMarkup(
      createElement(WorkStatus, { state: { phase: "failed", label: "The generation failed." } }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-destructive");
    expect(html).toContain("The generation failed.");
  });

  it("counts render tabular and skip zero segments", () => {
    const html = renderToStaticMarkup(
      createElement(WorkStatus, {
        state: { phase: "working", label: "Reading…", count: { queued: 2, reviewing: 0 } },
      }),
    );
    expect(html).toContain("tabular-nums");
    expect(html).toContain("2 queued");
    expect(html).not.toContain("0 in review");
  });

  it("renders both count segments when both are live", () => {
    const html = renderToStaticMarkup(
      createElement(WorkStatus, {
        state: { phase: "working", label: "Reading…", count: { queued: 2, reviewing: 5 } },
      }),
    );
    expect(html).toContain("2 queued");
    expect(html).toContain("5 in review");
  });
});

describe("useWorkPoll", () => {
  beforeEach(() => {
    // The setup clock pins Date; the poll also needs its timers faked so the
    // interval is stepped deterministically instead of waited on.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not arm on an empty id list", async () => {
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, WORKING])));
    renderHook(() => useWorkPoll({ ids: [], read, giveUpLabel: GIVE_UP }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads immediately, then paces by the interval across quiet ticks", async () => {
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, WORKING])));
    const { result } = renderHook(() => useWorkPoll({ ids: ["a"], read, giveUpLabel: GIVE_UP }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.states.a).toEqual(WORKING);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.gaveUp).toBe(false);
  });

  it("a failed tick is silent and the next interval retries", async () => {
    let failures = 1;
    const read = vi.fn(async (ids: string[]) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("the status read 500'd");
      }
      return Object.fromEntries(ids.map((id) => [id, WORKING]));
    });
    const { result } = renderHook(() => useWorkPoll({ ids: ["a"], read, giveUpLabel: GIVE_UP }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.states.a).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.states.a).toEqual(WORKING);
  });

  it("stops itself once every polled id settles, and a fresh arm re-arms with wiped states", async () => {
    let outstanding = true;
    const read = vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [id, outstanding ? WORKING : ({ phase: "done", label: "Ready." } as WorkState)]),
      ),
    );
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useWorkPoll({ ids, read, giveUpLabel: GIVE_UP }),
      { initialProps: { ids: ["a"] } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(1);

    outstanding = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.states.a.phase).toBe("done");

    // Terminal: no more ticks, no matter how long the surface stays mounted.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(2);

    // A new arm wipes the old arm's answers before its first read.
    rerender({ ids: ["b"] });
    expect(result.current.states.a).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.states.b).toEqual({ phase: "done", label: "Ready." });
  });

  it("gives up honestly at the ceiling, labels the owed work, and stops polling", async () => {
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, WORKING])));
    const { result } = renderHook(() => useWorkPoll({ ids: ["a"], read, giveUpMs: 5 * 60_000, giveUpLabel: GIVE_UP }));
    await act(async () => {
      // Past the ceiling AND past the next interval boundary: the ceiling is
      // only noticed by a tick, and ticks land on the 2 s grid.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000 + 1);
    });
    expect(result.current.gaveUp).toBe(true);
    expect(result.current.states.a).toEqual({ phase: "working", label: GIVE_UP });
    const calls = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(calls);
  });
});
