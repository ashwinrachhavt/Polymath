/**
 * The effects registry: where each kind's consumer attaches. The queue owns
 * the mechanics — coalescing, backoff, the `Later` defer, the health entry —
 * and this module owns who handles what, so a new consumer registers in one
 * place and the routes stay dumb.
 *
 * Wave-one consumers so far:
 * - `reply` — the conversation drain over the receipts lane, registered when
 *   the host provides its ReceiptSender (the chat Source's ChatStreamSink).
 *   Without a sender the map is empty and reply effects park without failure,
 *   which is the deploy-order-safe posture: producers may land before the
 *   consumer that resolves them.
 *
 * The executor's kinds (`assessment`, `launch`, `delivery`) and the notice and
 * relay consumers attach here as their waves land.
 */
import postgres from "postgres";
import type { EffectHandlers } from "./queue";
import { conversationReplyHandler, type ReceiptSender } from "./receipts";

export function effectHandlers(input: {
  rawClient: ReturnType<typeof postgres>;
  sender?: ReceiptSender;
  leaseMs?: number;
  limit?: number;
}): EffectHandlers {
  if (!input.sender) return {};
  return { reply: conversationReplyHandler(input.rawClient, input.sender, input) };
}
