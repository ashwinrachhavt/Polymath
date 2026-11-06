/*
 * The single sandbox seam (issue #534, FR-JOB-002 / NFR-PORT-001): every
 * place that needs to run untrusted or expensive work off the request path
 * goes through runInSandbox, and providers plug in behind it. The local
 * adapter ships first because it costs nothing and needs no account; the
 * Daytona/E2B adapters land only after credit balances and expiry are
 * confirmed (the issue's own acceptance gate) - the provider gate below
 * fails loudly until then instead of shipping unused adapters.
 *
 * Guardrails this module encodes:
 * - NFR-SEC-004: no provider tokens inside sandboxes. Adapters never inherit
 *   the process environment; they get a base allowlist plus the caller's
 *   explicit env, and nothing else.
 * - FR-AGT-006 / NFR-COST-001: sandbox-seconds are counted against a run
 *   budget the caller passes in; a run that would cross it is refused before
 *   anything spawns.
 * - Postgres jobs/job_attempts stay canonical (NFR-REL-001): the runner
 *   reports durations and attempts; recording them is the caller's job.
 * - Sandbox output is untrusted (FR-ACT-001): results are data, never
 *   effects - consequential use routes through action proposals upstream.
 */

import { runInLocalSandbox } from "./local";

export type SandboxProvider = "local" | "daytona" | "e2b";

export type SandboxSpec = {
  /** The command and its arguments, never a shell string. */
  command: string[];
  /** Wall-clock ceiling for the whole run; the process group is killed at the limit. */
  timeoutSeconds: number;
  /** Extra environment on top of the adapter's base allowlist. */
  env?: Record<string, string>;
  /** Provider-side network policy. The local adapter cannot enforce this at the OS level; it reports "inherited". */
  network?: "none" | "restricted" | "open";
  /** Free-form label for trial records and logs (an eval scenario, a parser run). */
  label: string;
};

export type SandboxResult = {
  ok: boolean;
  exitCode: number | null;
  /** "timeout" when the wall clock killed the run. */
  failure?: "timeout" | "spawn" | "budget" | "provider";
  message?: string;
  stdout: string;
  stderr: string;
  wallMs: number;
  /** Billed-unit accounting: whole seconds the sandbox existed, ceiling of wall time. */
  sandboxSeconds: number;
  network: "none" | "restricted" | "open" | "inherited";
  provider: SandboxProvider;
};

export type SandboxBudget = {
  readonly maxSandboxSeconds: number;
  usedSandboxSeconds: number;
};

export function createSandboxBudget(maxSandboxSeconds: number): SandboxBudget {
  return { maxSandboxSeconds, usedSandboxSeconds: 0 };
}

function providerFromEnv(): SandboxProvider {
  const raw = process.env.SANDBOX_PROVIDER ?? "local";
  if (raw === "local" || raw === "daytona" || raw === "e2b") return raw;
  throw new Error(`SANDBOX_PROVIDER must be local, daytona or e2b; got "${raw}".`);
}

export async function runInSandbox(spec: SandboxSpec, budget?: SandboxBudget): Promise<SandboxResult> {
  if (budget && budget.usedSandboxSeconds + spec.timeoutSeconds > budget.maxSandboxSeconds) {
    return {
      ok: false,
      exitCode: null,
      failure: "budget",
      message: `sandbox budget exhausted: ${budget.usedSandboxSeconds}s used of ${budget.maxSandboxSeconds}s; this run needs up to ${spec.timeoutSeconds}s more.`,
      stdout: "",
      stderr: "",
      wallMs: 0,
      sandboxSeconds: 0,
      network: spec.network ?? "inherited",
      provider: providerFromEnv(),
    };
  }
  const provider = providerFromEnv();
  if (provider !== "local") {
    // Credits-gated (issue #534 acceptance): no provider adapter ships until
    // the balance and expiry are confirmed and the provider PR lands.
    return {
      ok: false,
      exitCode: null,
      failure: "provider",
      message: `SANDBOX_PROVIDER=${provider} is not enabled yet: the ${provider} adapter lands with the credits trial (issue #534). Use the local adapter or confirm the credit balance first.`,
      stdout: "",
      stderr: "",
      wallMs: 0,
      sandboxSeconds: 0,
      network: spec.network ?? "inherited",
      provider,
    };
  }
  const result = await runInLocalSandbox(spec);
  if (budget) budget.usedSandboxSeconds += result.sandboxSeconds;
  return result;
}
