import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_CEILING,
  TERMINAL_POLL_KINDS,
  advancePoll,
  failureCopy,
  phaseLabel,
  shouldStopPolling,
} from "@/components/documents/upload-dropzone";
import type { RequestFailure, RequestFailureKind } from "@/lib/client-request";

/*
 * The upload poll used to treat every non-OK status as a blip, so an expired
 * session looped for three minutes and then blamed the queue worker. These pin
 * both halves of the decision: which kinds end the loop, and how many
 * consecutive throttles end it. The component itself is not mounted; the loop
 * only ever acts on these two pure results.
 */

const ALL_KINDS: RequestFailureKind[] = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "validation",
  "rate_limited",
  "server",
  "network",
  "aborted",
  "malformed",
];

// `aborted` stops too, but it is a cancellation rather than a server verdict,
// so it is not part of the terminal-kind set that models permanent causes.
const NON_TERMINAL = ALL_KINDS.filter((kind) => !TERMINAL_POLL_KINDS.has(kind) && kind !== "aborted");

function failure(kind: RequestFailureKind, title = `${kind} copy`): RequestFailure {
  return { kind, title };
}

const stop = (kind: RequestFailureKind) => ({ action: "stop", message: `${kind} copy` });

describe("shouldStopPolling", () => {
  it("pins the terminal set to auth, permission, and gone", () => {
    expect([...TERMINAL_POLL_KINDS].sort()).toEqual(["forbidden", "not_found", "unauthenticated"]);
  });

  it.each([...TERMINAL_POLL_KINDS])("%s stops with the failure's own copy", (kind) => {
    expect(shouldStopPolling(failure(kind))).toEqual(stop(kind));
  });

  it.each(NON_TERMINAL)("%s continues", (kind) => {
    expect(shouldStopPolling(failure(kind)).action).toBe("continue");
  });

  it("flags only rate_limited for counting", () => {
    for (const kind of NON_TERMINAL) {
      const decision = shouldStopPolling(failure(kind));
      expect(decision.action === "continue" && decision.rateLimited).toBe(kind === "rate_limited");
    }
  });

  it("stops on a cancellation instead of retrying a request the caller aborted", () => {
    expect(shouldStopPolling(failure("aborted"))).toEqual(stop("aborted"));
    expect(advancePoll({ ok: false, failure: failure("aborted") }, 3)).toEqual(stop("aborted"));
  });

  it("keeps the exact auth copy a person needs to act on", () => {
    const decision = shouldStopPolling({
      kind: "unauthenticated",
      title: "Your session has expired. Sign in again, then retry.",
    });
    expect(decision).toEqual({ action: "stop", message: "Your session has expired. Sign in again, then retry." });
  });
});

describe("advancePoll", () => {
  it("aborts immediately on a terminal failure regardless of streak", () => {
    expect(advancePoll({ ok: false, failure: failure("unauthenticated") }, 7)).toEqual(stop("unauthenticated"));
    expect(advancePoll({ ok: false, failure: failure("not_found") }, 0)).toEqual(stop("not_found"));
  });

  it("a network blip keeps the loop going and does not accrue a throttle", () => {
    expect(advancePoll({ ok: false, failure: failure("network") }, 0)).toEqual({
      action: "continue",
      rateLimitStreak: 0,
    });
  });

  it("stops on the 20th consecutive rate limit", () => {
    let streak = 0;
    for (let i = 1; i < RATE_LIMIT_CEILING; i += 1) {
      const step = advancePoll({ ok: false, failure: failure("rate_limited") }, streak);
      expect(step.action).toBe("continue");
      if (step.action === "continue") streak = step.rateLimitStreak;
      expect(streak).toBe(i);
    }
    expect(advancePoll({ ok: false, failure: failure("rate_limited") }, streak)).toEqual(stop("rate_limited"));
  });

  it("a successful poll resets an accrued throttle streak", () => {
    let streak = 0;
    for (let i = 0; i < RATE_LIMIT_CEILING - 1; i += 1) {
      const step = advancePoll({ ok: false, failure: failure("rate_limited") }, streak);
      if (step.action === "continue") streak = step.rateLimitStreak;
    }
    expect(streak).toBe(RATE_LIMIT_CEILING - 1);
    const reset = advancePoll({ ok: true }, streak);
    expect(reset).toEqual({ action: "continue", rateLimitStreak: 0 });
    // One more throttle after the reset must not tip over the ceiling.
    expect(advancePoll({ ok: false, failure: failure("rate_limited") }, 0)).toEqual({
      action: "continue",
      rateLimitStreak: 1,
    });
  });

  it("a non-throttle failure between throttles also breaks the streak", () => {
    const step = advancePoll({ ok: false, failure: failure("server") }, RATE_LIMIT_CEILING - 1);
    expect(step).toEqual({ action: "continue", rateLimitStreak: 0 });
  });
});

describe("phaseLabel", () => {
  it("renders the failure's cause, not a bare status word", () => {
    const copy = "Your session has expired. Sign in again, then retry.";
    expect(phaseLabel({ kind: "error", message: copy })).toBe(copy);
  });

  it("keeps the progress labels", () => {
    expect(phaseLabel({ kind: "uploading", percent: 42 })).toBe("Uploading 42%");
    expect(phaseLabel({ kind: "reading" })).toBe("Reading the text…");
    expect(phaseLabel({ kind: "done", documentId: "d1" })).toBe("Read");
  });
});

/*
 * The original defect was in the JSX, not the helper: the row rendered a
 * hardcoded status word while `phaseLabel` did the right thing. The helper
 * passing proves nothing about what a person sees, so the render path is
 * asserted from the source, the same way motion-config pins its provider.
 */
describe("upload row rendering", () => {
  const source = readFileSync("src/components/documents/upload-dropzone.tsx", "utf8");

  it("renders phaseLabel(entry.phase) inside the row", () => {
    expect(source).toMatch(/\{phaseLabel\(entry\.phase\)\}/);
  });

  it('does not hardcode "Failed" in that row label paragraph', () => {
    const label = source.match(/<p\b[^>]*>\s*\{phaseLabel\(entry\.phase\)\}\s*<\/p>/);
    expect(label).not.toBeNull();
    expect(label?.[0]).not.toMatch(/Failed/);
  });
});

describe("failureCopy", () => {
  it("announces the cause of a failure alongside the counts", () => {
    const copy = failureCopy([
      { phase: { kind: "done", documentId: "d1" } },
      { phase: { kind: "error", message: "Network error." } },
    ]);
    expect(copy).toBe(", failed: Network error.");
  });

  it("announces nothing when no entry failed", () => {
    expect(failureCopy([{ phase: { kind: "reading" } }])).toBe("");
    expect(failureCopy([])).toBe("");
  });
});
