/**
 * The reply lane: outbound receipts, claimed and sent in per-conversation
 * order, once each. The primary key is the send-once guarantee at enqueue
 * time; the lease is the send-once guarantee at delivery time, so two passes
 * (inline after commit, the dispatch endpoint, cron) never send one
 * conversation's message twice.
 *
 * Ordering rule: a pass claims, per conversation, only a prefix of that
 * conversation's pending queue — a conversation whose head is live-leased by
 * another worker is left alone until the lease expires. Within a claimed
 * prefix, receipts send strictly in `seq` order; a send that throws stops the
 * conversation and leaves the leases to expire, so the next pass re-claims
 * from the head.
 */
import { conversationKey, type ChannelRef } from "../core/model";
import { REPLY_BACKOFF, backoffMs } from "./backoff";
import { Later } from "./later";
import { type EffectHandler, type RawClient } from "./queue";

const DEFAULT_BATCH = 20;
const DEFAULT_LEASE_MS = 60_000;

/** One receipt claimed by a sender pass. */
export type ClaimedReceipt = {
  workspaceId: string;
  id: string;
  channel: ChannelRef;
  text: string;
  kind: string;
  ticketId: string | null;
  seq: number;
  leaseToken: string;
};

/**
 * The host's way to put one receipt on its channel — the chat Source's
 * ChatStreamSink in production. Returns `'sent'` once written durably,
 * `'gone'` when the conversation can never receive it, and throws when
 * delivery failed but may succeed on a later retry.
 */
export type ReceiptSender = (receipt: ClaimedReceipt) => Promise<"sent" | "gone">;

/** The channel conversation a receipt row belongs to, read back out of the jsonb column. */
function rowConversation(channel: unknown): string {
  const ref = channel as { source?: unknown; thread?: unknown } | null;
  if (typeof ref?.source !== "string" || typeof ref?.thread !== "string")
    throw new Error("A queued receipt's channel does not name a conversation.");
  return `${ref.source}:${ref.thread}`;
}

/**
 * Claims pending receipts whose conversations are free to send, oldest first.
 * The `not exists` guard keeps a conversation whose head is live-leased out of
 * the batch entirely, so two passes cannot split one conversation and send out
 * of order. Returns the claimed rows in global `seq` order — per-conversation
 * order for free.
 */
export async function claimPendingReceipts(
  rawClient: RawClient,
  input: { workerId: string; workspaceId?: string; conversation?: string; limit?: number; leaseMs?: number },
): Promise<ClaimedReceipt[]> {
  const limit = input.limit ?? DEFAULT_BATCH;
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const workspace = input.workspaceId ?? null;
  const conversation = input.conversation ?? null;
  return rawClient.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select r.id from work_outbox_receipts r
      where r.status = 'pending'
        and (r.lease_expires_at is null or r.lease_expires_at <= now())
        and (${workspace}::text is null or r.workspace_id = ${workspace}::uuid)
        and (${conversation}::text is null or (r.channel->>'source') || ':' || (r.channel->>'thread') = ${conversation}::text)
        and not exists (
          select 1 from work_outbox_receipts h
          where h.workspace_id = r.workspace_id
            and h.status = 'pending'
            and (h.channel->>'source') || ':' || (h.channel->>'thread') = (r.channel->>'source') || ':' || (r.channel->>'thread')
            and h.seq < r.seq
            and h.lease_owner is not null and h.lease_expires_at > now()
        )
      order by r.seq
      limit ${limit}
      for update skip locked
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const claimed = await tx<
      {
        workspace_id: string;
        id: string;
        channel: unknown;
        text: string;
        kind: string;
        ticket_id: string | null;
        seq: string;
        lease_token: string;
      }[]
    >`
      update work_outbox_receipts
      set lease_owner = ${input.workerId},
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + (${leaseMs}::double precision * interval '1 millisecond')
      where id = any(${ids})
      returning workspace_id, id, channel, text, kind, ticket_id, seq, lease_token::text
    `;
    return claimed
      .map((row) => ({
        workspaceId: row.workspace_id,
        id: row.id,
        channel: row.channel as ChannelRef,
        text: row.text,
        kind: row.kind,
        ticketId: row.ticket_id,
        seq: Number(row.seq),
        leaseToken: row.lease_token,
      }))
      .sort((a, b) => a.seq - b.seq);
  });
}

