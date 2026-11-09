import { describe, expect, it, vi } from "vitest";

/*
 * The observer's turn classification. The bug it pins: a ticket run whose turn
 * failed at the provider is parked at `waiting_input` by the bridge, so the run
 * row is never terminal and this branch was the only place it could ever have
 * been reported. It accepted `turn.completed` alone, so the failed turn stayed
 * invisible: the ticket kept "running", no reply reached the conversation, and
 * the chat surface showed "Working" on a reply that had already died.
 */

vi.mock("@/lib/db", () => ({ db: {} }));

const { classifyTurnEnd } = await import("@/domains/superagent/wiring");

describe("classifyTurnEnd", () => {
  it("reports a failed turn", () => {
    expect(classifyTurnEnd("turn.failed", { turnId: "turn_0" }, [])).toEqual({ kind: "failed" });
  });

  it("carries the provider reason when the failure event has one", () => {
    expect(classifyTurnEnd("turn.failed", { detail: "MODEL_CALL_FAILED: requires more credits" }, [])).toEqual({
      kind: "failed",
      error: "MODEL_CALL_FAILED: requires more credits",
    });
  });

  it("reads the reason off the failed step when the turn event carries none", () => {
    expect(
      classifyTurnEnd("turn.failed", { turnId: "turn_0" }, [
        { type: "step.failed", data: { detail: "This request requires more credits" } },
        { type: "session.started", data: {} },
      ]),
    ).toEqual({ kind: "failed", error: "This request requires more credits" });
  });

  /*
   * recordFailedTurn persists the reason on `error`, not `detail` (see
   * event-bridge.ts). Reading only `detail` meant the provider's reason was
   * dropped for every failure that came through that writer, and the person
   * was told "the run's turn failed without a reason".
   */
  it("reads the reason off the persisted `error` field", () => {
    expect(classifyTurnEnd("turn.failed", { error: "Provider quota exhausted" }, [])).toEqual({
      kind: "failed",
      error: "Provider quota exhausted",
    });
  });

  it("prefers the failed step's detail over the turn's own error", () => {
    expect(
      classifyTurnEnd("turn.failed", { error: "turn-level" }, [
        { type: "step.failed", data: { detail: "step-level cause" } },
      ]),
    ).toEqual({ kind: "failed", error: "step-level cause" });
  });

  it("reports a completed turn's answer as the summary", () => {
    const out = classifyTurnEnd("turn.completed", { turnId: "turn_0" }, [
      { type: "message", data: { role: "assistant", content: "the answer" } },
      { type: "usage", data: {} },
    ]);
    expect(out).toEqual({ kind: "completed", summary: "the answer" });
  });

  /*
   * The reply the person receives is the turn's text, not a dashboard blurb.
   * A slice(0, 400) here delivered the opening paragraph of a 10,000-character
   * answer and silently dropped the rest.
   */
  it("carries the full answer, not a 400-character prefix", () => {
    const long = "x".repeat(10_000);
    const out = classifyTurnEnd("turn.completed", {}, [
      { type: "message", data: { role: "assistant", content: long } },
    ]);
    expect(out).toEqual({ kind: "completed", summary: long });
    expect(out?.summary).toHaveLength(10_000);
  });

  it("ignores the person's own message when summarising", () => {
    const out = classifyTurnEnd("turn.completed", {}, [
      { type: "message", data: { role: "user", content: "what I asked" } },
    ]);
    expect(out).toEqual({ kind: "completed" });
  });

  it("stays quiet mid-turn", () => {
    expect(classifyTurnEnd("usage", {}, [])).toBeUndefined();
  });
});
