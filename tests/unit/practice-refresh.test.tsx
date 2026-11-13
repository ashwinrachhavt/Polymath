import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const practiceStatusAction = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(workspace)/projects/[projectId]/notebook/practice-actions", () => ({
  practiceStatusAction: (input: unknown) => practiceStatusAction(input),
  showPracticeHintAction: vi.fn(),
  submitPracticeAnswerAction: vi.fn(),
  startPracticeAction: vi.fn(),
}));

const { useRefreshWhenPrepared } = await import("@/app/(workspace)/projects/[projectId]/notebook/practice-session");

const PROJECT = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const WORKING = { phase: "working", label: "Writing your exercise from your sources." } as const;
const DONE = { phase: "done", label: "Your exercise is ready." } as const;

describe("useRefreshWhenPrepared", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    refresh.mockReset();
    practiceStatusAction.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reads nothing and refreshes nothing when no exercise is being written", async () => {
    renderHook(() => useRefreshWhenPrepared(PROJECT, []));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(practiceStatusAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reads the status of the waiting exercises and does not refresh the route while they are still being written", async () => {
    practiceStatusAction.mockResolvedValue({ ok: true, states: { [A]: WORKING } });
    renderHook(() => useRefreshWhenPrepared(PROJECT, [A]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(practiceStatusAction).toHaveBeenCalledWith({ projectId: PROJECT, challengeIds: [A] });
    expect(practiceStatusAction.mock.calls.length).toBeGreaterThan(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes the route once when the last waiting exercise settles, then stops reading", async () => {
    practiceStatusAction
      .mockResolvedValueOnce({ ok: true, states: { [A]: WORKING, [B]: WORKING } })
      .mockResolvedValueOnce({ ok: true, states: { [A]: DONE, [B]: WORKING } })
      .mockResolvedValue({ ok: true, states: { [A]: DONE, [B]: DONE } });
    renderHook(() => useRefreshWhenPrepared(PROJECT, [A, B]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const reads = practiceStatusAction.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(practiceStatusAction).toHaveBeenCalledTimes(reads);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a failed read is silent and the next one retries", async () => {
    practiceStatusAction
      .mockResolvedValueOnce({ ok: false, error: "That exercise is not available." })
      .mockResolvedValue({ ok: true, states: { [A]: DONE } });
    renderHook(() => useRefreshWhenPrepared(PROJECT, [A]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
