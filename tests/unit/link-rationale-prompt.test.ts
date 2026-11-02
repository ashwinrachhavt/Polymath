import { describe, expect, it } from "vitest";
import { rationalePrompt } from "@/domains/knowledge/link-rationale";

describe("rationalePrompt", () => {
  const out = rationalePrompt(
    { title: "Retries improve reliability", claim: "Retries raise success rates." },
    { title: "Retries need idempotency", claim: "Retries are safe only when effects are deduplicated." },
  );
  it("names both claims and asks for one sentence", () => {
    expect(out.prompt).toContain("Retries raise success rates.");
    expect(out.prompt).toContain("Retries are safe only when effects are deduplicated.");
    expect(out.system).toMatch(/one sentence/i);
  });
  it("carries the untrusted-data clause so the titles are data, not instructions", () => {
    expect(out.system).toContain("<untrusted");
  });
});
