import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { requestReceipts } from "./schema";

/*
 * Idempotency for first-party mutations (the engineering guidelines: every mutation
 * takes an idempotency UUID). Inside the caller's transaction:
 *   - a key never seen runs `run`, stores its JSON result, and returns it;
 *   - the same key with the same request returns the stored result and runs
 *     nothing (`replayed: true`);
 *   - the same key with a different request throws IdempotencyConflictError.
 *
 * A transaction-scoped advisory lock on (workspace, key) serializes two
 * concurrent first attempts, so the loser waits, then replays; the unique
 * index on request_receipts stays the backstop, not the mechanism.
 * `run` must return JSON-serializable data: it is what a replay hands back.
 * No key means no receipt (internal callers, agents with their own run ids). */

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  constructor() {
    super("This idempotency key was used for a different request.");
    this.name = "IdempotencyConflictError";
  }
}

/** The stored receipt hash for a request payload - one definition so a route's pre-check and withReceipt agree byte-for-byte. */
export async function receiptRequestHash(request: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(request));
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
  const requestHash = await receiptRequestHash(request);

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

/*
 * The start protocol: the same contract as withReceipt, claim-first, for work
 * that cannot hold a transaction across it (a run's engine session, an
 * upload's blob write — db-transaction.ts's own rule). The request_receipts
 * unique index on (workspace, key) is the serialization:
 *
 *   claimStartReceipt    — insert-or-lose. The winner starts the work; the
 *                          losers replay, wait (in-progress), or conflict.
 *   completeStartReceipt — the winner stores the response. Pass the finalize
 *                          transaction when there is one, so the receipt and
 *                          the work commit together.
 *   freeStartReceipt     — the winner failed before completion: free the key
 *                          so a retry starts fresh.
 *
 * A claimant that dies between claim and completion leaves the key answering
 * in-progress — the visible record that a start began, the same tradeoff the
 * claim rows' 24h expiresAt exists to bound once a purge lands.
 */

export type StartReceiptClaim =
  | { claimed: true }
  | { claimed: false; kind: "conflict" }
  | { claimed: false; kind: "in_progress" }
  | { claimed: false; kind: "replayed"; response: unknown };

export async function claimStartReceipt(
  auth: Pick<AuthContext, "workspaceId">,
  key: string,
  requestHash: string,
): Promise<StartReceiptClaim> {
  const [claimed] = await db
    .insert(requestReceipts)
    .values({
      workspaceId: auth.workspaceId,
      idempotencyKey: key,
      requestHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: requestReceipts.id });
  if (claimed) return { claimed: true };

  const [prior] = await db
    .select({ requestHash: requestReceipts.requestHash, response: requestReceipts.response })
    .from(requestReceipts)
    .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)))
    .limit(1);
  // The row can vanish between the lost insert and this read — the claimant
  // ahead of us failed and freed the key. Race again rather than answer a
  // conflict for a request that was never stored.
  if (!prior) return claimStartReceipt(auth, key, requestHash);
  if (prior.requestHash !== requestHash) return { claimed: false, kind: "conflict" };
  if (!prior.response) return { claimed: false, kind: "in_progress" };
  return { claimed: false, kind: "replayed", response: prior.response };
}

export async function completeStartReceipt(
  on: TxDrizzle | typeof db,
  auth: Pick<AuthContext, "workspaceId">,
  key: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await on
    .update(requestReceipts)
    .set({ statusCode, response })
    .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)));
}

export async function freeStartReceipt(
  auth: Pick<AuthContext, "workspaceId">,
  key: string,
): Promise<void> {
  await db
    .delete(requestReceipts)
    .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)));
}
