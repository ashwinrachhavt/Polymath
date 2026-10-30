import type { AssertionResult } from "./matchers";
export type Verdict = "passed" | "failed" | "scored" | "skipped";
export function verdict(assertions: AssertionResult[], error?: string, skipReason?: string): Verdict {
  if (error !== undefined || assertions.some((item) => !item.passed && item.severity === "gate")) return "failed";
  if (skipReason !== undefined) return "skipped";
  return assertions.some((item) => !item.passed) ? "scored" : "passed";
}
export function exitCode(verdicts: Verdict[], strict = false, configError = false): 0 | 1 | 2 {
  if (configError || verdicts.length === 0) return 2;
  return verdicts.some((value) => value === "failed" || (strict && value === "scored")) ? 1 : 0;
}
