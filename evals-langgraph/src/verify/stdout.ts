import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/*
 * The logs leg (findings §4 recommendation a+b): the harness supervises
 * `next dev` and slices its stdout per run window for crash diagnostics.
 * Postgres stays the authoritative app-side record — the stdout slice is
 * evidence for the report, never the source of truth.
 */
export type StdoutEntry = { at: string; line: string };
export type StdoutCapture = (start: string, end: string) => Promise<string>;
export type SupervisedDev = { capture: StdoutCapture; ready: () => Promise<void>; stop: () => Promise<void> };

export function sliceWindow(entries: StdoutEntry[], start: string, end: string): string {
  const from = Date.parse(start);
  const to = Date.parse(end);
  return entries.filter((entry) => { const at = Date.parse(entry.at); return at >= from && at <= to; }).map((entry) => entry.line).join("\n");
}
/** Bounded line buffer (default 5000 lines): a stuck server cannot exhaust the harness's memory. */
export function createStdoutBuffer(limit = 5000) {
  const entries: StdoutEntry[] = [];
  return {
    record: (at: string, line: string): void => {
      entries.push({ at, line });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    capture: async (start: string, end: string) => sliceWindow(entries, start, end),
  };
}
function wire(stream: Readable | null, record: (at: string, line: string) => void): void {
  if (!stream) return;
  let rest = "";
  stream.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    const at = new Date().toISOString();
    for (const line of lines) record(at, line);
  });
}
function exitWithin(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
/**
 * Spawns the dev server command (shell form, e.g. `pnpm dev` from the repo
 * root), tees stdout+stderr into the bounded buffer, and gates `ready()` on
 * the server answering HTTP at the driver's own base URL. Any HTTP response
 * counts — compilation errors surface in the captured window, not here.
 */
export function superviseDevServer(options: { command: string; cwd: string; readyUrl: string; timeoutMs?: number; env?: Readonly<Record<string, string | undefined>> }): SupervisedDev {
  const child = spawn(options.command, { cwd: options.cwd, shell: true, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
  const buffer = createStdoutBuffer();
  wire(child.stdout, buffer.record);
  wire(child.stderr, buffer.record);
  return {
    capture: buffer.capture,
    ready: async () => {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      for (;;) {
        try { await fetch(options.readyUrl, { method: "GET", signal: AbortSignal.timeout(2000) }); return; }
        catch (error) {
          if (Date.now() > deadline) throw new Error(`Dev server not ready at ${options.readyUrl} within timeout: ${String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    stop: async () => { child.kill("SIGTERM"); await exitWithin(child, 3000); },
  };
}
