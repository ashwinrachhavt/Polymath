import { describe, expect, it } from "vitest";
import { EvalEnvironmentViolation, assertEvalEnvironment } from "../../eve/polymath/evals/stubs";

describe("assertEvalEnvironment", () => {
  it("allows exactly the declared eval keys", () => {
    const env = { GEMINI_API_KEY: "k", GEMINI_AGENT_MODEL: "gemini-3.5-flash-lite", OPENAI_API_KEY: "k" };
    expect(() => assertEvalEnvironment(env)).not.toThrow();
  });

  it("throws for any provider key outside the allowlist", () => {
    const env = { GEMINI_API_KEY: "k", COMPOSIO_API_KEY: "k" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });

  it("throws for COMPOSIO_AUTH_CONFIG_ prefixed keys", () => {
    const env = { COMPOSIO_AUTH_CONFIG_GMAIL: "cfg" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });

  it("treats a blank-string key as unset", () => {
    const env = { COMPOSIO_API_KEY: "   " };
    expect(() => assertEvalEnvironment(env)).not.toThrow();
  });

  it("lets structural variables through", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/x", __CF_USER_TEXT_ENCODING: "0x1f8:0x0" };
    expect(() => assertEvalEnvironment(env)).not.toThrow();
  });

  it("throws for an unknown credential-shaped key", () => {
    const env = { GEMINI_API_KEY: "k", XAI_API_KEY: "k" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });

  it("lets GitHub Actions harness credentials through (runner-injected, not operator keys)", () => {
    const env = {
      GEMINI_API_KEY: "k",
      ACTIONS_RUNTIME_TOKEN: "rt",
      ACTIONS_CACHE_SERVICE_TOKEN: "ct",
      GITHUB_TOKEN: "gt",
      GH_TOKEN: "gh",
    };
    expect(() => assertEvalEnvironment(env)).not.toThrow();
  });

  it("still throws for an operator credential named under a harness prefix", () => {
    const env = { ACTIONS_DEPLOY_KEY: "k" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });

  it("still throws for an operator credential outside the harness namespaces", () => {
    const env = { STRIPE_WEBHOOK_SECRET: "k" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });
});
