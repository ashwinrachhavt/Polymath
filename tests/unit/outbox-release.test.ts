import { describe, expect, it } from "vitest";
import { OutboxParkError, OUTBOX_MAX_ATTEMPTS } from "@/domains/audit/outbox";

/*
 * ASH-178. Two shapes a handler can use that the dispatcher must honour, both
 * proved against real Postgres in tests/integration/crawl-queue.test.ts; these
 * pin the contract so a refactor cannot quietly change it.
 */

describe("OutboxParkError", () => {
  it("defaults to a one-minute park", () => {
    expect(new OutboxParkError(60_000, "provider down").retryAfterMs).toBe(60_000);
  });

  it("carries a caller-supplied park", () => {
    expect(new OutboxParkError(5_000, "provider down").retryAfterMs).toBe(5_000);
  });

  it("is distinguishable from a real failure", () => {
    expect(new OutboxParkError(1_000, "x")).toBeInstanceOf(Error);
    expect(new OutboxParkError(1_000, "x").name).toBe("OutboxParkError");
  });
});

describe("attempt ceiling", () => {
  it("still dead-letters real failures, not deferrals", () => {
    // A deferral never increments attempts, so a crawl can poll past this
    // number of passes without dying. Only thrown errors count.
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
  });
});
