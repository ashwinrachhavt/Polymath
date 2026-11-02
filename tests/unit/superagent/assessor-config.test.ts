/**
 * The assessor's configuration seam: env parsed once at wiring time, failing
 * loudly on a bad value instead of failing a request later (the executor's
 * slots.ts discipline). These tests pin the defaults, the overrides, and the
 * loud-failure contract — the composition reads this parse at boot.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ASSESSOR_DEFAULTS, parseAssessorConfig } from "@/domains/superagent/assessor";

const OVERRIDES = [
  "POLYMATH_SUPERAGENT_ASSESSOR_PROFILE",
  "POLYMATH_SUPERAGENT_EVALS_MAX",
  "POLYMATH_SUPERAGENT_DECIDE_THRESHOLD",
  "POLYMATH_SUPERAGENT_EVAL_ESTIMATE_USD",
] as const;

const setEnv = (name: string, value: string): void => {
  process.env[name] = value;
};

describe("the assessor configuration", () => {
  afterEach(() => {
    for (const name of OVERRIDES) delete process.env[name];
  });

  it("falls back to the defaults when nothing is set", () => {
    expect(parseAssessorConfig()).toEqual(ASSESSOR_DEFAULTS);
  });

  it("reads each override", () => {
    setEnv("POLYMATH_SUPERAGENT_ASSESSOR_PROFILE", "custom-judge");
    setEnv("POLYMATH_SUPERAGENT_EVALS_MAX", "4");
    setEnv("POLYMATH_SUPERAGENT_DECIDE_THRESHOLD", "0.75");
    setEnv("POLYMATH_SUPERAGENT_EVAL_ESTIMATE_USD", "0.25");
    expect(parseAssessorConfig()).toEqual({
      profileName: "custom-judge",
      maxConcurrent: 4,
      admitThreshold: 0.75,
      estimateUsd: "0.25",
    });
  });

  it("trims a padded profile name", () => {
    setEnv("POLYMATH_SUPERAGENT_ASSESSOR_PROFILE", "  padded  ");
    expect(parseAssessorConfig().profileName).toBe("padded");
  });

  it("rejects a non-integer or sub-1 session cap", () => {
    setEnv("POLYMATH_SUPERAGENT_EVALS_MAX", "2.5");
    expect(() => parseAssessorConfig()).toThrow("POLYMATH_SUPERAGENT_EVALS_MAX must be an integer of at least 1");
    setEnv("POLYMATH_SUPERAGENT_EVALS_MAX", "0");
    expect(() => parseAssessorConfig()).toThrow("POLYMATH_SUPERAGENT_EVALS_MAX must be an integer of at least 1");
  });

  it("rejects a threshold outside 0..1 or unparseable", () => {
    setEnv("POLYMATH_SUPERAGENT_DECIDE_THRESHOLD", "1.5");
    expect(() => parseAssessorConfig()).toThrow(
      "POLYMATH_SUPERAGENT_DECIDE_THRESHOLD must be a number between 0 and 1",
    );
    setEnv("POLYMATH_SUPERAGENT_DECIDE_THRESHOLD", "high");
    expect(() => parseAssessorConfig()).toThrow(
      "POLYMATH_SUPERAGENT_DECIDE_THRESHOLD must be a number between 0 and 1",
    );
  });

  it("rejects an empty profile name or estimate", () => {
    setEnv("POLYMATH_SUPERAGENT_ASSESSOR_PROFILE", "   ");
    expect(() => parseAssessorConfig()).toThrow("POLYMATH_SUPERAGENT_ASSESSOR_PROFILE must not be empty");
    setEnv("POLYMATH_SUPERAGENT_ASSESSOR_PROFILE", "judge");
    setEnv("POLYMATH_SUPERAGENT_EVAL_ESTIMATE_USD", "");
    expect(() => parseAssessorConfig()).toThrow("POLYMATH_SUPERAGENT_EVAL_ESTIMATE_USD must not be empty");
  });
});
