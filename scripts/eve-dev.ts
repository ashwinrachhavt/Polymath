/**
 * `make eve-up` / `make eve-down` / `make eve-status`: a standalone `eve dev`.
 *
 * `pnpm dev` already mounts the agents through `withEve` (next.config.ts) and
 * starts its own eve server, so this is for the case where Next is not
 * running — an agent-only loop, or a shell that drives eve directly. Running
 * it beside `pnpm dev` is not just redundant: eve allows one dev server per
 * agent and the second exits with "A dev server is already running". `up`
 * therefore looks for a live instance first and reports it instead of failing.
 *
 * The URL comes from the state files eve publishes in `eve/polymath/.eve/`,
 * which is also how the app finds it. The log is bounded: eve writes a line
 * per request, so a plain append log grows without limit during a day of
 * testing. It is rotated in place at EVE_DEV_LOG_MAX_BYTES (default 10 MiB),
 * keeping exactly one previous file.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const AGENT_ROOT = join(ROOT, "eve", "polymath");
const RUN_DIR = join(ROOT, ".run");
const PID_FILE = join(RUN_DIR, "eve-dev.pid");
const LOG_FILE = join(RUN_DIR, "eve-dev.log");
const LOG_MAX_BYTES = Number(process.env.EVE_DEV_LOG_MAX_BYTES ?? 10 * 1024 * 1024);
const BOOT_TIMEOUT_MS = 90_000;
const STATE_DIR = join(AGENT_ROOT, ".eve");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function truncateLog(): void {
  if (!existsSync(LOG_FILE)) return;
  if (statSync(LOG_FILE).size <= LOG_MAX_BYTES) return;
  renameSync(LOG_FILE, `${LOG_FILE}.1`);
}

function stateFile(): { origin?: string; url?: string; pid?: number } {
  for (const file of ["dev-server-state.v1.json", "next-dev-server.json"]) {
    try {
      return JSON.parse(readFileSync(join(STATE_DIR, file), "utf8"));
    } catch {
      // Missing is normal; try the next file.
    }
  }
  return {};
}

function publishedOrigin(): string | undefined {
  const base = stateFile().url ?? stateFile().origin;
  return base?.replace(/\/+$/, "");
}

/** The app probes before trusting a state file, because one can outlive its
 *  server after a crash; the same rule decides whether `up` is redundant. */
async function probe(origin: string): Promise<boolean> {
  try {
    await fetch(origin, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function up(): Promise<void> {
  if (runningPid()) {
    console.log(`eve dev already running from this checkout — make eve-logs to follow, make eve-down to stop`);
    return;
  }
  const existing = publishedOrigin();
  if (existing && (await probe(existing))) {
    console.log(`eve dev is already served by a running next dev (dev) at ${existing}`);
    console.log("that is the normal local setup: `pnpm dev` mounts the agents via withEve.");
    console.log("make eve is for an agent-only loop when Next is stopped.");
    return;
  }
  truncateLog();
  const fd = openSync(LOG_FILE, "a");
  const child = spawn("eve", ["dev", "--no-ui"], {
    cwd: AGENT_ROOT,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  if (child.pid === undefined) throw new Error("failed to spawn eve dev");
  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const origin = publishedOrigin();
    if (origin && (await probe(origin))) {
      console.log(`eve dev ready (pid ${child.pid}) at ${origin}`);
      console.log("log: .run/eve-dev.log — make eve-logs to follow, make eve-down to stop");
      return;
    }
    if (!alive(child.pid) || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const tail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").split("\n").slice(-20).join("\n") : "";
  throw new Error(`eve dev did not answer within ${BOOT_TIMEOUT_MS / 1000}s. Last log lines:\n${tail}`);
}

async function down(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    console.log("eve dev is not running");
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (alive(pid)) process.kill(pid, "SIGKILL");
  // eve dev leaves the port it published behind; the app probes before use,
  // so only state files that still claim *this* pid are worth removing.
  const state = stateFile();
  const stale = [join(STATE_DIR, "next-dev-server.json"), join(STATE_DIR, "dev-server-state.v1.json")]
    .filter((file) => {
      try {
        return JSON.parse(readFileSync(file, "utf8")).pid === pid;
      } catch {
        return false;
      }
    });
  for (const file of stale) unlinkSync(file);
  unlinkSync(PID_FILE);
  console.log(`eve dev stopped (pid ${pid})${state.pid === pid ? `; cleared its published state file` : ""}`);
}

async function status(): Promise<void> {
  const pid = runningPid();
  if (pid) {
    const origin = publishedOrigin();
    const answering = origin ? await probe(origin) : false;
    console.log(`eve dev (make eve-up): ${answering ? `ready at ${origin}` : "starting/unresponsive"} (pid ${pid})`);
    if (!answering) process.exitCode = 1;
    return;
  }
  const origin = publishedOrigin();
  if (origin && (await probe(origin))) {
    console.log(`eve dev: ready at ${origin} (served by \`pnpm dev\`, not make eve-up)`);
    return;
  }
  console.log("eve dev: stopped");
  process.exitCode = 1;
}

const command = process.argv[2];
const actions: Record<string, () => Promise<void>> = { up, down, status };
const action = actions[command ?? ""];
if (!action) {
  console.error(`usage: tsx scripts/eve-dev.ts <${Object.keys(actions).join("|")}>`);
  process.exitCode = 2;
} else {
  action().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
