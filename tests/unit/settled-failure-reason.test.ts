import { describe, expect, it } from "vitest";
import { settledFailureReason } from "@/domains/capture/enrichment-handler";

/*
 * The failure-reason key (ASH-318): enrichment clears a recorded failure only
 * when the ladder has a usable grounded body. Whitespace is nothing and a
 * bare URL is a pointer, not the page's text.
 */
describe("settledFailureReason", () => {
  const reason = "The page could not be read: the site returned no readable text.";

  it("clears the reason when real text grounds the ladder", () => {
    expect(settledFailureReason({ failureReason: reason }, "The actual page text.")).toBeNull();
  });

  it("keeps the reason on an empty or whitespace-only body", () => {
    expect(settledFailureReason({ failureReason: reason }, "")).toBe(reason);
    expect(settledFailureReason({ failureReason: reason }, "   \n  ")).toBe(reason);
  });

  it("keeps the reason on a bare-URL body: a pointer, not grounded text", () => {
    expect(settledFailureReason({ failureReason: reason }, "https://example.com/only-a-pointer")).toBe(reason);
    expect(settledFailureReason({ failureReason: reason }, "  http://example.com/x  ")).toBe(reason);
  });

  it("clears a null reason to null either way", () => {
    expect(settledFailureReason({ failureReason: null }, "")).toBeNull();
    expect(settledFailureReason({ failureReason: null }, "words")).toBeNull();
  });
});
