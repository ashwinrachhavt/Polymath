import { describe, expect, it } from "vitest";
import { ideaContextPayload } from "@/app/(workspace)/polymath/idea-context";

const idea = {
  title: "The cache is the bill",
  claim: "y".repeat(900),
  tags: ["#llms"],
  links: Array.from({ length: 8 }, (_, i) => ({ title: `Idea ${i}`, relation: "extends" })),
};

describe("ideaContextPayload", () => {
  it("carries title, claim, tags and at most five links", () => {
    const payload = ideaContextPayload(idea);
    expect(payload.title).toBe("The cache is the bill");
    expect(payload.tags).toEqual(["#llms"]);
    expect((payload.links as unknown[]).length).toBe(5);
  });
  it("cuts the claim to 600 characters", () => {
    expect((ideaContextPayload(idea).claim as string).length).toBe(600);
  });
});
