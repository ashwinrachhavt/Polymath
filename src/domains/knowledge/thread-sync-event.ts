import { enqueueOutbox } from "@/domains/audit/outbox";
import type { TxDrizzle } from "@/lib/db-transaction";

/*
 * Producer side of conversation auto-sync. A message lands in a thread and the
 * same transaction queues one `thread.changed` event. The key is the thread
 * plus the minute, and the event becomes due when that minute ends, so a burst
 * of messages folds into one sync that sees all of them. The sync itself (read
 * the thread, write a transcript version, embed it) runs in the outbox worker,
 * never on the request that wrote the message.
 */

export const THREAD_CHANGED_TOPIC = "thread.changed";
const WINDOW_MS = 60_000;

export async function queueThreadSync(tx: TxDrizzle, workspaceId: string, threadId: string, now: Date = new Date()) {
  const bucket = Math.floor(now.getTime() / WINDOW_MS);
  await enqueueOutbox(
    tx,
    { workspaceId },
    {
      topic: THREAD_CHANGED_TOPIC,
      payload: { threadId },
      dispatchKey: `${threadId}:${bucket}`,
      availableAt: new Date((bucket + 1) * WINDOW_MS + 2_000),
    },
  );
}
