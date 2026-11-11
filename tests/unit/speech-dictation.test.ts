import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Value: protects=dictation's contract with its route: trimmed words on success, "" for no speech,
 * and distinct outcomes for unconfigured, allowance used up and provider failure; spend goes through
 * the quota ledger in the provider's own unit; one audit row per attempt carries no words or audio;
 * fails_when=a failed call is reported as text, the ledger is skipped or settled wrong, a ledger
 * (database) fault is misreported as a provider failure, or the transcript leaks into the audit row;
 * why_new=the domain function is new; seam=injected provider and quota store, recordAudit mocked;
 * no_claim=Postgres (the route integration test writes real rows)
 */

const recordAudit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/domains/audit/record", () => ({ recordAudit }));

import { transcribeDictation } from "@/domains/speech/dictation";
import type { QuotaStore } from "@/integrations/providers/quota";
import {
  TranscriptionRequestError,
  TranscriptionUnconfiguredError,
  type TranscriptionProvider,
} from "@/integrations/transcription/provider";

const auth = { workspaceId: "w1", userId: "u1" };
const audio = { bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]), mimeType: "audio/webm" };

function ledger(admit = true) {
  const calls: string[] = [];
  const store: QuotaStore = {
    async reserve(_key, units) {
      calls.push(`reserve ${units}`);
      return admit ? { bucketId: "b", reservationId: "r" } : null;
    },
    async settle(_bucket, _reservation, reserved, actual) {
      calls.push(`settle ${reserved}->${actual}`);
    },
    async release(_bucket, _reservation, units) {
      calls.push(`release ${units}`);
    },
  } as QuotaStore;
  return { store, calls };
}

function deepgramLike(transcribe: TranscriptionProvider["transcribe"]): TranscriptionProvider {
  return { name: "deepgram:nova-3", registryId: "deepgram", reserveUnits: () => 30, transcribe };
}

beforeEach(() => recordAudit.mockClear());

describe("transcribeDictation", () => {
  it("returns the trimmed words and settles the seconds used", async () => {
    const { store, calls } = ledger();
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => deepgramLike(async () => ({ text: "  send the deck to Priya  ", units: 7 })),
      quotaStore: store,
    });
    expect(outcome).toEqual({ kind: "transcribed", text: "send the deck to Priya" });
    expect(calls).toEqual(["reserve 30", "settle 30->7"]);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const [actor, row] = recordAudit.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(actor).toBe(auth);
    expect(row).toMatchObject({
      action: "speech.dictation_transcribed",
      subjectType: "dictation",
      metadata: { provider: "deepgram:nova-3", seconds: 7, durationMs: expect.any(Number) },
    });
    expect(JSON.stringify(row)).not.toContain("Priya");
  });

  it("returns an empty string when there was no speech", async () => {
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => deepgramLike(async () => ({ text: "   ", units: 2 })),
      quotaStore: ledger().store,
    });
    expect(outcome).toEqual({ kind: "transcribed", text: "" });
  });

  it("reports seconds as null for a provider not metered in seconds", async () => {
    // Firecrawl's entry stands in: metered in credits and cleared for sensitive content.
    const provider: TranscriptionProvider = {
      name: "credits:test",
      registryId: "firecrawl",
      reserveUnits: () => 1,
      transcribe: async () => ({ text: "hi", units: 1 }),
    };
    await transcribeDictation(auth, audio, { provider: () => provider, quotaStore: ledger().store });
    const row = recordAudit.mock.calls[0] as unknown as [unknown, { metadata: Record<string, unknown> }];
    expect(row[1].metadata.seconds).toBeNull();
  });

  it("answers unconfigured without a provider call", async () => {
    const { store, calls } = ledger();
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => {
        throw new TranscriptionUnconfiguredError();
      },
      quotaStore: store,
    });
    expect(outcome).toEqual({ kind: "unconfigured" });
    expect(calls).toEqual([]);
    expect(recordAudit.mock.calls[0]).toMatchObject([
      auth,
      { action: "speech.dictation_failed", metadata: { outcome: "unconfigured", provider: null } },
    ]);
  });

  it("answers exhausted before any provider call when the allowance is used up", async () => {
    const transcribe = vi.fn(async () => ({ text: "never", units: 1 }));
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => deepgramLike(transcribe),
      quotaStore: ledger(false).store,
    });
    expect(outcome).toEqual({ kind: "exhausted" });
    expect(transcribe).not.toHaveBeenCalled();
    expect(recordAudit.mock.calls[0]).toMatchObject([
      auth,
      { action: "speech.dictation_failed", metadata: { outcome: "exhausted", provider: "deepgram:nova-3" } },
    ]);
  });

  it("answers failed and releases the reservation when the provider fails", async () => {
    const { store, calls } = ledger();
    const outcome = await transcribeDictation(auth, audio, {
      provider: () =>
        deepgramLike(async () => {
          throw new TranscriptionRequestError("deepgram", 500);
        }),
      quotaStore: store,
    });
    expect(outcome).toEqual({ kind: "failed" });
    expect(calls).toEqual(["reserve 30", "release 30"]);
    expect(recordAudit.mock.calls[0]).toMatchObject([
      auth,
      { action: "speech.dictation_failed", metadata: { outcome: "failed" } },
    ]);
  });

  it("lets a ledger fault surface instead of calling it a provider failure", async () => {
    const store = { ...ledger().store, reserve: async () => Promise.reject(new Error("connection refused")) };
    await expect(
      transcribeDictation(auth, audio, {
        provider: () => deepgramLike(async () => ({ text: "x", units: 1 })),
        quotaStore: store as QuotaStore,
      }),
    ).rejects.toThrow("connection refused");
  });
  it("a provider the registry does not clear for sensitive content never hears dictation", async () => {
    const { store, calls } = ledger();
    const transcribe = vi.fn(async () => ({ text: "private words", units: 1 }));
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => ({ name: "gemini:test", registryId: "gemini", reserveUnits: () => 1, transcribe }),
      quotaStore: store,
    });
    expect(outcome).toEqual({ kind: "unconfigured" });
    expect(transcribe).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("an unknown provider name is a setup problem, not a failed call", async () => {
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => {
        throw new TranscriptionRequestError("whisper", 0);
      },
      quotaStore: ledger().store,
    });
    expect(outcome).toEqual({ kind: "unconfigured" });
  });

  it("the words still come back when the audit row cannot be written", async () => {
    recordAudit.mockRejectedValueOnce(new Error("connection lost"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await transcribeDictation(auth, audio, {
      provider: () => deepgramLike(async () => ({ text: "keep these words", units: 3 })),
      quotaStore: ledger().store,
    });
    warn.mockRestore();
    expect(outcome).toEqual({ kind: "transcribed", text: "keep these words" });
  });
});
