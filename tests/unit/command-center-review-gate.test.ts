import { describe, expect, it } from "vitest";
import type { Review } from "@/components/workspace/types";
import { canDecideReview } from "@/components/products/command-center/review-gate";
import { parseMicroUsd } from "@/components/products/command-center/rate-draft";
import { futureDeliveryIso } from "@/components/products/command-center/delivery-intent";

const review: Review = { id: "proposal", title: "Test", kind: "Email", payload: "Exact payload", revision: 2, risk: "External write", status: "Pending" };
const input = { payload: review.payload, reason: "I inspected the recipient", decision: "Approved locally" as const, confirmed: true, sensitiveConfirmed: false };

describe("local exact-revision review gate", () => {
  it("allows only a reasoned confirmed exact current revision", () => {
    expect(canDecideReview(review, review, input)).toBe(true);
    expect(canDecideReview(review, review, { ...input, confirmed: false })).toBe(false);
    expect(canDecideReview(review, review, { ...input, reason: "  " })).toBe(false);
  });
  it("blocks stale revisions, changed payloads, missing records and unsaved edits", () => {
    expect(canDecideReview({ ...review, revision: 3 }, review, input)).toBe(false);
    expect(canDecideReview({ ...review, payload: "Changed" }, review, input)).toBe(false);
    expect(canDecideReview(undefined, review, input)).toBe(false);
    expect(canDecideReview(review, review, { ...input, payload: "Unsaved" })).toBe(false);
    expect(canDecideReview({ ...review, status: "Approved locally" }, review, input)).toBe(false);
  });
  it("requires extra sensitive confirmation while reasoned rejection needs no approval checkbox", () => {
    const sensitive: Review = { ...review, risk: "Sensitive write" };
    expect(canDecideReview(sensitive, sensitive, input)).toBe(false);
    expect(canDecideReview(sensitive, sensitive, { ...input, sensitiveConfirmed: true })).toBe(true);
    expect(canDecideReview(review, review, { ...input, decision: "Rejected", confirmed: false })).toBe(true);
  });
});
describe("local delivery timing intent", () => {
  it("converts an explicit future time and rejects past, equal or invalid times", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(futureDeliveryIso("2026-10-12T09:00:00-07:00", now)).toBe("2026-10-12T16:00:00.000Z");
    expect(futureDeliveryIso("2026-10-11T12:00:00Z", now)).toBeNull();
    expect(futureDeliveryIso("2026-10-10T12:00:00Z", now)).toBeNull();
    expect(futureDeliveryIso("not a timestamp", now)).toBeNull();
  });
});
describe("inactive rate-card decimal parser", () => {
  it("represents explicit nonnegative prices without floating point rounding", () => {
    expect(parseMicroUsd("0")).toBe(0);
    expect(parseMicroUsd("0.000001")).toBe(1);
    expect(parseMicroUsd(" 1.234567 ")).toBe(1234567);
  });
  it("rejects guesses, negative, fractional precision and unsafe magnitudes", () => {
    for (const invalid of ["", "unknown", "-1", "0.0000001", "NaN", "1e2", "9999999999999999"]) expect(parseMicroUsd(invalid)).toBeNull();
  });
});
