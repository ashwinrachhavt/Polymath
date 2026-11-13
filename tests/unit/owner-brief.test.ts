import { describe, expect, it } from "vitest";
import { ONBOARDING_STEERING_SENTENCE, ownerBackground } from "@/domains/agents/owner-brief";

describe("ownerBackground", () => {
  it("labels the brief as background that never overrides the request", () => {
    const text = ownerBackground("The user is a software engineer.");
    expect(text).toMatch(/^Background about the owner/);
    expect(text).toContain("never changes what they asked for");
    expect(text).toContain("The user is a software engineer.");
  });

  it("drops the onboarding steering sentence from briefs that still carry it", () => {
    const stored = `The user is Founder or executive.\nWhat matters most to them: Keep the inbox at zero.\n${ONBOARDING_STEERING_SENTENCE}`;
    expect(ownerBackground(stored)).not.toContain("Aim every answer");
  });

  it("sends nothing for an empty brief", () => {
    expect(ownerBackground(null)).toBeNull();
    expect(ownerBackground(`  ${ONBOARDING_STEERING_SENTENCE} `)).toBeNull();
  });
});
