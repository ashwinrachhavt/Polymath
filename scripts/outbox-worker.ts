import postgres from "postgres";
import { dispatchPendingOutbox, recoverStrandedOutbox } from "@/domains/audit/outbox";
import { outboxHandlers } from "@/domains/audit/outbox-handlers";

/*
 * The local queue drain (ASH-178).
 *
 *   make queue-up    start it
 *   make queue-logs  follow it
 *   make queue-down  stop it
 *
 * Why this exists: intake writes `document.extraction_requested` and a crawl
 * writes `crawl.requested` in the same transaction as the change, and until
 * this process nothing drained them. On a laptop nobody curls the route by
 * hand, so every upload sat at "Reading" and every crawl sat queued.
 *
 * The loop is deliberately dull. One dispatcher pass, then sleep with jitter so
 * two workers (and the cron route) do not tick in lockstep. Leases are short
 * and fencing is in outbox.ts, so a slow pass does not need a long lease.
 *
 * A provider outage is the one thing worth not retrying blindly: handlers throw
 * OutboxDeferredError and the dispatcher parks those rows without spending an
 * attempt. This loop keeps running regardless - the backoff lives on the row.
 */

const TICK_MS = Number(process.env.OUTBOX_WORKER_TICK_MS ?? 5_000);
const JITTER_MS = Number(process.env.OUTBOX_WORKER_JITTER_MS ?? 1_000);
const SWEEP_EVERY_TICKS = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("outbox worker: DATABASE_URL is not set (run with --env-file=.env)");
    process.exit(1);
  }

  const client = postgres(url, { max: 2 });
  const workerId = `worker:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  let stopping = false;
  let tick = 0;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${stamp()}] ${signal}: finishing this pass, then exiting`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  console.log(`[${stamp()}] outbox worker ${workerId} started, tick ${TICK_MS}ms`);

  while (!stopping) {
    try {
      // A worker that died mid-pass leaves a lease behind; sweep before claiming
      // so its work is available to this pass rather than to a future one.
      if (tick % SWEEP_EVERY_TICKS === 0) {
        const recovered = await recoverStrandedOutbox(client);
        if (recovered.length > 0) console.log(`[${stamp()}] recovered ${recovered.length} stranded lease(s)`);
      }
      const result = await dispatchPendingOutbox(client, outboxHandlers, { workerId });
      if (result.claimed > 0) {
        console.log(
          `[${stamp()}] claimed ${result.claimed} dispatched ${result.dispatched} failed ${result.failed} ` +
            `parked ${result.parked} dead ${result.dead}`,
        );
      }
    } catch (cause) {
      // A database blip should not kill the loop; the next tick retries.
      console.error(`[${stamp()}] pass failed:`, cause instanceof Error ? cause.message : cause);
    }
    tick += 1;
    await sleep(TICK_MS + Math.floor(Math.random() * JITTER_MS));
  }

  await client.end({ timeout: 5 });
  console.log(`[${stamp()}] outbox worker stopped`);
}

main().catch((cause) => {
  console.error("outbox worker failed:", cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
