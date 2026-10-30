import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { selectSubject, type Assertion, type Observation } from "../cases/types";

export type AssertionResult = { label: string; score: number; severity: "gate" | "soft"; passed: boolean; error?: string };
async function match(assertion: Assertion, value: unknown): Promise<boolean> {
  switch (assertion.kind) {
    case "equals": return isDeepStrictEqual(value, assertion.expected);
    case "includes": return typeof assertion.expected === "string"
      ? String(value ?? "").includes(assertion.expected)
      : new RegExp(assertion.expected.source, assertion.expected.flags).test(String(value ?? ""));
    case "satisfies": return assertion.predicate(value);
    case "matches": {
      const result = z.object({ issues: z.array(z.unknown()).optional() }).parse(await assertion.schema["~standard"].validate(value));
      return result.issues === undefined;
    }
  }
}
export async function evaluateAssertion(assertion: Assertion, value: unknown): Promise<AssertionResult> {
  try {
    const score = (await match(assertion, value)) ? 1 : 0;
    // Eve soft assertions without a threshold record a score but never fail.
    const threshold = assertion.threshold ?? (assertion.severity === "gate" ? 1 : undefined);
    return { label: assertion.label, score, severity: assertion.severity, passed: threshold === undefined || score >= threshold };
  } catch (error) {
    return { label: assertion.label, score: 0, severity: "gate", passed: false, error: String(error) };
  }
}
export async function scoreAssertions(assertions: Assertion[], observation: Observation): Promise<AssertionResult[]> {
  return Promise.all(assertions.map((assertion) => evaluateAssertion(assertion, selectSubject(assertion, observation))));
}
