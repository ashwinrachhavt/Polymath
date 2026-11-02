/**
 * The effects registry: where each kind's consumer attaches. The queue owns
 * the mechanics — coalescing, backoff, the `Later` defer, the health entry —
 * and this module owns who handles what, so a new consumer registers in one
 * place and the routes stay dumb.
 *
 * The base map carries the reply lane — the conversation drain over the
 * receipts lane, registered when the host provides its ReceiptSender (the
 * chat Source's ChatStreamSink). Without a sender the map is empty and reply
 * effects park without failure, the deploy-order-safe posture: producers may
 * land before the consumer that resolves them.
 *
 * The wiring (../wiring.ts) composes this map with the assessor's
 * `assessment` consumer and the executor's `launch` and `delivery`
 * consumers, and the drain routes pass the result to runSuperagentDispatch.
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
