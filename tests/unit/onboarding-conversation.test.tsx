import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/*
 * The onboarding conversation island's start/retry machinery.
 *
 * The F2 regression lives here: the start effect is keyed on [runId,
 * startAttempt], and a failed start leaves runId null — so the old Retry
 * handler's setRunId(null) was a no-op, the effect never re-ran, no request
 * ever fired, and the island stood on "Starting the interview…" forever.
 * The fix keys the effect on a startAttempt counter that Retry bumps; this
 * file proves the second attempt actually fires.
 *
 * Also covered: initialError (the page's F5/F7 landing) must render the
 * failure card WITHOUT any start call until Retry asks for one, and the F6
 * terminal-failure wiring must reach the same fresh-start mechanism.
 *
 * Value: protects=Retry-actually-retries, the no-auto-start landing, and the
 * terminal-run fresh start; fails_when=Retry issues no second action call
 * (the regression), initialError triggers an auto-start, or the in-surface
 * failure affordance strands; seam=the server actions and ChatSurface are
 * module mocks (the surface's real rendering is covered by the e2e fixture
 * specs); no_claim=that startOnboardingAction itself succeeds — its failure
 * modes are the action's and the domain's to prove.
 */

const { startOnboardingAction } = vi.hoisted(() => ({ startOnboardingAction: vi.fn<() => Promise<unknown>>() }));

vi.mock("@/app/(workspace)/onboarding/actions", () => ({
  startOnboardingAction,
  completeOnboardingAction: vi.fn(),
  onboardingBriefAction: vi.fn(async () => ({ ok: false })),
  confirmOnboardingBriefAction: vi.fn(),
}));

vi.mock("@/components/chat/chat-surface", () => ({
  ChatSurface: (props: { onRunFailedRetry?: () => void }) => (
    <div data-testid="surface-stub">
      {props.onRunFailedRetry ? (
        <button type="button" onClick={props.onRunFailedRetry}>
          simulate-run-failed
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import { OnboardingConversation } from "@/app/(workspace)/onboarding/onboarding-conversation";

const CARD_TITLE = "The interview could not start";

describe("OnboardingConversation retry machinery", () => {
  it("issues a real second start when Retry is clicked after a failed start (F2)", async () => {
    startOnboardingAction
      .mockResolvedValueOnce({ ok: false, message: "The interview could not start (reason)." })
      .mockResolvedValueOnce({ ok: true, runId: "run-2" });
    render(<OnboardingConversation />);
    await waitFor(() => expect(startOnboardingAction).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: CARD_TITLE })).toBeDefined();

    // The regression: this click used to call setRunId(null) while runId was
    // already null — no state change, no effect, no request, ever.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(startOnboardingAction).toHaveBeenCalledTimes(2));
    // And the retry lands on the interview, not back on the card.
    await waitFor(() => expect(screen.getByTestId("surface-stub")).toBeDefined());
    expect(screen.queryByRole("heading", { name: CARD_TITLE })).toBeNull();
  });

  it("re-shows the failure card when the retried start also fails, never stranding", async () => {
    startOnboardingAction.mockResolvedValue({ ok: false, message: "still broken" });
    render(<OnboardingConversation />);
    await waitFor(() => expect(screen.getByRole("heading", { name: CARD_TITLE })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(startOnboardingAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("heading", { name: CARD_TITLE })).toBeDefined());
    // Neither state between the attempts is the stranded spinner: the card is
    // the settled surface both times.
    expect(screen.queryByText("Starting the interview")).toBeNull();
  });

  it("renders the initialError card without any start call until Retry asks for one (F5/F7)", async () => {
    startOnboardingAction.mockResolvedValue({ ok: true, runId: "run-3" });
    render(<OnboardingConversation initialError="The deployment has no model key." />);
    expect(screen.getByRole("heading", { name: CARD_TITLE })).toBeDefined();
    // No auto-start: the page landed us on a failure, not a fresh run.
    expect(startOnboardingAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(startOnboardingAction).toHaveBeenCalledTimes(1));
  });

  it("starts a fresh run when the surface's terminal-failure affordance fires (F6)", async () => {
    startOnboardingAction
      .mockResolvedValueOnce({ ok: true, runId: "run-1" })
      .mockResolvedValueOnce({ ok: true, runId: "run-2" });
    render(<OnboardingConversation />);
    await waitFor(() => expect(screen.getByTestId("surface-stub")).toBeDefined());
    // The terminal run cannot take another message; the affordance must reach
    // the same fresh-start mechanism as the card's Retry.
    fireEvent.click(screen.getByRole("button", { name: "simulate-run-failed" }));
    await waitFor(() => expect(startOnboardingAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("surface-stub")).toBeDefined());
  });

  it("keeps the form fallback reachable from the failure card", async () => {
    startOnboardingAction.mockResolvedValue({ ok: false, message: "no runtime" });
    render(<OnboardingConversation />);
    await waitFor(() => expect(screen.getByRole("heading", { name: CARD_TITLE })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /answer as a form instead/i }));
    await waitFor(() => expect(screen.getByText("What should your agent be called?")).toBeDefined());
  });
});
