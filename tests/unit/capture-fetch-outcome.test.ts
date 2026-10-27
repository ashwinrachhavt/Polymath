import { describe, expect, it } from "vitest";
import { classifyFetchOutcome } from "@/domains/capture/fetch-outcome";

describe("classifyFetchOutcome", () => {
  it("is acquired for readable content with no error", () => {
    const r = classifyFetchOutcome({ markdown: "# Page\n\nbody" });
    expect(r.outcome).toBe("acquired");
    expect(r.text).toContain("body");
  });
  it("is error-page for a 404 with a readable body", () => {
    expect(classifyFetchOutcome({ markdown: "Not found", error: "404", statusCode: 404 }).outcome).toBe("error-page");
  });
  it("is error-page when the provider reports an error and no status", () => {
    expect(classifyFetchOutcome({ markdown: "gone", error: "render failed" }).outcome).toBe("error-page");
  });
  it("is empty for no readable text", () => {
    const r = classifyFetchOutcome({ markdown: "   " });
    expect(r.outcome).toBe("empty");
    expect(r.text).toBeNull();
  });
  it("never returns text for error-page or empty", () => {
    expect(classifyFetchOutcome({ markdown: "x", statusCode: 500 }).text).toBeNull();
    expect(classifyFetchOutcome({ markdown: "" }).text).toBeNull();
  });
});
