import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The one rating control under every model output. It rests as one quiet
 * face, opens five faces inline, saves a pick through the shared action,
 * clears on a second press of the chosen face, and puts the old face back
 * (with the reason) when a save fails.
 */

const rate = vi.hoisted(() => vi.fn());
vi.mock("@/components/feedback/rate-output-action", () => ({ rateOutputAction: rate }));

const { OutputRating } = await import("@/components/feedback/output-rating");

const output = { surface: "quiz", id: "11111111-1111-4111-8111-111111111111" } as const;

beforeEach(() => {
  rate.mockReset();
});
afterEach(cleanup);

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("OutputRating", () => {
  it("rests as one labelled button and opens five named faces", () => {
    render(createElement(OutputRating, { output, initial: null, label: "Rate this quiz" }));
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rate this quiz" }));
    const faces = screen.getAllByRole("radio");
    expect(faces.map((face) => face.getAttribute("aria-label"))).toEqual([
      "1 of 5, awful",
      "2 of 5, poor",
      "3 of 5, okay",
      "4 of 5, good",
      "5 of 5, great",
    ]);
    expect(screen.getByRole("radiogroup", { name: "Rate this quiz" })).toBeTruthy();
  });

  it("saves a pick with its score and closes to the chosen face", async () => {
    rate.mockResolvedValue({ ok: true, rating: { score: 4, comment: null } });
    render(createElement(OutputRating, { output, initial: null }));
    fireEvent.click(screen.getByRole("button", { name: "Rate this answer" }));
    fireEvent.click(screen.getByRole("radio", { name: "4 of 5, good" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: 4 });
    expect(screen.getByRole("button", { name: "Rated 4 of 5, good. Change rating" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
  });

  it("pressing the chosen face again clears the rating", async () => {
    rate.mockResolvedValue({ ok: true, rating: null });
    render(createElement(OutputRating, { output, initial: { score: 2, comment: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Rated 2 of 5, poor. Change rating" }));
    expect(screen.getByRole("radio", { name: "2 of 5, poor" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "2 of 5, poor" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: null });
    expect(screen.getByRole("button", { name: "Rate this answer" })).toBeTruthy();
  });

  it("a failed save restores the previous face and says why", async () => {
    rate.mockResolvedValue({ ok: false, error: "Your rating was not saved." });
    render(createElement(OutputRating, { output, initial: { score: 3, comment: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Rated 3 of 5, okay. Change rating" }));
    fireEvent.click(screen.getByRole("radio", { name: "5 of 5, great" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Your rating was not saved.");
    expect(screen.getByRole("button", { name: "Rated 3 of 5, okay. Change rating" })).toBeTruthy();
  });

  it("a note is optional and saved with the current score", async () => {
    rate.mockResolvedValue({ ok: true, rating: { score: 1, comment: "Cited the wrong paper" } });
    render(createElement(OutputRating, { output, initial: { score: 1, comment: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Why this rating"), { target: { value: "  Cited the wrong paper " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(rate).toHaveBeenCalledWith({ output, score: 1, comment: "Cited the wrong paper" });
    expect(screen.getByRole("button", { name: "Edit note" })).toBeTruthy();
  });

  it("arrow keys move between faces and Escape closes them, returning focus", async () => {
    render(createElement(OutputRating, { output, initial: null }));
    fireEvent.click(screen.getByRole("button", { name: "Rate this answer" }));
    const middle = screen.getByRole("radio", { name: "3 of 5, okay" });
    middle.focus();
    fireEvent.keyDown(middle, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("4 of 5, good");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("radio")).toBeNull());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Rate this answer");
  });
});
