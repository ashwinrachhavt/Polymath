import { recordAudit } from "@/domains/audit/record";
import { drizzleQuotaStore, QuotaExhaustedError, withQuota, type QuotaStore } from "@/integrations/providers/quota";
import { providerEntry } from "@/integrations/providers/registry";
import {
  transcriptionProvider,
  TranscriptionUnconfiguredError,
  type TranscriptionProvider,
} from "@/integrations/transcription/provider";

/*
 * One dictation clip in, its words out. The caller has already sniffed the
 * bytes as audio; this resolves the provider, admits the call through the
 * quota ledger exactly as voice-capture transcription does, and writes one
 * audit row per attempt. Neither the audio nor the transcript is persisted or
 * put in the audit row: dictation text belongs to whatever field the person
 * is typing in, and nothing else.
 */

export type DictationAudio = {
  bytes: Uint8Array;
  /** The sniffed type, never the client's claim. */
  mimeType: string;
};

export type DictationOutcome =
  { kind: "transcribed"; text: string } | { kind: "unconfigured" } | { kind: "exhausted" } | { kind: "failed" };

type Dependencies = {
  /** Resolves the configured provider; throws TranscriptionUnconfiguredError when there is none. */
  provider: () => TranscriptionProvider;
  quotaStore: QuotaStore;
};

/*
 * Wraps whatever the provider threw, so a quota-ledger error (a database
 * fault) still surfaces as a 500 instead of being reported as the provider's.
 */
class ProviderCallError extends Error {
  constructor(cause: unknown) {
    super("Transcription provider call failed", { cause });
    this.name = "ProviderCallError";
  }
}

const defaultDependencies = (): Dependencies => ({
  provider: () => transcriptionProvider(),
  quotaStore: drizzleQuotaStore(),
});

export async function transcribeDictation(
  auth: { workspaceId: string; userId: string },
  audio: DictationAudio,
  deps: Dependencies = defaultDependencies(),
): Promise<DictationOutcome> {
  const attemptId = crypto.randomUUID();
  const failure = async (outcome: "unconfigured" | "exhausted" | "failed", provider: string | null) => {
    await recordAudit(auth, {
      action: "speech.dictation_failed",
      subjectType: "dictation",
      subjectId: attemptId,
      summary: `Dictation not transcribed (${outcome})`,
      metadata: { outcome, provider },
    });
    return { kind: outcome } as const;
  };

  let provider: TranscriptionProvider;
  try {
    provider = deps.provider();
  } catch (cause) {
    if (cause instanceof TranscriptionUnconfiguredError) return failure("unconfigured", null);
    return failure("failed", null);
  }

  const entry = providerEntry(provider.registryId);
  const call = () =>
    provider.transcribe(audio).catch((cause: unknown) => {
      throw new ProviderCallError(cause);
    });
  const startedAt = performance.now();
  let result: { text: string; units: number };
  try {
    result =
      entry?.quota && entry.enabled
        ? await withQuota(deps.quotaStore, entry, auth.workspaceId, provider.reserveUnits(audio), call, (r) => r.units)
        : await call();
  } catch (cause) {
    if (cause instanceof QuotaExhaustedError) return failure("exhausted", provider.name);
    if (cause instanceof ProviderCallError) return failure("failed", provider.name);
    throw cause;
  }
  const durationMs = Math.round(performance.now() - startedAt);

  await recordAudit(auth, {
    action: "speech.dictation_transcribed",
    subjectType: "dictation",
    subjectId: attemptId,
    summary: `Dictation transcribed with ${provider.name}`,
    metadata: {
      provider: provider.name,
      seconds: entry?.quota?.unit === "seconds" ? result.units : null,
      durationMs,
    },
  });
  return { kind: "transcribed", text: result.text.trim() };
}
