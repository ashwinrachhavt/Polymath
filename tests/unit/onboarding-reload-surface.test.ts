import { describe, expect, it } from "vitest";
import { RETRY_CARD_MESSAGE, resolveReloadSurface } from "@/app/(workspace)/onboarding/reload-surface";

/*
 * The F5 decision, wizard-shaped: a failed latest run must never render as a
 * fresh wizard (which the island's mount would auto-start) — its notice or
 * its salvage leads. The decision reads only what the page already fetched
 * (the latest run, its reading, and the session's wizard state), so the
 * branch order is fully testable without a database.
 *
 * Value: protects=the failed-run branches (salvage leads to the wizard
 * restart with the salvage prefill; nothing salvageable leads to the
 * restart-with-notice), the mid-wizard resume (the session's persisted step
 * and draft beat a fresh wizard), and the brief-beats-all precedence;
 * fails_when=a failed run lands notice-less and prefill-less (the auto-start
 * regression), salvage is dropped, session progress is discarded, or a
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
  it("lands on the wizard when there is no run at all — fresh without a session row", () => {
    expect(resolveReloadSurface(null, null, null)).toEqual({
      kind: "wizard",
      step: "role",
      draft: null,
      prefill: {},
      notice: null,
    });
    expect(resolveReloadSurface({ state: "failed" }, null, null).kind).toBe("wizard");
  });

  it("resumes a mid-wizard reload at the session's persisted step and draft", () => {
    const session = { step: "words" as const, draft: { role: "Ops", freeform: "my words" } };
    expect(resolveReloadSurface(null, null, session)).toEqual({
      kind: "wizard",
      step: "words",
      draft: { role: "Ops", freeform: "my words" },
      prefill: {},
      notice: null,
    });
  });

  it("sends a validated brief to review whatever the run state — the brief beats wizard progress", () => {
    const session = { step: "words" as const, draft: { role: "stale draft" } };
    const surface = resolveReloadSurface(
      { state: "succeeded" },
      { brief: BRIEF, prefill: { agentName: "x" }, profileVersion: 2 },
      session,
    );
    expect(surface).toEqual({ kind: "review", brief: BRIEF, profileVersion: 2 });
  });

  it("sends a failed run's salvage to a wizard restart with the prefill and the failure notice", () => {
    const surface = resolveReloadSurface(
      { state: "failed" },
      { brief: null, prefill: { agentName: "Alfred" }, profileVersion: null },
      null,
    );
    expect(surface).toEqual({
      kind: "wizard",
      step: "role",
      draft: null,
      prefill: { agentName: "Alfred" },
      notice: expect.stringContaining("could not finish"),
    });
  });

  it("sends a failed run with nothing salvageable to a restart whose notice explains why", () => {
    const surface = resolveReloadSurface({ state: "failed" }, EMPTY, null);
    expect(surface).toEqual({
      kind: "wizard",
      step: "role",
      draft: null,
      prefill: {},
      notice: RETRY_CARD_MESSAGE,
    });
    expect(RETRY_CARD_MESSAGE).toContain("Retry");
  });

  it("never lands a failed run on a fresh auto-starting wizard", () => {
    // The pre-fix behavior, wizard edition: a failed run must carry either
    // salvage or a notice — never a bare, notice-less restart whose mount
    // mints a fresh run on every reload.
    const surface = resolveReloadSurface({ state: "failed" }, EMPTY, null);
    expect(surface.kind === "wizard" && (surface.notice !== null || surface.prefill !== null)).toBe(true);
    expect(surface).toMatchObject({ notice: expect.any(String) });
  });

  it("keeps the extraction-failure restart for a succeeded run without a brief", () => {
    const surface = resolveReloadSurface(
      { state: "succeeded" },
      { brief: null, prefill: { role: "Ops" }, profileVersion: null },
      null,
    );
    expect(surface).toMatchObject({ kind: "wizard", prefill: { role: "Ops" } });
    expect(surface.kind === "wizard" && surface.notice?.includes("couldn't read")).toBe(true);
  });

  it("treats a cancelled run's salvage like the legacy extraction path", () => {
    const surface = resolveReloadSurface(
      { state: "cancelled" },
      { brief: null, prefill: { role: "Ops" }, profileVersion: null },
      null,
    );
    expect(surface).toMatchObject({ kind: "wizard", prefill: { role: "Ops" } });
  });

  it("keeps the session's wizard progress when the leftover run has nothing to say", () => {
    // A pre-deploy in-flight interview run (state running) plus wizard
    // progress: the person's persisted step leads over a fresh restart.
    const session = { step: "review" as const, draft: { tools: ["Notion"] } };
    const surface = resolveReloadSurface({ state: "running" }, EMPTY, session);
    expect(surface).toEqual({
      kind: "wizard",
      step: "review",
      draft: { tools: ["Notion"] },
      prefill: {},
      notice: null,
    });
  });

  it("defaults a run-with-nothing-to-say to the fresh wizard when no session row exists", () => {
    expect(resolveReloadSurface({ state: "running" }, EMPTY, null)).toEqual({
      kind: "wizard",
      step: "role",
      draft: null,
      prefill: {},
      notice: null,
    });
  });
});
