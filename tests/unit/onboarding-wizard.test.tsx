// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The wizard's client contract: server-derived state is trusted (steps render
 * from props), advance is guarded per step, the assist is quiet (status line
 * while pending, labelled error without dropping the draft when it fails),
 * and a confirm conflict re-renders review with the person's words intact.
 *
 * Value: protects=the advance guard (a role-less Continue cannot save), the
 * assist contract (draft survives both a failed assist and a failed confirm),
 * and the review edit-then-confirm path; fails_when=the wizard auto-advances
 * without a role, swallows an assist error, or clears the draft on a race
 * conflict; seam=the three server actions mocked at the module boundary;
 * no_claim=the actions' own semantics (completeOnboarding commits are
 * db-covered in tests/integration/onboarding-flow.test.ts).
 */

const saveOnboardingProgressAction = vi.fn();
const refineOnboardingDraftAction = vi.fn();
const completeOnboardingAction = vi.fn();

vi.mock("@/app/(workspace)/onboarding/actions", () => ({
  saveOnboardingProgressAction: (...args: unknown[]) => saveOnboardingProgressAction(...args),
  refineOnboardingDraftAction: (...args: unknown[]) => refineOnboardingDraftAction(...args),
  completeOnboardingAction: (...args: unknown[]) => completeOnboardingAction(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { OnboardingWizard } from "@/app/(workspace)/onboarding/onboarding-wizard";

beforeAll(() => {
  // motion/react reads matchMedia for reduced-motion; jsdom has none.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  saveOnboardingProgressAction.mockReset();
  refineOnboardingDraftAction.mockReset();
  completeOnboardingAction.mockReset();
});

beforeEach(() => {
  // Every step change persists progress; a default resolve keeps the
  // wizard's best-effort save a no-op in tests that don't assert on it.
  saveOnboardingProgressAction.mockResolvedValue(SAVE_OK);
});

const SAVE_OK = { ok: true as const };

function roleScreen() {
  return render(createElement(OnboardingWizard, { step: "role", draft: null, profileVersion: 3 }));
}

describe("OnboardingWizard", () => {
  it("cannot advance to tools without a role", () => {
    const screen = roleScreen();
    const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });

  it("saves progress and lands on tools, filtered for the chosen role", async () => {
    saveOnboardingProgressAction.mockResolvedValue(SAVE_OK);
    const screen = roleScreen();

    const founder = screen.getByRole("button", { name: "Founder or executive" }) as HTMLButtonElement;
    expect(founder.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      founder.click();
    });
    expect(founder.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      screen.getByRole("button", { name: "Continue" }).click();
    });

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Tools and what matters" })).toBeTruthy());
    await waitFor(() =>
      expect(saveOnboardingProgressAction).toHaveBeenCalledWith({
        step: "priorities",
        draft: { role: "Founder or executive" },
      }),
    );
  });

  it("fills review from a successful assist", async () => {
    // A deferred assist so the pending status line is observable before the
    // result lands and the wizard advances itself to review.
    let resolveAssist: (value: unknown) => void = () => {};
    refineOnboardingDraftAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAssist = resolve;
        }),
    );
    const screen = render(
      createElement(OnboardingWizard, {
        step: "words",
        draft: { role: "Founder", freeform: "I read long reports in the morning." },
        profileVersion: 3,
      }),
    );

    await act(async () => {
      screen.getByRole("button", { name: /Polish with Polymath/ }).click();
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Reading your answers");

    await act(async () => {
      resolveAssist({
        ok: true,
        draft: {
          agentName: "Scout",
          role: "Founder's chief of staff",
          tools: ["Notion"],
          priorities: ["Morning briefs"],
        },
      });
    });

    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "What do you do?" }) as HTMLInputElement).value).toBe(
        "Founder's chief of staff",
      ),
    );
    await waitFor(() =>
      expect(saveOnboardingProgressAction).toHaveBeenCalledWith(expect.objectContaining({ step: "review" })),
    );
  });

  it("keeps the draft and shows the error when the assist fails", async () => {
    refineOnboardingDraftAction.mockResolvedValue({ ok: false, error: "The assist did not run." });
    const screen = render(
      createElement(OnboardingWizard, {
        step: "words",
        draft: { role: "Founder", freeform: "My own words, intact." },
        profileVersion: 3,
      }),
    );

    await act(async () => {
      screen.getByRole("button", { name: /Polish with Polymath/ }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The assist did not run.");
    expect((screen.getByRole("textbox", { name: "In your own words" }) as HTMLTextAreaElement).value).toBe(
      "My own words, intact.",
    );
    // Still on the words step: the manual continue is present and the review
    // never replaced it.
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("re-renders review with the draft intact when confirm loses the version race", async () => {
    completeOnboardingAction.mockResolvedValue({
      ok: false,
      message: "The agent has been edited since you opened this page.",
    });
    const screen = render(
      createElement(OnboardingWizard, {
        step: "review",
        draft: {
          agentName: "Scout",
          role: "Founder's chief of staff",
          tools: ["Notion"],
          priorities: ["Morning briefs"],
        },
        profileVersion: 3,
      }),
    );

    await act(async () => {
      screen.getByRole("button", { name: "Confirm and start" }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The agent has been edited since you opened this page.");
    expect((screen.getByRole("textbox", { name: "What should your agent be called?" }) as HTMLInputElement).value).toBe(
      "Scout",
    );
  });

  it("returns from review to the words step with the freeform text intact", async () => {
    const screen = render(
      createElement(OnboardingWizard, {
        step: "review",
        draft: { role: "Founder", freeform: "My own words, intact." },
        profileVersion: 3,
      }),
    );

    act(() => {
      screen.getByRole("button", { name: "Back" }).click();
    });

    // AnimatePresence mode="wait" mounts the words step only after the review
    // step's exit animation finishes — the query must tolerate that delay.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "In your own words" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "In your own words" }) as HTMLTextAreaElement).value).toBe(
      "My own words, intact.",
    );
  });
});
