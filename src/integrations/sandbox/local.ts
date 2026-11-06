/*
 * The zero-credit adapter: work runs as a subprocess with a scrubbed
 * environment, a wall-clock kill and capped output. It is NOT a security
 * boundary - same user, same kernel, inherited network - it is the seam's
 * development adapter and the trial harness for the credit providers
 * (issue #534). Where the spec declares a network policy, the result says
 * "inherited" honestly instead of claiming enforcement that does not exist.
 */

import { spawn } from "node:child_process";
import type { SandboxResult, SandboxSpec } from "./runner";

/*
 * The base environment: what a process needs to run at all, and nothing a
 * provider could bill against. Anything ending _KEY/_TOKEN/_SECRET/_PASSWORD
 * is excluded by construction - the allowlist never names one - and callers
 * add variables explicitly through spec.env (NFR-SEC-004).
 */
const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL", "CI", "NODE_ENV"] as const;

const OUTPUT_CAP_BYTES = 64 * 1024;
const TRUNCATED = "\n[output truncated at 64KB]";

function capped(acc: string, chunk: Buffer): string {
  if (acc.endsWith(TRUNCATED)) return acc;
  const room = OUTPUT_CAP_BYTES - acc.length;
  const text = chunk.toString("utf8");
  // Mark only when bytes were actually dropped: node delivers stdout in
  // 64KB chunks, so an exact-fit chunk is complete, not truncated.
  if (text.length <= room) return acc + text;
  return acc + text.slice(0, Math.max(0, room)) + TRUNCATED;
}

export function runInLocalSandbox(spec: SandboxSpec): Promise<SandboxResult> {
  const started = Date.now();
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, spec.env ?? {});

  return new Promise((resolve) => {
    let child;
    try {
      // detached: the timeout kills the whole process group, so a runaway
      // that forked children cannot outlive its budget.
      child = spawn(spec.command[0], spec.command.slice(1), { env, detached: true });
    } catch (cause) {
      resolve({
        ok: false,
        exitCode: null,
        failure: "spawn",
        message: cause instanceof Error ? cause.message : String(cause),
        stdout: "",
        stderr: "",
        wallMs: Date.now() - started,
        sandboxSeconds: 0,
        network: "inherited",
        provider: "local",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = capped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = capped(stderr, chunk);
    });
    child.on("error", (cause) => {
      resolve({
        ok: false,
        exitCode: null,
        failure: "spawn",
        message: cause.message,
        stdout,
        stderr,
        wallMs: Date.now() - started,
        sandboxSeconds: 0,
        network: "inherited",
        provider: "local",
      });
    });

    const killer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, spec.timeoutSeconds * 1000);

    child.on("close", (exitCode) => {
      clearTimeout(killer);
      const wallMs = Date.now() - started;
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        ...(timedOut
          ? { failure: "timeout" as const, message: `killed at the ${spec.timeoutSeconds}s wall-clock limit` }
          : {}),
        stdout,
        stderr,
        wallMs,
        sandboxSeconds: Math.max(1, Math.ceil(wallMs / 1000)),
        network: "inherited",
        provider: "local",
      });
    });
  });
}
