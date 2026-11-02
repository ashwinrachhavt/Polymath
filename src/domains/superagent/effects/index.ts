/**
 * The superagent effects module: the durable queue of external work the
 * engine asked for, and the reply lane that carries its messages to channels.
 *
 * Producers enqueue through the store — `store.effects.enqueue({ kind, key })`
 * — inside a command, and the row commits with the domain state in the same
 * transaction. The drain passes here run only after commit: inline after the
 * flush, through the `/api/internal/outbox` dispatch pass, and through cron
 * recovery.
 */
export { Later } from "./later";
export {
  type ClaimedEffect,
  type EffectHandler,
  claimDueEffects,
  completeEffect,
  deferEffect,
  recoverStrandedEffects,
} from "./queue";
export {
  type ClaimedReceipt,
  type ReceiptSender,
  claimPendingReceipts,
  conversationReplyHandler,
  recoverStrandedReceipts,
  runReceiptsPass,
} from "./receipts";
export { runEffectsPass, runSuperagentDispatch } from "./drain";
