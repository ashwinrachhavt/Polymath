import { describe, expect, it, vi } from "vitest";
import { JevRequestError, JevUnconfiguredError } from "@/integrations/jev/client";
import { JevDisabledError, type ClassifyJudger, type JevJudgeResult } from "@/integrations/jev/provider";
import { QuotaExhaustedError } from "@/integrations/providers/quota";
import {
  CHAT_LANES,
  LANE_CRITERIA,
  LANE_QUESTION,
  laneFromAnswer,
  routeChatMessage,
} from "@/domains/superagent/routing";

/*
 * Chat routing is advisory and must never break a send. Every spec below is
 * one of the two promises: a good answer becomes a lane, and any failure —
 * disabled provider, unconfigured key, exhausted quota, slow call, unknown
 * choice — becomes `answer` with a reason instead of an exception.
 */

function judgeReturning(answer: unknown, onCall?: () => void): ClassifyJudger {
  return {
    async judge() {
      onCall?.();
      return {
        model: "jev-1.14.0",
        answers: { lane: answer as JevJudgeResult["answers"][string] },
        usage: { input_tokens: 12, output_tokens: 1 },
      };
    },
  };
}

function judgeThrowing(cause: unknown): ClassifyJudger {
  return {
    async judge() {
      throw cause;
    },
  };
}

const choice = (name: string) => ({
  type: "choice" as const,
  choice: name,
  confidence: 0.9,
  probabilities: { [name]: 0.9 },
});

const MESSAGE = "compare the two pricing pages and tell me which one wins";

const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("the lane question", () => {
  it("offers exactly the lanes the type declares, each with a criterion", () => {
    expect(Object.keys(LANE_QUESTION.criteria).sort()).toEqual([...CHAT_LANES].sort());
    for (const lane of CHAT_LANES) expect(LANE_CRITERIA[lane].length).toBeGreaterThan(0);
  });
});

describe("laneFromAnswer", () => {
  it("reads a known choice", () => {
    expect(laneFromAnswer(choice("research"))).toBe("research");
  });

  it("rejects an unknown choice, a noul answer, and junk", () => {
    expect(laneFromAnswer(choice("write-a-poem"))).toBeUndefined();
    expect(laneFromAnswer({ type: "noul", noul: 0.8 })).toBeUndefined();
    expect(laneFromAnswer(null)).toBeUndefined();
    expect(laneFromAnswer("research")).toBeUndefined();
  });
});

describe("routeChatMessage", () => {
  it("returns the lane Jev chose", async () => {
    const decision = await routeChatMessage({
      workspaceId,
      text: MESSAGE,
      judge: judgeReturning(choice("research")),
    });
    expect(decision).toEqual({ lane: "research", routed: true, source: "jev" });
  });

  it("does not call the classifier when routing is switched off", async () => {
    let called = false;
    const decision = await routeChatMessage({
      workspaceId,
      text: MESSAGE,
      env: { POLYMATH_CHAT_ROUTING: "off" },
      judge: judgeReturning(choice("research"), () => {
        called = true;
      }),
    });
    expect(decision).toEqual({ lane: "answer", routed: false, reason: "disabled" });
    expect(called).toBe(false);
  });

  it("does not spend on a message too short to be a request", async () => {
    let called = false;
    const decision = await routeChatMessage({
      workspaceId,
      text: "thanks!",
      env: {},
      judge: judgeReturning(choice("answer"), () => {
        called = true;
      }),
    });
    expect(decision).toEqual({ lane: "answer", routed: false, reason: "too_short" });
    expect(called).toBe(false);
  });

  it("falls back when the answer names no known lane", async () => {
    const decision = await routeChatMessage({
      workspaceId,
      text: MESSAGE,
      env: {},
      judge: judgeReturning(choice("synthesize")),
    });
    expect(decision).toEqual({ lane: "answer", routed: false, reason: "unrecognized_answer" });
  });

  it.each([
    ["a disabled provider", new JevDisabledError("disabled"), "provider_disabled"],
    ["an unconfigured key", new JevUnconfiguredError(), "unconfigured"],
    ["an exhausted quota", new QuotaExhaustedError("jev", "2026-11", 0), "quota_exhausted"],
    ["a provider failure", new JevRequestError("jev", 502), "provider_error"],
    ["an unknown failure", new Error("boom"), "provider_error"],
  ])("falls back to answer on %s", async (_label, cause, reason) => {
    const decision = await routeChatMessage({
      workspaceId,
      text: MESSAGE,
      env: {},
      judge: judgeThrowing(cause),
    });
    expect(decision).toEqual({ lane: "answer", routed: false, reason });
  });

  it("stops waiting on a slow classifier instead of holding the send", async () => {
    const never: ClassifyJudger = { judge: () => new Promise<JevJudgeResult>(() => {}) };
    const decision = await routeChatMessage({
      workspaceId,
      text: MESSAGE,
      env: {},
      judge: never,
      timeoutMs: 10,
    });
    expect(decision).toEqual({ lane: "answer", routed: false, reason: "timeout" });
  });

  it("logs an unexpected failure but not a provider that ships switched off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await routeChatMessage({
        workspaceId,
        text: MESSAGE,
        env: {},
        judge: judgeThrowing(new JevDisabledError("disabled")),
      });
      expect(warn).not.toHaveBeenCalled();

      await routeChatMessage({
        workspaceId,
        text: MESSAGE,
        env: {},
        judge: judgeThrowing(new JevRequestError("jev", 500)),
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
