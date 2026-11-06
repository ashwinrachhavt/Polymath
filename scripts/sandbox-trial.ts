#!/usr/bin/env tsx
/*
 * The issue #534 trial harness: run one workload through the sandbox seam
 * and print the trial record the issue's acceptance asks for - runtime,
 * retries, operational effort, privacy exposure, cost. Against the local
 * adapter every credit field reads zero; the same record shape is what the
 * Daytona/E2B trial fills in once balances and expiry are confirmed.
 *
 *   pnpm tsx scripts/sandbox-trial.ts --label eval-routing -- node --version
 */

import { createSandboxBudget, runInSandbox, type SandboxResult } from "../src/integrations/sandbox/runner";

type TrialRecord = {
  label: string;
  provider: string;
  ok: boolean;
  exitCode: number | null;
  attempts: number;
  retries: number;
  wallMs: number;
  sandboxSeconds: number;
  budgetSeconds: number;
  privacyExposure: string;
  estimatedCostUsd: number;
  operationalNotes: string;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const labelFlag = argv.indexOf("--label");
  const label = labelFlag >= 0 ? (argv[labelFlag + 1] ?? "trial") : "trial";
  const command = sep >= 0 ? argv.slice(sep + 1) : argv.filter((a, i) => a !== "--label" && i !== labelFlag + 1);
  if (command.length === 0) {
    console.error("usage: pnpm tsx scripts/sandbox-trial.ts --label <name> -- <command> [args...]");
    process.exit(2);
  }

  const budget = createSandboxBudget(120);
  const result: SandboxResult = await runInSandbox({ command, timeoutSeconds: 60, label, network: "none" }, budget);

  const record: TrialRecord = {
    label,
    provider: result.provider,
    ok: result.ok,
    exitCode: result.exitCode,
    attempts: 1,
    retries: 0,
    wallMs: result.wallMs,
    sandboxSeconds: result.sandboxSeconds,
    budgetSeconds: budget.maxSandboxSeconds,
    privacyExposure:
      result.network === "inherited"
        ? "local adapter: same user, same kernel, inherited network - no isolation claimed"
        : `provider network policy: ${result.network}`,
    estimatedCostUsd: 0,
    operationalNotes: result.failure ? `${result.failure}: ${result.message ?? ""}` : "ran to completion",
  };
  console.log(JSON.stringify(record, null, 2));
  if (!result.ok) process.exit(1);
}

void main();
