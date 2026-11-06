import { afterEach, describe, expect, it } from "vitest";
import { createSandboxBudget, runInSandbox } from "@/integrations/sandbox/runner";

/*
 * The seam's guarantees, exercised against the real local adapter with node
 * itself as the workload: environment scrubbing (NFR-SEC-004), wall-clock
 * kill, output caps, exit-code honesty, budget accounting, and the loud
 * provider gate for the credits that are not enabled yet.
 */

const NODE = process.execPath;

describe("runInSandbox (local adapter)", () => {
  const savedProvider = process.env.SANDBOX_PROVIDER;
  afterEach(() => {
    if (savedProvider === undefined) delete process.env.SANDBOX_PROVIDER;
    else process.env.SANDBOX_PROVIDER = savedProvider;
  });

  it("runs a command and reports exit code, output and billed sandbox-seconds", async () => {
    const result = await runInSandbox({
      command: [NODE, "-e", "console.log('hello')"],
      timeoutSeconds: 10,
      label: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.sandboxSeconds).toBeGreaterThanOrEqual(1);
    expect(result.provider).toBe("local");
    expect(result.network).toBe("inherited");
  });

  it("never leaks provider credentials into the sandbox (NFR-SEC-004)", async () => {
    process.env.GROQ_API_KEY = "test-secret-do-not-leak";
    const result = await runInSandbox({
      command: [NODE, "-e", "console.log(process.env.GROQ_API_KEY ?? 'scrubbed')"],
      timeoutSeconds: 10,
      label: "t",
    });
    expect(result.stdout.trim()).toBe("scrubbed");
    delete process.env.GROQ_API_KEY;
  });

  it("passes caller-declared env through explicitly", async () => {
    const result = await runInSandbox({
      command: [NODE, "-e", "console.log(process.env.TRIAL_FLAG ?? 'missing')"],
      timeoutSeconds: 10,
      env: { TRIAL_FLAG: "yes" },
      label: "t",
    });
    expect(result.stdout.trim()).toBe("yes");
  });

  it("kills a runaway at the wall-clock limit and says so", async () => {
    const started = Date.now();
    const result = await runInSandbox({
      command: [NODE, "-e", "setInterval(() => {}, 1000)"],
      timeoutSeconds: 1,
      label: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports non-zero exits without calling them failures of the runner", async () => {
    const result = await runInSandbox({ command: [NODE, "-e", "process.exit(3)"], timeoutSeconds: 10, label: "t" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.failure).toBeUndefined();
  });

  it("caps runaway output instead of buffering forever", async () => {
    const result = await runInSandbox({
      command: [NODE, "-e", "console.log('x'.repeat(200000))"],
      timeoutSeconds: 10,
      label: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThan(70 * 1024);
    expect(result.stdout).toContain("[output truncated at 64KB]");
  });

  it("counts sandbox-seconds against the run budget and refuses past it", async () => {
    const budget = createSandboxBudget(5);
    const first = await runInSandbox({ command: [NODE, "-e", ""], timeoutSeconds: 3, label: "t" }, budget);
    expect(first.ok).toBe(true);
    expect(budget.usedSandboxSeconds).toBeGreaterThanOrEqual(1);
    const refused = await runInSandbox({ command: [NODE, "-e", ""], timeoutSeconds: 10, label: "t" }, budget);
    expect(refused.ok).toBe(false);
    expect(refused.failure).toBe("budget");
  });

  it("fails loudly for credit providers until the trial lands (no silent fallback)", async () => {
    process.env.SANDBOX_PROVIDER = "daytona";
    const result = await runInSandbox({ command: [NODE, "-e", ""], timeoutSeconds: 5, label: "t" });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("provider");
    expect(result.message).toContain("daytona");
  });
});
