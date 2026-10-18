import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { TxDrizzle } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { requestReceipts } from "./schema";

/*
 * Idempotency for first-party mutations (agents/engineering.md: every mutation
 * takes an idempotency UUID). Inside the caller's transaction:
 *
 *   - a key never seen runs `run`, stores its JSON result, and returns it;
 *   - the same key with the same request returns the stored result and runs
 *     nothing (`replayed: true`);
 *   - the same key with a different request throws IdempotencyConflictError.
 *
 * A transaction-scoped advisory lock on (workspace, key) serializes two
 * concurrent first attempts, so the loser waits, then replays; the unique
 * index on request_receipts stays the backstop, not the mechanism.
 *
 * `run` must return JSON-serializable data: it is what a replay hands back.
 * No key means no receipt (internal callers, agents with their own run ids).
 */

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  constructor() {
    super("This idempotency key was used for a different request.");
    this.name = "IdempotencyConflictError";
  }
}

export async function withReceipt<T>(
  tx: TxDrizzle,
  auth: Pick<AuthContext, "workspaceId">,
  key: string | undefined,
  request: unknown,
  run: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  if (!key) return { value: await run(), replayed: false };

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${auth.workspaceId}:${key}`}, 0))`,
  );
  const requestHash = await sha256Hex(JSON.stringify(request));

  const [receipt] = await tx
    .select({ requestHash: requestReceipts.requestHash, response: requestReceipts.response })
    .from(requestReceipts)
    .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)))
    .limit(1);
  if (receipt) {
    if (receipt.requestHash !== requestHash) throw new IdempotencyConflictError();
    return { value: receipt.response as T, replayed: true };
  }

  const value = await run();
  await tx.insert(requestReceipts).values({
    workspaceId: auth.workspaceId,
    idempotencyKey: key,
    requestHash,
    statusCode: 200,
    response: value ?? null,
  });
  return { value, replayed: false };
}
