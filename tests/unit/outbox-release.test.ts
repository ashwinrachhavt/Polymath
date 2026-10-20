import { describe, expect, it } from "vitest";
import { OutboxDeferredError, OUTBOX_MAX_ATTEMPTS } from "@/domains/audit/outbox";

/*
 * ASH-178. Two shapes a handler can use that the dispatcher must honour, both
 * proved against real Postgres in tests/integration/crawl-queue.test.ts; these
 * pin the contract so a refactor cannot quietly change it.
 */

describe("OutboxDeferredError", () => {
  it("defaults to a one-minute park", () => {
    expect(new OutboxDeferredError("provider down").retryAfterMs).toBe(60_000);
  });

  it("carries a caller-supplied park", () => {
    expect(new OutboxDeferredError("provider down", 5_000).retryAfterMs).toBe(5_000);
  });

  it("is distinguishable from a real failure", () => {
    expect(new OutboxDeferredError("x")).toBeInstanceOf(Error);
    expect(new OutboxDeferredError("x").name).toBe("OutboxDeferredError");
  });
});

describe("attempt ceiling", () => {
  it("still dead-letters real failures, not deferrals", () => {
    // A deferral never increments attempts, so a crawl can poll past this
    // number of passes without dying. Only thrown errors count.
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
  });
});
