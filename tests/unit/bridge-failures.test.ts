import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeFailureCount, reportBridgeFailure } from "@/domains/agents/bridge-failures";

/*
 * guarded() must stay silent to the user (a mirror write never breaks the
 * turn) but loud to the operator: one structured, redacted line and a
 * process-local counter. This proves the loud half — the guarantee that a
 * swallowed failure leaves evidence, and that the evidence itself leaks
 * nothing.
 */

const spy = vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => {
  spy.mockClear();
});

describe("reportBridgeFailure", () => {
  it("counts every failure and returns the running count", () => {
    const before = bridgeFailureCount();
    expect(reportBridgeFailure("step.completed usage", new Error("first"))).toBe(before + 1);
    expect(reportBridgeFailure("session.started", new Error("second"))).toBe(before + 2);
    expect(bridgeFailureCount()).toBe(before + 2);
  });

  it("emits exactly one structured line per failure", () => {
    const before = bridgeFailureCount();
    reportBridgeFailure("mirrorMessage", new Error("write failed"));
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "error",
      scope: "event-bridge",
      op: "mirrorMessage",
      failureCount: before + 1,
      error: "write failed",
    });
  });

  it("redacts secret-looking fragments in the emitted line", () => {
    reportBridgeFailure("recordUsageEvent", new Error("gateway 500: token=sk-secret-123 payload"));
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("sk-secret-123");
    expect((JSON.parse(line) as { error: string }).error).toContain("[redacted]");
  });

  it("stringifies a non-Error cause", () => {
    reportBridgeFailure("closeRun", "a string was thrown");
    expect((JSON.parse(spy.mock.calls[0]?.[0] as string) as { error: string }).error).toBe("a string was thrown");
  });
});
