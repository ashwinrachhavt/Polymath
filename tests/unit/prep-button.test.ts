// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * PrepButton (ASH-302 sweep): a failed REFRESH in the "Prep ready" state must
 * surface the error where the owner clicked - the ready state used to set the
 * error and never render it, so a failed refresh looked exactly like a no-op.
 *
 * Value: protects=the ready state's error visibility; fails_when=the error
 * renders only in the pre-ready branch again; why_new=the e2e journey covers
 * the happy path only; seam=the server action mocked at the module boundary;
 * no_claim=the action's own failure modes (covered by meeting-prep tests).
 */

const generateMeetingPrepAction = vi.fn();
vi.mock("@/app/(workspace)/neuralflow/work/meeting-prep-actions", () => ({
  generateMeetingPrepAction: (...args: unknown[]) => generateMeetingPrepAction(...args),
}));

import { PrepButton } from "@/app/(workspace)/neuralflow/work/prep-button";

const EVENT_ID = "6557a1d2-0000-4000-8000-000000000002";
const ARTIFACT_ID = "6557a1d2-0000-4000-8000-000000000099";

afterEach(() => {
  cleanup();
  generateMeetingPrepAction.mockReset();
});

describe("PrepButton", () => {
  it("shows a failed refresh in the ready state, where the owner clicked", async () => {
    generateMeetingPrepAction.mockResolvedValueOnce({ ok: true, artifactId: ARTIFACT_ID });
    const screen = render(createElement(PrepButton, { eventId: EVENT_ID }));

    await act(async () => {
      screen.getByRole("button", { name: "Prep" }).click();
    });
    await waitFor(() => screen.getByRole("link", { name: "Prep ready" }));

    generateMeetingPrepAction.mockResolvedValueOnce({ ok: false, error: "The prep report did not run." });
    await act(async () => {
      screen.getByRole("button", { name: "Refresh" }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The prep report did not run.");
    // The owner is still in the ready state; the failed refresh changed nothing else.
    expect(screen.getByRole("link", { name: "Prep ready" })).toBeTruthy();
  });

  it("shows a failed first run in place", async () => {
    generateMeetingPrepAction.mockResolvedValueOnce({ ok: false, error: "No generation provider configured." });
    const screen = render(createElement(PrepButton, { eventId: EVENT_ID }));

    await act(async () => {
      screen.getByRole("button", { name: "Prep" }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No generation provider configured.");
  });
});
