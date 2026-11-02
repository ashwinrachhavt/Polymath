/**
 * The effects drain pass: claim a batch, run each handler outside any
 * transaction, record the outcome. Same discipline as the audit outbox's
 * dispatcher, with this queue's two differences — a failing effect is never
 * dead-lettered (it waits out its kind's backoff and stays pending, growing
 * the health entry after three consecutive failures), and a `Later` throw
 * defers without counting a failure.
 */
import type { EffectKind } from "../store/schema";
import { effectBackoffMs } from "./backoff";
import { Later } from "./later";
import {
  DEFAULT_PARK_MS,
  type EffectHandler,
  type EffectHandlers,
  type RawClient,
  claimDueEffects,
  completeEffect,
  deferEffect,
  failEffect,
  recoverStrandedEffects,
} from "./queue";
import { recoverStrandedReceipts } from "./receipts";

export type EffectsPassResult = { claimed: number; done: number; deferred: number; failed: number };

/** The error text the row keeps: the message for an Error, the value otherwise. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One pass over the effects queue. `workspaceId` scopes the inline
 * post-commit drain to the workspace whose command just flushed; the
 * dispatch endpoint and cron recovery omit it and span every workspace.
 * `random` is injected for deterministic tests.
 */
export async function runEffectsPass(
  rawClient: RawClient,
  handlers: EffectHandlers,
  input: { workerId: string; workspaceId?: string; limit?: number; leaseMs?: number; random?: () => number },
): Promise<EffectsPassResult> {
  const batch = await claimDueEffects(rawClient, input);
  let done = 0;
  let deferred = 0;
  let failed = 0;
  for (const effect of batch) {
    const handler: EffectHandler | undefined = handlers[effect.kind];
    if (!handler) {
      // No consumer for this kind yet: park without spending a failure, so a
      // deploy order (producer before consumer) never turns intent into errors.
      await deferEffect(rawClient, {
        id: effect.id,
        leaseToken: effect.leaseToken,
        retryAt: new Date(Date.now() + DEFAULT_PARK_MS),
      });
      deferred += 1;
      continue;
    }
    try {
      await handler(effect);
      await completeEffect(rawClient, { id: effect.id, leaseToken: effect.leaseToken });
      done += 1;
    } catch (error) {
      if (error instanceof Later) {
        // An honest defer: park for the requested delay, counters untouched.
        await deferEffect(rawClient, {
          id: effect.id,
          leaseToken: effect.leaseToken,
          retryAt: new Date(Date.now() + error.retryAfterMs),
        });
        deferred += 1;
        continue;
      }
      // A real failure: count it, schedule the kind's backoff, and stay
      // pending — three consecutive failures raise the health entry.
      const failures = effect.consecutiveFailures + 1;
      await failEffect(rawClient, {
        id: effect.id,
        leaseToken: effect.leaseToken,
        error: describe(error),
        retryAt: new Date(Date.now() + effectBackoffMs(effect.kind, failures, input.random)),
      });
      failed += 1;
    }
  }
  return { claimed: batch.length, done, deferred, failed };
}

/** The whole superagent side of one dispatch: sweep the stranded, drain effects, then sweep the reply lane. */
export type SuperagentDispatchResult = {
  strandedEffects: number;
  strandedReceipts: number;
  effects: EffectsPassResult;
};

/**
 * Runs the superagent drain steps the spec names — effects sweeper, effects
 * pass, receipts sweeper — in one call. The sending itself happens through
 * the `reply` handlers inside the effects pass; `runReceiptsPass` is the
 * direct lane the cron recovery pass uses as a safety net. Handlers should
 * come from `effectHandlers` so every consumer registers in one place.
 */
export async function runSuperagentDispatch(
  rawClient: RawClient,
  handlers: Partial<Record<EffectKind, EffectHandler>>,
  input: { workerId: string; workspaceId?: string; limit?: number; leaseMs?: number; random?: () => number },
): Promise<SuperagentDispatchResult> {
  const strandedEffectIds = await recoverStrandedEffects(rawClient);
  const effects = await runEffectsPass(rawClient, handlers, input);
  const strandedReceiptIds = await recoverStrandedReceipts(rawClient);
  return {
    strandedEffects: strandedEffectIds.length,
    strandedReceipts: strandedReceiptIds.length,
    effects,
  };
}
