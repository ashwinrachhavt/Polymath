import { describe, expect, it } from "vitest";
import { shouldStopPolling } from "@/components/documents/upload-dropzone";
import type { RequestFailure } from "@/lib/client-request";

/*
 * The upload poll used to treat every non-OK status as a blip, so an expired
 * session looped for three minutes and then blamed the queue worker. These
 * pin the classification: a terminal cause stops at once with its own copy, a
 * blip and a throttle stay retryable.
 */

function failure(kind: RequestFailure["kind"], title = `${kind} copy`): RequestFailure {
  return { kind, title };
}

describe("shouldStopPolling", () => {
  it("stops on an expired session and keeps the auth copy", () => {
    const decision = shouldStopPolling(failure("unauthenticated", "Your session has expired. Sign in again, then retry."));
    expect(decision).toEqual({ action: "stop", message: "Your session has expired. Sign in again, then retry." });
  });

  it("stops on a forbidden document", () => {
    expect(shouldStopPolling(failure("forbidden"))).toEqual({ action: "stop", message: "forbidden copy" });
  });

  it("stops when the document is gone", () => {
    expect(shouldStopPolling(failure("not_found"))).toEqual({ action: "stop", message: "not_found copy" });
  });

  it("keeps a network blip retryable and does not count it", () => {
    expect(shouldStopPolling(failure("network"))).toEqual({ action: "continue", rateLimited: false });
  });

  it("continues on a rate limit but flags it so the loop can bound itself", () => {
    expect(shouldStopPolling(failure("rate_limited"))).toEqual({ action: "continue", rateLimited: true });
  });

  it("treats a server error and a malformed body as retryable", () => {
    expect(shouldStopPolling(failure("server")).action).toBe("continue");
    expect(shouldStopPolling(failure("malformed")).action).toBe("continue");
  });
});
