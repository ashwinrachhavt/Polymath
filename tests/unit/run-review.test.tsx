import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The run verdict under a finished run: 👎 is saved at once as a 0 with no
 * question in the way (reasons are an optional follow-up), 👍 opens the 1-5
 * faces so the verdict says how good it was, and the same thumb again clears.
 */

const rate = vi.hoisted(() => vi.fn());
vi.mock("@/components/feedback/rate-output-action", () => ({ rateOutputAction: rate }));
vi.mock("@/app/(workspace)/polymath/[runId]/review-actions", () => ({ dismissRunCritiqueAction: vi.fn() }));

const { RunReview } = await import("@/app/(workspace)/polymath/[runId]/run-review");

const RUN = "11111111-1111-4111-8111-111111111111";
const output = { surface: "run", id: RUN };

beforeEach(() => rate.mockReset());
afterEach(cleanup);

const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

describe("RunReview thumbs", () => {
  it("thumbs-down saves a 0 immediately, then offers optional reasons", async () => {
    rate.mockResolvedValue({ ok: true, rating: { score: 0, comment: null } });
    render(createElement(RunReview, { runId: RUN, critique: null, initialRating: null }));
    fireEvent.click(screen.getByRole("button", { name: "Run was not good" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: 0, comment: null });
    expect(screen.getByRole("button", { name: "Run was not good" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/What went wrong\? Optional\./)).toBeTruthy();

    rate.mockResolvedValue({ ok: true, rating: { score: 0, comment: "Wrong, Messy: cited a stale page" } });
    fireEvent.click(screen.getByRole("button", { name: "Wrong" }));
    fireEvent.click(screen.getByRole("button", { name: "Messy" }));
    fireEvent.change(screen.getByLabelText("A note about this run"), { target: { value: "cited a stale page" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(rate).toHaveBeenLastCalledWith({ output, score: 0, comment: "Wrong, Messy: cited a stale page" });
  });

  it("skipping the reasons keeps the 0 and sends nothing more", async () => {
    rate.mockResolvedValue({ ok: true, rating: { score: 0, comment: null } });
    render(createElement(RunReview, { runId: RUN, critique: null, initialRating: null }));
    fireEvent.click(screen.getByRole("button", { name: "Run was not good" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(rate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/What went wrong/)).toBeNull();
  });

  it("thumbs-up opens the faces and a pick saves that grade", async () => {
    render(createElement(RunReview, { runId: RUN, critique: null, initialRating: null }));
    fireEvent.click(screen.getByRole("button", { name: "Run was good" }));
    expect(rate).not.toHaveBeenCalled();
    rate.mockResolvedValue({ ok: true, rating: { score: 4, comment: null } });
    fireEvent.click(screen.getByRole("radio", { name: "4 of 5, good" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: 4 });
    expect(screen.getByRole("button", { name: "Run was good" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("moving from thumbs-down to thumbs-up clears the 0 first, then grades", async () => {
    rate.mockResolvedValue({ ok: true, rating: null });
    render(createElement(RunReview, { runId: RUN, critique: null, initialRating: { score: 0, comment: "Wrong" } }));
    fireEvent.click(screen.getByRole("button", { name: "Run was good" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: null, comment: null });
    expect(screen.getByRole("radiogroup", { name: "How good was this run?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run was not good" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("the same thumb again clears", async () => {
    rate.mockResolvedValue({ ok: true, rating: null });
    render(createElement(RunReview, { runId: RUN, critique: null, initialRating: { score: 0, comment: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Run was not good" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: null, comment: null });
  });

  it("a failed save says so and leaves the thumbs where they were", async () => {
    rate.mockResolvedValue({ ok: false, error: "Your rating was not saved." });
    render(createElement(RunReview, { runId: RUN, critique: null, initialRating: null }));
    fireEvent.click(screen.getByRole("button", { name: "Run was not good" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Feedback was not saved.");
    expect(screen.getByRole("button", { name: "Run was not good" }).getAttribute("aria-pressed")).toBe("false");
  });
});
