import { describe, expect, it } from "vitest";
import { RETRY_CARD_MESSAGE, resolveReloadSurface } from "@/app/(workspace)/onboarding/reload-surface";

/*
 * The F5 decision: a failed latest run must never fall through to the
 * conversation island, whose mount auto-starts a run — that is how reloads
 * minted run rows, eve sessions, and spend reservations for a run that could
 * not succeed. The decision reads only what the page already fetched, so the
 * branch order is fully testable without a database.
 *
 * Value: protects=the failed-run branches (salvage leads to the form with the
 * failure notice; nothing salvageable leads to the failure card) and the
 * untouched legacy paths (brief to the card, extraction failure to the form,
 * everything else to the island); fails_when=a failed run lands in
 * "conversation" (the auto-start regression), salvage is dropped, or a
 * succeeded run's brief is skipped; seam=the reading shape
 * Pick<OnboardingRunReading,...> as plain objects; no_claim=that
 * readOnboardingRun returns the right reading for a real run (db-covered).
 */

const BRIEF = {
  agentName: "Polymath",
  role: "Chief of staff",
  tools: ["Gmail"],
  priorities: ["Inbox zero"],
};

const EMPTY = { brief: null, prefill: {}, profileVersion: null };

describe("resolveReloadSurface", () => {
  it("lands on the conversation island when there is no run at all", () => {
    expect(resolveReloadSurface(null, null).kind).toBe("conversation");
    expect(resolveReloadSurface({ state: "failed" }, null).kind).toBe("conversation");
  });

  it("sends a validated brief to the confirm card, whatever the run state", () => {
    const surface = resolveReloadSurface(
      { state: "succeeded" },
      { brief: BRIEF, prefill: { agentName: "x" }, profileVersion: 2 },
    );
    expect(surface).toEqual({ kind: "confirm", brief: BRIEF, profileVersion: 2 });
  });

  it("sends a failed run's salvage to the form with the failure notice", () => {
    const surface = resolveReloadSurface(
      { state: "failed" },
      { brief: null, prefill: { agentName: "Alfred" }, profileVersion: null },
    );
    expect(surface.kind).toBe("interview");
    if (surface.kind === "interview") {
      expect(surface.prefill).toEqual({ agentName: "Alfred" });
      expect(surface.notice).toContain("could not finish");
    }
  });

  it("sends a failed run with nothing salvageable to the failure card", () => {
    const surface = resolveReloadSurface({ state: "failed" }, EMPTY);
    expect(surface).toEqual({ kind: "retry", message: RETRY_CARD_MESSAGE });
    expect(RETRY_CARD_MESSAGE).toContain("Retry");
    expect(RETRY_CARD_MESSAGE).toContain("form");
  });

  it("never lands a failed run on the auto-starting conversation island", () => {
    // The pre-fix behavior: any run without a parseable brief fell through to
    // "conversation", whose mount mints a fresh run on every reload.
    expect(resolveReloadSurface({ state: "failed" }, EMPTY).kind).not.toBe("conversation");
  });

  it("keeps the extraction-failure path for a succeeded run without a brief", () => {
    const surface = resolveReloadSurface(
      { state: "succeeded" },
      { brief: null, prefill: { role: "Ops" }, profileVersion: null },
    );
    expect(surface.kind).toBe("interview");
    if (surface.kind === "interview") expect(surface.notice).toContain("couldn't read");
  });

  it("keeps the conversation island for a succeeded run with nothing salvageable", () => {
    expect(resolveReloadSurface({ state: "succeeded" }, EMPTY).kind).toBe("conversation");
  });

  it("treats a cancelled run's salvage like the legacy extraction path", () => {
    const surface = resolveReloadSurface(
      { state: "cancelled" },
      { brief: null, prefill: { role: "Ops" }, profileVersion: null },
    );
    expect(surface.kind).toBe("interview");
  });
});
