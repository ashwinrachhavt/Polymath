import { describe, expect, it } from "vitest";
import { JevUnconfiguredError, type JevClient } from "@/integrations/jev/client";
import { JevDisabledError, estimateInputTokens, jevClassifier } from "@/integrations/jev/provider";
import { QuotaExhaustedError, type QuotaStore } from "@/integrations/providers/quota";
import type { ProviderEntry } from "@/integrations/providers/registry";

/*
 * The Jev provider's gates (ASH-272), with a fake client and an in-memory
 * QuotaStore: the registry entry decides availability, the ledger decides
 * spend, and a failed call releases its reservation. No HTTP anywhere.
 */

const ENABLED: ProviderEntry = {
  id: "jev",
  capability: "classify",
  freeClass: "unverified",
  enabled: true,
  allowPaidUsage: true,
  allowPaidFallback: false,
  sensitiveDataAllowed: false,
  quota: null,
  verifiedAt: "2026-10-25",
  verificationSource: "test",
  notes: "test entry",
};

const DISABLED: ProviderEntry = { ...ENABLED, enabled: false, allowPaidUsage: false };

function fakeClient(answers: Record<string, never> = {}, inputTokens = 100): JevClient & { calls: number } {
  return {
    calls: 0,
    async systemOne() {
      this.calls += 1;
      return { model: "jev-1.14.0", answers, usage: { input_tokens: inputTokens, output_tokens: 10 } };
    },
  };
}

function fakeStore() {
  const events: Array<[string, number]> = [];
  const store: QuotaStore = {
    async reserve(_key, units) {
      events.push(["reserve", units]);
      return { bucketId: "b1" };
    },
    async settle(_bucketId, _held, actual) {
      events.push(["settle", actual]);
    },
    async release(_bucketId, held) {
      events.push(["release", held]);
    },
  };
  return { store, events };
}

const judgeInput = { state: "x".repeat(400), questions: {} };

describe("jevClassifier registry gate", () => {
  it("throws JevDisabledError while the entry is disabled, before any quota or HTTP", async () => {
    const client = fakeClient();
    const { store, events } = fakeStore();
    const judger = jevClassifier("ws1", { entry: DISABLED, client, quotaStore: store, env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "100000" } });
    await expect(judger.judge(judgeInput)).rejects.toThrow(JevDisabledError);
    expect(client.calls).toBe(0);
    expect(events).toEqual([]);
  });

  it("refuses a sensitive capture when the entry disallows sensitive data", async () => {
    const client = fakeClient();
    const judger = jevClassifier("ws1", { entry: ENABLED, client, quotaStore: fakeStore().store, env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "100000" } });
    await expect(judger.judge({ ...judgeInput, sensitive: true })).rejects.toThrow(JevDisabledError);
    expect(client.calls).toBe(0);
  });

  it("surfaces JevUnconfiguredError when the key is absent (handler falls back)", async () => {
    const judger = jevClassifier("ws1", { entry: ENABLED, quotaStore: fakeStore().store, env: { JEV_MONTHLY_INPUT_TOKENS: "100000" } });
    await expect(judger.judge(judgeInput)).rejects.toThrow(JevUnconfiguredError);
  });
});

describe("jevClassifier quota", () => {
  it("reserves an estimate before the call and settles the metered usage after", async () => {
    const client = fakeClient({}, 812);
    const { store, events } = fakeStore();
    const judger = jevClassifier("ws1", { entry: ENABLED, client, quotaStore: store, env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "100000" } });
    const out = await judger.judge(judgeInput);
    expect(out.usage.input_tokens).toBe(812);
    expect(events).toEqual([["reserve", estimateInputTokens(judgeInput)], ["settle", 812]]);
  });

  it("a failed call releases the reservation", async () => {
    const failing: JevClient = { async systemOne() { throw new Error("boom"); } };
    const { store, events } = fakeStore();
    const judger = jevClassifier("ws1", { entry: ENABLED, client: failing, quotaStore: store, env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "100000" } });
    await expect(judger.judge(judgeInput)).rejects.toThrow("boom");
    expect(events).toEqual([["reserve", estimateInputTokens(judgeInput)], ["release", estimateInputTokens(judgeInput)]]);
  });

  it("no configured allowance means a zero cap: QuotaExhaustedError before any HTTP", async () => {
    const client = fakeClient();
    const { store, events } = fakeStore();
    const judger = jevClassifier("ws1", { entry: ENABLED, client, quotaStore: store, env: { TYPESAFE_API_KEY: "k" } });
    await expect(judger.judge(judgeInput)).rejects.toThrow(QuotaExhaustedError);
    expect(client.calls).toBe(0);
    expect(events).toEqual([]);
  });

  it("a store refusal (ledger exhausted) is QuotaExhaustedError before any HTTP", async () => {
    const client = fakeClient();
    const refusing: QuotaStore = {
      async reserve() { return null; },
      async settle() {},
      async release() {},
    };
    const judger = jevClassifier("ws1", { entry: ENABLED, client, quotaStore: refusing, env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "100000" } });
    await expect(judger.judge(judgeInput)).rejects.toThrow(QuotaExhaustedError);
    expect(client.calls).toBe(0);
  });
});
