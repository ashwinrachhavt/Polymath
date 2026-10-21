import { describe, expect, it } from "vitest";
import { StreamHttpError, describeStreamFailure } from "@/components/chat/stream-errors";

describe("describeStreamFailure", () => {
  it("does not offer retry when access or the run is gone", () => {
    for (const status of [401, 403, 404]) {
      expect(describeStreamFailure(new StreamHttpError(status)).retryable, String(status)).toBe(false);
    }
  });

  it("names a service outage and keeps retry available", () => {
    const failure = describeStreamFailure(new StreamHttpError(503));
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("unavailable");
    expect(failure.message).not.toMatch(/\b503\b/);
  });

  it("treats a network error as a dropped connection", () => {
    expect(describeStreamFailure(new TypeError("Failed to fetch"))).toEqual({ message: "The connection dropped.", retryable: true });
  });
});
