import { describe, expect, it } from "vitest";
import {
  composeAssistPrompt,
  freeformDraftSchema,
  ONBOARDING_ASSIST_SYSTEM,
  ONBOARDING_STEPS,
  onboardingDraftSchema,
  readWizardState,
} from "@/domains/agents/onboarding-assist";

/*
 * The wizard's pure contract: the step ladder is the persistence default's
 * ladder, the draft accepts any partial brief plus the freeform words, and
 * the assist prompt carries the person's selections and words verbatim —
 * the assist composes from what they gave, never from what it assumed.
 */

describe("onboarding steps", () => {
  it("starts at the session column's default", () => {
    expect(ONBOARDING_STEPS[0]).toBe("role");
  });

  it("is a four-step ladder ending at review", () => {
    expect(ONBOARDING_STEPS).toEqual(["role", "priorities", "words", "review"]);
  });
});

describe("onboardingDraftSchema", () => {
  it("accepts a partial brief plus freeform", () => {
    const parsed = onboardingDraftSchema.safeParse({
      role: "Precision engineer",
      freeform: "I ship precision tools for one-person teams.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the empty draft (a step advanced before anything was chosen)", () => {
    expect(onboardingDraftSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an oversized freeform", () => {
    expect(onboardingDraftSchema.safeParse({ freeform: "x".repeat(4_001) }).success).toBe(false);
  });
});

describe("freeformDraftSchema", () => {
  it("requires the person's own words", () => {
    expect(freeformDraftSchema.safeParse({ role: "Engineer" }).success).toBe(false);
    expect(freeformDraftSchema.safeParse({ freeform: "  " }).success).toBe(false);
    expect(freeformDraftSchema.safeParse({ freeform: "words" }).success).toBe(true);
  });

  it("bounds the selections the assist will echo", () => {
    expect(freeformDraftSchema.safeParse({ freeform: "w", tools: Array(31).fill("t") }).success).toBe(false);
    expect(freeformDraftSchema.safeParse({ freeform: "w", priorities: Array(21).fill("p") }).success).toBe(false);
  });
});

describe("composeAssistPrompt", () => {
  it("carries the selections and the freeform words verbatim", () => {
    const prompt = composeAssistPrompt({
      role: "Precision engineer",
      tools: ["Notion", "Gmail"],
      priorities: ["Ship the deslop wave", "Keep onboarding honest"],
      freeform: "I build precision tools; I want my agent to match.",
    });
    expect(prompt).toContain("Their role: Precision engineer");
    expect(prompt).toContain("Their tools: Notion, Gmail");
    expect(prompt).toContain("Ship the deslop wave; Keep onboarding honest");
    expect(prompt).toContain("I build precision tools; I want my agent to match.");
  });

  it("marks unanswered selections rather than letting the model assume", () => {
    const prompt = composeAssistPrompt({ freeform: "just words" });
    expect(prompt).toContain("Their role: not answered yet");
    expect(prompt).toContain("Their tools: not answered yet");
    expect(prompt).toContain("What matters most to them: not answered yet");
  });

  it("pairs with a system voice that forbids invention and names the default", () => {
    expect(ONBOARDING_ASSIST_SYSTEM).toMatch(/never invent/i);
    expect(ONBOARDING_ASSIST_SYSTEM).toMatch(/Polymath/);
  });
});

describe("readWizardState", () => {
  it("returns the fresh-wizard defaults for a missing row", () => {
    expect(readWizardState(null)).toEqual({ step: "role", draft: null });
  });

  it("collapses an out-of-range step to the first step", () => {
    expect(readWizardState({ step: "interview", draft: null })).toEqual({
      step: "role",
      draft: null,
    });
  });

  it("keeps a valid step and draft", () => {
    expect(
      readWizardState({
        step: "words",
        draft: { role: "Engineer", freeform: "words" },
      }),
    ).toEqual({ step: "words", draft: { role: "Engineer", freeform: "words" } });
  });

  it("collapses an unparseable draft to null while keeping the step", () => {
    expect(readWizardState({ step: "review", draft: { tools: "not-an-array" } })).toEqual({
      step: "review",
      draft: null,
    });
  });
});
