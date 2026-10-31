import { providerEntry, type ProviderEntry } from "@/integrations/providers/registry";
import { currentPeriod, drizzleQuotaStore, QuotaExhaustedError, type QuotaStore } from "@/integrations/providers/quota";
import { httpJevClient, type JevAnswer, type JevClient, type JevQuestion } from "./client";

/*
 * The gated Jev judger (ASH-272). Two gatekeepers, both in code:
 *
 * 1. The provider registry: the jev entry ships disabled (enabled: false,
 *    allowPaidUsage: false - cheap is not free, and there is no recurring
 *    free allowance). judge() reads the entry and throws JevDisabledError
 *    while it is disabled; the enrichment handler catches that and falls
 *    back to the existing generation prompt. Flipping the entry is the
 *    owner's separate paid-usage decision, not this PR.
 * 2. The shared quota ledger: Jev bills per input token, so a judge call
 *    reserves an estimate (chars / 4) before the HTTP call and settles the
 *    response's usage.input_tokens after; a failed call releases the
 *    reservation. There is no default allowance: JEV_MONTHLY_INPUT_TOKENS
 *    unset means a zero cap, so an enabled-but-unbudgeted workspace stops at
 *    QuotaExhaustedError before any spend.
 *
 * sensitiveDataAllowed: false holds: a capture flagged sensitive is refused
 * before anything leaves the machine.
 */

export class JevDisabledError extends Error {
  constructor(reason: string) {
    super(`Jev is unavailable: ${reason}`);
    this.name = "JevDisabledError";
  }
}

export type JevJudgeInput = {
  /** The content every question in this request refers to. */
  state: string;
  questions: Record<string, JevQuestion>;
  /** Refused when the registry entry disallows sensitive data. */
  sensitive?: boolean;
};

export type JevJudgeResult = {
  /** The versioned model id that answered. */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export interface ClassifyJudger {
  judge(input: JevJudgeInput): Promise<JevJudgeResult>;
}

/** Rough input-token estimate for the reservation; settle() corrects to the metered value. */
export function estimateInputTokens(input: JevJudgeInput): number {
  const chars = input.state.length + JSON.stringify(input.questions).length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function jevClassifier(
  workspaceId: string,
  options: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    client?: JevClient;
    quotaStore?: QuotaStore;
    entry?: ProviderEntry | null;
  } = {},
): ClassifyJudger {
  const env = options.env ?? process.env;
  const entry = options.entry !== undefined ? options.entry : providerEntry("jev");
  const quotaStore = options.quotaStore ?? drizzleQuotaStore();
  return {
    async judge(input) {
      if (!entry) throw new JevDisabledError("no registry entry");
      if (!entry.enabled) throw new JevDisabledError(`disabled (freeClass: ${entry.freeClass})`);
      if (input.sensitive && !entry.sensitiveDataAllowed) {
        throw new JevDisabledError("registry disallows sensitive data for this provider");
      }
      const client = options.client ?? httpJevClient(env, options.fetchImpl);
      const allowanceRaw = Number(env.JEV_MONTHLY_INPUT_TOKENS);
      const allowance = Number.isFinite(allowanceRaw) && allowanceRaw > 0 ? Math.floor(allowanceRaw) : 0;
      const period = currentPeriod("monthly");
      const estimate = estimateInputTokens(input);
      const reservation = allowance > 0
        ? await quotaStore.reserve({ workspaceId, provider: "jev", period }, estimate, allowance, "input_tokens")
        : null;
      if (!reservation) throw new QuotaExhaustedError("jev", period, allowance);
      try {
        const response = await client.systemOne({ state: input.state, questions: input.questions });
        await quotaStore.settle(reservation.bucketId, reservation.reservationId, estimate, Math.max(1, response.usage.input_tokens));
        return { model: response.model, answers: response.answers, usage: response.usage };
      } catch (cause) {
        await quotaStore.release(reservation.bucketId, reservation.reservationId, estimate);
        throw cause;
      }
    },
  };
}