/** How many receipts of one conversation are still queued, claimed or not. */
async function countPendingReceipts(
  rawClient: RawClient,
  workspaceId: string,
  conversation: string,
): Promise<number> {
  const rows = await rawClient<{ count: string }[]>`
    select count(*) as count from work_outbox_receipts
    where workspace_id = ${workspaceId}::uuid
      and status = 'pending'
      and (channel->>'source') || ':' || (channel->>'thread') = ${conversation}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Marks a claimed receipt sent. A stale lease token is rejected, not silently dropped. */
export async function completeReceipt(rawClient: RawClient, input: { id: string; leaseToken: string }): Promise<void> {
  const updated = await rawClient`
    update work_outbox_receipts
    set status = 'sent', sent_at = now(), updated_at = now(),
        lease_owner = null, lease_token = null, lease_expires_at = null
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
    returning id
  `;
  if (updated.length === 0) throw new Error(`Receipt ${input.id} moved on after its lease expired.`);
}

/** Marks a claimed receipt dropped — its conversation can never receive it. */
export async function dropReceipt(rawClient: RawClient, input: { id: string; leaseToken: string }): Promise<void> {
  const updated = await rawClient`
    update work_outbox_receipts
    set status = 'dropped', dropped_at = now(), updated_at = now(),
        lease_owner = null, lease_token = null, lease_expires_at = null
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
    returning id
  `;
  if (updated.length === 0) throw new Error(`Receipt ${input.id} moved on after its lease expired.`);
}

/** Releases receipts whose sender died between claim and completion; a release, never a send. */
export async function recoverStrandedReceipts(rawClient: RawClient): Promise<string[]> {
  const rows = await rawClient<{ id: string }[]>`
    update work_outbox_receipts
    set lease_owner = null, lease_token = null, lease_expires_at = null
    where status = 'pending' and lease_owner is not null and lease_expires_at <= now()
    returning id
  `;
  return rows.map((row) => row.id);
}

/** A pass over every free conversation: claim prefixes, send in order, record the outcomes. */
export type ReceiptsPassResult = { claimed: number; sent: number; dropped: number; deferred: number };

export async function runReceiptsPass(
  rawClient: RawClient,
  sender: ReceiptSender,
  input: { workerId: string; workspaceId?: string; limit?: number; leaseMs?: number },
): Promise<ReceiptsPassResult> {
  const batch = await claimPendingReceipts(rawClient, input);
  // Group by conversation, preserving the global seq order the claim returned.
  const byConversation = new Map<string, ClaimedReceipt[]>();
  for (const receipt of batch) {
    const conversation = rowConversation(receipt.channel);
    const queue = byConversation.get(conversation);
    if (queue) queue.push(receipt);
    else byConversation.set(conversation, [receipt]);
  }
  let sent = 0;
  let dropped = 0;
  let deferred = 0;
  for (const [, queue] of byConversation) {
    let blocked = false;
    for (const receipt of queue) {
      if (blocked) {
        // Ordering first: nothing else in this conversation goes out while its
        // head has not. The leases were held on claim; they expire and the
        // sweeper releases them, so the next pass re-claims from the head.
        deferred += 1;
        continue;
      }
      try {
        const result = await sender(receipt);
        if (result === "sent") {
          await completeReceipt(rawClient, { id: receipt.id, leaseToken: receipt.leaseToken });
          sent += 1;
        } else {
          await dropReceipt(rawClient, { id: receipt.id, leaseToken: receipt.leaseToken });
          dropped += 1;
        }
      } catch {
        // "Delivery failed but may succeed on a later retry": stop the
        // conversation here. The receipt stays pending under its lease; the
        // pass result's `deferred` count is the surfaced signal.
        blocked = true;
        deferred += 1;
      }
    }
  }
  return { claimed: batch.length, sent, dropped, deferred };
}

/** The reply effect's payload: the conversation whose receipts the handler drains. */
export type ReplyEffectPayload = { source: string; thread: string };

function parseReplyPayload(payload: Record<string, unknown> | null): ReplyEffectPayload {
  if (payload && typeof payload.source === "string" && typeof payload.thread === "string")
    return { source: payload.source, thread: payload.thread };
  throw new Error("The reply effect's payload does not name a conversation — expected { source, thread }.");
}

/**
 * The handler behind the `reply` effect the store enqueues for every queued
 * receipt: drain one conversation's pending receipts in seq order. It is the
 * lane's retry scheduler — a send that throws propagates, so the effect's own
 * failure counters grow and the reply backoff curve (5s doubling to 300s)
 * schedules the next look, with the health entry after three consecutive
 * failures. When nothing is claimable but receipts remain pending (another
 * pass holds the head), a `Later` parks the effect on the curve without
 * counting a failure.
 */
export function conversationReplyHandler(
  rawClient: RawClient,
  sender: ReceiptSender,
  input: { leaseMs?: number; limit?: number } = {},
): EffectHandler {
  return async (effect) => {
    const conversation = parseReplyPayload(effect.payload);
    const key = conversationKey(conversation);
    const claimed = await claimPendingReceipts(rawClient, {
      workerId: `reply-effect:${effect.id}`,
      workspaceId: effect.workspaceId,
      conversation: key,
      leaseMs: input.leaseMs,
      limit: input.limit,
    });
    if (claimed.length === 0) {
      const pending = await countPendingReceipts(rawClient, effect.workspaceId, key);
      if (pending > 0) {
        // Another pass is sending this conversation's head. Look again on the
        // reply curve — parked, not failed; the holder may simply be slow.
        throw new Later(backoffMs(REPLY_BACKOFF, effect.consecutiveFailures + 1), "another pass is sending this conversation");
      }
      // Nothing pending: the burst coalesced into this one effect and the
      // direct passes resolved it. Done.
      return;
    }
    for (const receipt of claimed) {
      // A throw propagates: failEffect counts it and schedules the curve.
      const result = await sender(receipt);
      if (result === "sent") await completeReceipt(rawClient, { id: receipt.id, leaseToken: receipt.leaseToken });
      else await dropReceipt(rawClient, { id: receipt.id, leaseToken: receipt.leaseToken });
    }
  };
}
