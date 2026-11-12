import type { AuthContext } from "@/domains/identity/resolve";
import { tailGenerationJobs } from "./queries";
import { GENERATION_JOB_EVENT, isSettled, jobSignature, type GenerationJobView } from "./state";

/*
 * The server half of the generation jobs push channel: Server-Sent Events,
 * one stream per open tab, carrying every status change of the person's jobs.
 *
 * The browser holds a connection and is told; it never asks. The server
 * learns of a change by reading the jobs table, the one place the worker, the
 * cron route and an inline run all write, so the stream needs nothing those
 * processes would have to share. (LISTEN/NOTIFY is not available behind the
 * transaction-mode pooler the deployed database sits behind.)
 *
 * Reconnect: every frame carries `id`, the database time of the read that
 * produced it. EventSource sends the last one back as Last-Event-ID, and the
 * stream resumes from there, so a change made while the connection was down
 * is delivered on the next one. Frames are whole job states, so a repeat is
 * harmless.
 */

/** While something is being made the stream looks often; otherwise it idles. */
const ACTIVE_EVERY_MS = 1_500;
const IDLE_EVERY_MS = 3_000;

type Tail = (
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  since: Date | null,
) => ReturnType<typeof tailGenerationJobs>;

/** The cursor a reconnecting client sent, or null for a first connection or a value that is not a time. */
export function parseJobCursor(lastEventId: string | null): Date | null {
  if (!lastEventId) return null;
  const at = new Date(lastEventId);
  return Number.isNaN(at.getTime()) ? null : at;
}

function frame(cursor: Date, job?: GenerationJobView): string {
  const id = `id: ${cursor.toISOString()}\n`;
  // An id with no data moves the client's cursor and keeps the connection warm without dispatching an event.
  return job ? `${id}event: ${GENERATION_JOB_EVENT}\ndata: ${JSON.stringify(job)}\n\n` : `${id}\n`;
}

/**
 * Yields SSE text until `signal` aborts or `maxMs` passes (the caller's
 * function time limit; the client reconnects with its cursor). Each pass
 * yields one frame per job whose state the stream has not sent yet, or a bare
 * cursor frame when there was none.
 */
export async function* followGenerationJobs(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  options: {
    since: Date | null;
    signal: AbortSignal;
    maxMs: number;
    tail?: Tail;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): AsyncGenerator<string> {
  const tail = options.tail ?? tailGenerationJobs;
  const sleep = options.sleep ?? abortableSleep;
  const sent = new Map<string, string>();
  const deadline = Date.now() + options.maxMs;
  let since = options.since;
  yield "retry: 2000\n\n";
  while (!options.signal.aborted && Date.now() < deadline) {
    const { jobs, now } = await tail(auth, since);
    since = now;
    let wrote = false;
    for (const job of jobs) {
      const signature = jobSignature(job);
      if (sent.get(job.id) === signature) continue;
      sent.set(job.id, signature);
      wrote = true;
      yield frame(now, job);
    }
    if (!wrote) yield frame(now);
    const active = jobs.some((job) => !isSettled(job.status));
    await sleep(active ? ACTIVE_EVERY_MS : IDLE_EVERY_MS, options.signal);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
