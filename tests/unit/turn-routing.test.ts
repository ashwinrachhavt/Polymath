import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ClassifyJudger } from "@/integrations/jev/provider";
import { personsRequest, routeByRule, routeTurn } from "@/domains/agents/turn-routing";

function jev(lane: string, confidence: number, library = 0.1): ClassifyJudger {
  return {
    judge: vi.fn(async () => ({
      model: "jev-test",
      answers: {
        lane: { type: "choice" as const, choice: lane, confidence, probabilities: { [lane]: confidence } },
        library: { type: "noul" as const, noul: library },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    })),
  };
}

function smallModel(reply: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: reply }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe("rules", () => {
  it.each([
    "hi",
    "Hey!",
    "good morning",
    "thanks, that's really helpful!",
    "ok",
    "Still thinking?",
    "Reply with exactly: done.",
  ])("routes %j to quick without a classifier", (text) => {
    expect(routeByRule(text)).toEqual({ lane: "quick", needsLibrary: false, confidence: 1, source: "rule" });
  });

  it.each(["hi, what's the difference between TCP and UDP?", "thanks — now draft the email", "How much is my rent?"])(
    "leaves %j to the classifier",
    (text) => {
      expect(routeByRule(text)).toBeNull();
    },
  );
});

describe("the person's request inside a ticket wrapper", () => {
  it("reads the words after the audit card, not the ticket boilerplate", () => {
    const objective = [
      "Ticket id: t-1",
      "Ticket: Rent question",
      "Scope of your mandate: answer the person",
      "The request that started this ticket:\nA person wrote on chat at 2026-11-13T08:00:00Z:\nhi",
      "Further messages that arrive on this ticket reach you here as they come. Report progress as you go.",
    ].join("\n\n");
    expect(personsRequest(objective)).toBe("hi");
  });

  it("takes the latest card and drops a trailing note", () => {
    const message =
      "A person wrote on chat at t1:\nfirst\n\nA person wrote on chat (dm) at t2:\nsecond line\n\nNote: context";
    expect(personsRequest(message)).toBe("second line");
  });

  it("returns plain text unchanged", () => {
    expect(personsRequest("  Summarize my leases ")).toBe("Summarize my leases");
  });
});

describe("the cascade", () => {
  it("never calls Jev for a rule-routed turn", async () => {
    const judge = jev("research", 0.9);
    const route = await routeTurn({ text: "A person wrote on chat at t:\nthanks!", judge });
    expect(route.lane).toBe("quick");
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("takes a confident Jev lane and its library answer", async () => {
    const route = await routeTurn({ text: "How much is my rent?", judge: jev("answer", 0.8, 0.9) });
    expect(route).toEqual({ lane: "answer", needsLibrary: true, confidence: 0.8, source: "jev" });
  });

  it("asks the small model when Jev is unsure", async () => {
    const route = await routeTurn({
      text: "Intangible.ai",
      judge: jev("answer", 0.3),
      smallModel: smallModel('{"lane": "research", "library": false}'),
    });
    expect(route).toEqual({ lane: "research", needsLibrary: false, confidence: 0.6, source: "llm" });
  });

  it("keeps the unsure Jev answer when the small model fails", async () => {
    const route = await routeTurn({
      text: "Intangible.ai",
      judge: jev("research", 0.3),
      smallModel: smallModel("no idea"),
    });
    expect(route.source).toBe("jev");
    expect(route.lane).toBe("research");
  });

  it("falls back to the generalist lane, keeping the library cue, when every classifier fails", async () => {
    const failing: ClassifyJudger = { judge: async () => Promise.reject(new Error("down")) };
    const route = await routeTurn({ text: "what did I write in my notes about attention?", judge: failing });
    expect(route).toEqual({ lane: "answer", needsLibrary: true, confidence: 0, source: "fallback" });
  });
});
