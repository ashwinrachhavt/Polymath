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
  EFFECT_BACKOFF,
  REPLY_BACKOFF,
  type BackoffCurve,
  backoffCurveFor,
  backoffMs,
  effectBackoffMs,
} from "./backoff";
export {
  type ClaimedEffect,
  type EffectHandler,
  type EffectHandlers,
  type RawClient,
  EffectStaleWriteError,
  claimDueEffects,
  completeEffect,
  deferEffect,
  failEffect,
  recoverStrandedEffects,
} from "./queue";
export {
  type ClaimedReceipt,
  type ReceiptSender,
  type ReceiptsPassResult,
  claimPendingReceipts,
  completeReceipt,
  conversationReplyHandler,
  dropReceipt,
  recoverStrandedReceipts,
  runReceiptsPass,
} from "./receipts";
export {
  type EffectsPassResult,
  type SuperagentDispatchResult,
  runEffectsPass,
  runSuperagentDispatch,
} from "./drain";
export { effectHandlers } from "./handlers";
