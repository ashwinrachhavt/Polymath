import { describe, expect, it } from "vitest";
import {
  EARLIER_TURN_RESULT_CHARS,
  applyLane,
  estimatedTurnInputTokens,
  stepsThisTurn,
  type CallOptions,
} from "../../eve/polymath/agent/lib/lane-model";
import type { TurnRoute } from "@/domains/agents/turn-routing";

const tool = (name: string) => ({ type: "function", name, description: `${name} tool`, inputSchema: {} });
const ROOT_TOOLS = [
  "agent",
  "documents_search",
  "web_search",
  "web_fetch",
  "tasks_read",
  "tasks_recent",
  "wiki_read",
  "eve__search",
].map(tool);

const route = (lane: TurnRoute["lane"], needsLibrary = false): TurnRoute => ({
  lane,
  needsLibrary,
  confidence: 1,
  source: "rule",
});
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const call = (toolName: string) => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: toolName, toolName, input: {} }],
});
const result = (toolName: string, value: string) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: toolName, toolName, output: { type: "text", value } }],
});

function options(prompt: CallOptions["prompt"], tools = ROOT_TOOLS): CallOptions {
  return { prompt: [{ role: "system", content: "system" }, ...prompt], tools, toolChoice: { type: "auto" } };
}

const names = (o: CallOptions) => (o.tools ?? []).map((t) => t.name);
const lastUserText = (o: CallOptions) => {
  const last = [...o.prompt].reverse().find((m) => m.role === "user");
  return Array.isArray(last?.content) ? last.content.map((p) => p.text ?? "").join("") : String(last?.content);
};

describe("tool visibility", () => {
  it("shows a quick turn no tools at all", () => {
    const { options: next } = applyLane(options([user("hi")]), route("quick"));
    expect(next.tools).toBeUndefined();
    expect(next.toolChoice).toBeUndefined();
  });

  it("hides the library from a general question", () => {
    const { options: next } = applyLane(options([user("TCP vs UDP?")]), route("answer"));
    expect(names(next)).toEqual(["web_search", "web_fetch", "tasks_read", "tasks_recent"]);
  });

  it("shows the library, directly, when the route needs it", () => {
    const { options: next } = applyLane(options([user("my rent?")]), route("answer", true));
    expect(names(next)).toContain("documents_search");
    expect(names(next)).not.toContain("eve__search");
  });

  it("gives a research turn only the delegation tool, and the specialist copy the gathering tools", () => {
    expect(names(applyLane(options([user("research X")]), route("research")).options)).toEqual(["agent"]);
    const copyTools = ROOT_TOOLS.filter((t) => t.name !== "agent");
    const { options: copy, decision } = applyLane(options([user("brief")], copyTools), route("research"));
    expect(decision.inSpecialist).toBe(true);
    expect(names(copy)).toEqual(["web_search", "web_fetch"]);
  });
});

describe("caps", () => {
  it("counts the model calls already made this turn", () => {
    const prompt = [
      user("old"),
      call("web_search"),
      result("web_search", "x"),
      user("now"),
      call("web_search"),
      result("web_search", "y"),
    ];
    expect(stepsThisTurn(prompt)).toBe(1);
  });

  it("forces an answer at the lane's last step, keeping tool definitions for the cache", () => {
    const prompt = [
      user("q"),
      call("web_search"),
      result("web_search", "a"),
      call("web_fetch"),
      result("web_fetch", "b"),
      call("web_fetch"),
      result("web_fetch", "c"),
    ];
    const { options: next, decision } = applyLane(options(prompt), route("answer"));
    expect(decision.forcedAnswer).toBe(true);
    expect(next.toolChoice).toEqual({ type: "none" });
    expect(names(next).length).toBeGreaterThan(0);
    expect(lastUserText(next)).toContain("last step for this turn");
  });

  it("forces an answer when the turn's input budget is spent", () => {
    const big = "x".repeat(130_000);
    const prompt = [
      user("q"),
      call("web_fetch"),
      result("web_fetch", big),
      call("web_fetch"),
      result("web_fetch", big),
    ];
    expect(estimatedTurnInputTokens(prompt, 0)).toBeGreaterThan(30_000);
    const { decision } = applyLane(options(prompt), route("answer"));
    expect(decision.forcedAnswer).toBe(true);
  });
});

describe("context", () => {
  it("trims earlier turns' tool results hard and keeps the current turn's", () => {
    const page = "p".repeat(5_000);
    const prompt = [
      user("old"),
      call("web_fetch"),
      result("web_fetch", page),
      user("new"),
      call("web_fetch"),
      result("web_fetch", page),
    ];
    const { options: next } = applyLane(options(prompt), route("answer"));
    const results = next.prompt
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as { output: { value: string } }[])[0]!.output.value);
    expect(results[0]!.length).toBeLessThan(EARLIER_TURN_RESULT_CHARS + 100);
    expect(results[0]).toContain("trimmed");
    expect(results[1]).toBe(page);
  });

  it("puts the lane note at the end of the person's message, leaving the system prompt alone", () => {
    const { options: next } = applyLane(options([user("hi")]), route("quick"));
    expect(next.prompt[0]).toEqual({ role: "system", content: "system" });
    expect(lastUserText(next)).toMatch(/^hi\n\n\[Small talk/);
  });
});
