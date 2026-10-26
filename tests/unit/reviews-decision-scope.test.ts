import { describe, expect, it } from "vitest";
import { LOCAL_WRITERS } from "@/app/(workspace)/reviews/local-writes";
import { decisionOnlyFor } from "@/app/(workspace)/reviews/decision-scope";

/*
 * The card's "approving records the decision only" caveat is true only when
 * approval runs no effect at all. The local-write registry is the same map
 * the decide action dispatches through, so iterating it here pins the
 * classification to the execution path - a new apply branch that forgets the
 * registry fails to compile, and one registered but misclassified fails here.
 */
describe("decisionOnlyFor", () => {
  it("is true for a capability with no executor and no local write", () => {
    expect(decisionOnlyFor("github.issue.triage")).toBe(true);
  });

  it("is false for every registered local write", () => {
    for (const capability of Object.keys(LOCAL_WRITERS)) {
      expect(decisionOnlyFor(capability), capability).toBe(false);
    }
    expect(Object.keys(LOCAL_WRITERS).length).toBeGreaterThan(0);
  });

  it("is false for capabilities with a provider executor", () => {
    expect(decisionOnlyFor("gmail.send")).toBe(false);
  });
});
