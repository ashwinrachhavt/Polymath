import { describe, expect, it } from "vitest";
import { z } from "zod";
import { equals, includes, satisfies, matches } from "eve/evals/expect";
import { loadCases, parseCase, type Assertion } from "../../evals-langgraph/src/cases/types";
import { evaluateAssertion } from "../../evals-langgraph/src/scoring/matchers";
import { exitCode, verdict } from "../../evals-langgraph/src/scoring/verdict";
import { assertEvalEnvironment } from "../../evals-langgraph/src/env-gate";
import { readConfig } from "../../evals-langgraph/src/config";
const common = { target: "reply", severity: "gate", label: "test" } as const;
const schema = z.object({ name: z.string() });
const rows: { assertion: Assertion; value: unknown; eve: ReturnType<typeof equals> }[] = [
  { assertion: { ...common, kind: "equals", expected: { a: [1] } }, value: { a: [1] }, eve: equals({ a: [1] }) },
  { assertion: { ...common, kind: "equals", expected: "x" }, value: "y", eve: equals("x") },
  { assertion: { ...common, kind: "includes", expected: "42" }, value: 42, eve: includes("42") },
  { assertion: { ...common, kind: "includes", expected: /yes/gi }, value: "YES", eve: includes(/yes/gi) },
  { assertion: { ...common, kind: "includes", expected: "x" }, value: null, eve: includes("x") },
  { assertion: { ...common, kind: "satisfies", predicate: (v) => v === true }, value: true, eve: satisfies((v) => v === true, "true") },
  { assertion: { ...common, kind: "matches", schema }, value: { name: "Sam" }, eve: matches(schema) },
  { assertion: { ...common, kind: "matches", schema }, value: {}, eve: matches(schema) },
];
describe("LangGraph parity", () => {
  it.each(rows)("matches eve $assertion.kind for $value", async ({ assertion, value, eve }) => {
    expect((await evaluateAssertion(assertion, value)).score).toBe(await eve.score(value));
  });
  it("preserves soft defaults, thresholds, errors, skipped precedence and strict promotion", async () => {
    const assertion: Assertion = { ...common, kind: "equals", expected: "x", severity: "soft" };
    expect(verdict([await evaluateAssertion(assertion, "y")])).toBe("passed");
    const result = await evaluateAssertion({ ...assertion, threshold: 0.5 }, "y");
    expect(verdict([result])).toBe("scored");
    expect(exitCode([verdict([result])])).toBe(0);
    expect(exitCode([verdict([result])], true)).toBe(1);
    expect(verdict([], undefined, "not applicable")).toBe("skipped");
    expect(verdict([], "error", "skip")).toBe("failed");
    expect(exitCode([], false)).toBe(2);
    const errored = await evaluateAssertion({ ...common, kind: "satisfies", predicate: () => { throw new Error("broken"); }, severity: "soft" }, 0);
    expect(verdict([errored])).toBe("failed");
  });
  it("validates named fields and duplicate ids", () => {
    expect(() => parseCase({ objective: "" })).toThrow(/objective/);
    const item = { id: "test", suite: "routing", fixtureOnly: true, objective: "test", assertions: [{ ...common, kind: "equals", expected: true }] };
    expect(parseCase(item).estimateUsd).toBe("0.50");
    expect(() => loadCases([item, item])).toThrow(/Duplicate.*test/);
    expect(() => parseCase({ ...item, objective: "x".repeat(2001) })).toThrow(/objective/);
  });
  it("isolates credentials and refuses non-local targets", () => {
    expect(() => assertEvalEnvironment({ LANGFUSE_SECRET_KEY: "test", EVE_BRIDGE_SECRET: "local" })).not.toThrow();
    expect(() => assertEvalEnvironment({ COMPOSIO_API_KEY: "do not print me" })).toThrow(/COMPOSIO_API_KEY/);
    expect(() => readConfig({ POLYMATH_EVAL_BASE_URL: "https://example.com" })).toThrow(/loopback/);
    expect(readConfig({}).auth.kind).toBe("dev-user");
  });
});
