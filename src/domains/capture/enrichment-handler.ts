import { and, eq, isNull, sql } from "drizzle-orm";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { z } from "zod";
import { OutboxParkError, type ClaimedOutboxEvent, type OutboxHandler } from "@/domains/audit/outbox";
import { outboxEvents } from "@/domains/audit/schema";
import {
  EnrichmentLeaseLostError,
  RELEASE,
  acquireEnrichmentLease,
  ownedUpdate,
  releaseEnrichmentLease,
} from "./enrichment-lease";
import {
  GenerationRequestError,
  GenerationUnconfiguredError,
  generationProvider,
} from "@/integrations/generation/provider";
import { JevRequestError, JevUnconfiguredError, type JevAnswer } from "@/integrations/jev/client";
import { JevDisabledError, jevClassifier, type ClassifyJudger } from "@/integrations/jev/provider";
import { providerEntry } from "@/integrations/providers/registry";
import { JEV_QUESTIONS_VERSION, captureQuestions } from "@/integrations/jev/questions";
import { taxonomyNodes } from "@/domains/knowledge/schema";
import { resolveTaxonomyPath } from "@/domains/knowledge/taxonomy";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { blobObjects } from "../audit/schema";
import { recordAudit } from "@/domains/audit/record";
import { workspaceOwnerAuth } from "@/domains/audit/outbox-handlers";
import { QuotaExhaustedError, drizzleQuotaStore, withQuota } from "@/integrations/providers/quota";
import { readBlob } from "@/integrations/object-store/object-store";
import {
  transcriptionProvider,
  TranscriptionUnconfiguredError,
  type TranscriptionProvider,
} from "@/integrations/transcription/provider";
import { captureProposals, captures } from "./schema";
import { triageCapture } from "./jev-classify";
import { workingText } from "./mode";
import { LLM_MAX_INPUT_CHARS, LLM_THRESHOLD_CHARS, MAX_TAGS, classifyCapture } from "./classification";
/*
 * The capture enrichment ladder, as an outbox consumer. Ordered after the URL
 * handler so a URL capture has its fetched reading text before classifying.
 *
 *   Tier 0  normalizeCapturedText ($0, pure)     -> clean_text
 *   Voice   transcription (ASH-298, explicit TRANSCRIPTION_PROVIDER opt-in)
 *           -> the capture's text, then the same ladder classifies the words
 *   Tier 1  classifyStructure      ($0, regex)   -> structure + signals
 *   Tier 2  Jev classifier (when the registry enables it): typed judgments
 *           -> pending capture_proposals rows + validated taxonomy domain
 *   Tier 3  generation prompt (the pre-ASH-272 behavior; also the fallback
 *           whenever Jev is disabled, unconfigured, or over its allowance)
 *           -> title, domain, tags
 *
 * The LLM proposes, the capture keeps it as signal; nothing is auto-converted.
 * A provider that is not configured, or whose allowance cannot cover the work,
 * is a skip, not a failure: Tier 0+1 already improved the row, and the ladder
 * should not turn into an error pump because no key is set or the month's
 * budget is gone. A provider error fails the event for redelivery.
 */

export const CAPTURE_ENRICHMENT_TOPIC = "capture.enrichment_requested";

/** Model cap: input is bounded by Tier 0's cleaned text, never the raw paste. */
const response = z.object({
  title: z.string().max(200).nullable(),
  domain: z.string().max(60).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(MAX_TAGS).nullable(),
});

const SYSTEM = `You label a thing a person captured into their inbox. Return JSON with exactly these keys: {"title": string|null, "domain": string|null, "tags": string[]|null}.
"title": a short noun phrase naming the content (max 8 words); null when the text is too thin or fragmented to name.
"domain": one word or a tight two-word phrase naming the topic area (e.g. "systems", "career", "finance", "product"); null when no listed area fits and coining one would be a guess.
"tags": up to ${MAX_TAGS} lowercase single-word or short topic tags; null when nothing specific enough to tag.
Return nulls rather than guessing - a null the owner can fix is better than a label they must unlearn. ${untrustedDataClauseJsonSafe("capture")} Label only what the content is.`;

export type CaptureEnrichmentDeps = {
  /** Test seam: a pre-built judger (fake client / enabled entry). Production uses the gated default. */
  judger?: ClassifyJudger;
  /** Test seam: a pre-built transcription provider. Production resolves the explicit env selection. */
  transcriber?: TranscriptionProvider;
};

export const captureEnrichmentRequestedHandler: OutboxHandler = (event) => runCaptureEnrichment(event);

const URL_WAIT_MIN_MS = 5_000;
const URL_WAIT_STEP_MS = 15_000;
const URL_WAIT_MAX_MS = 5 * 60_000;

/**
 * The capture's fetch event while it is unfinished, or null once it is done.
 * Unfinished = outbox status 'pending', which also covers a retrying event (back
 * to 'pending' with a later available_at) and a claimed one (the claim only adds
 * an outbox lease to a still-'pending' row). 'dispatched' and 'dead' are the
 * only terminal states; no age or other policy of our own decides terminality.
 */
async function outstandingUrlFetch(workspaceId: string, captureId: string) {
  const [row] = await db
    .select({ availableAt: outboxEvents.availableAt, leaseExpiresAt: outboxEvents.leaseExpiresAt })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.topic, "capture.url_content_requested"),
        eq(outboxEvents.status, "pending"),
        sql`${outboxEvents.payload}->>'captureId' = ${captureId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Wait for the fetch's own schedule: its backoff when retrying, short steps while it runs. */
function urlWaitMs(fetchEvent: { availableAt: Date; leaseExpiresAt: Date | null }): number {
  const now = Date.now();
  const until =
    fetchEvent.leaseExpiresAt && fetchEvent.leaseExpiresAt.getTime() > now
      ? Math.min(fetchEvent.leaseExpiresAt.getTime() + 1000, now + URL_WAIT_STEP_MS)
      : fetchEvent.availableAt.getTime() + 1000;
  return Math.min(Math.max(until - now, URL_WAIT_MIN_MS), URL_WAIT_MAX_MS);
}

export const runCaptureEnrichment = async (event: ClaimedOutboxEvent, deps: CaptureEnrichmentDeps = {}) => {
  const raw = event.payload ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CAPTURE_ENRICHMENT_TOPIC} has a malformed payload (${typeof raw}); redeploy the producer`);
  }
  const captureId =
    typeof (raw as { captureId?: unknown }).captureId === "string" ? (raw as { captureId: string }).captureId : null;
  if (!captureId) throw new Error(`${CAPTURE_ENRICHMENT_TOPIC} is missing captureId`);

  const [capture] = await db.select().from(captures).where(eq(captures.id, captureId)).limit(1);
  if (!capture || capture.workspaceId !== event.workspaceId) return;
  if (capture.processingState !== "unprocessed" && capture.processingState !== "classifying") return;
  // Parked (ASH-305): set aside, so no new model call or proposal. Unpark re-queues this.
  if (capture.parkedAt) return;

  // ASH-318: a URL capture is classified on its fetched page, not its address.
  // While the fetch is still outstanding (pending or retrying, so not yet
  // dispatched or dead-lettered), wait for it instead of finalizing an empty
  // capture that the fetch would then refuse to fill. The wait ends only when
  // the outbox says the fetch event is done (dispatched, or dead after its
  // retries); a failed fetch therefore falls through to address-only enrichment.
  const pendingFetch = capture.url ? await outstandingUrlFetch(event.workspaceId, captureId) : null;
  if (pendingFetch) throw new OutboxParkError(urlWaitMs(pendingFetch), "waiting for the page to be fetched");

  const token = await acquireEnrichmentLease(event, capture);
  if (!token) return;

  try {
    await enrichLeased(event, deps, capture, token);
  } catch (cause) {
    if (cause instanceof EnrichmentLeaseLostError) return;
    // A failed attempt frees the claim so the redelivery isn't parked behind its own corpse.
    await releaseEnrichmentLease(token, captureId);
    throw cause;
  }
};

/*
 * An address-only URL capture keeps its recorded fetch failure: enrichment
 * proceeding on the bare address is not the page being read after all, and
 * clearing the reason would leave the inbox claiming "Reading the page now"
 * forever. Once any text exists the reason is stale and clears.
 */
export function settledFailureReason(capture: { failureReason: string | null }, bodyText: string): string | null {
  const body = bodyText.trim();
  // Whitespace is nothing, and a bare URL is a pointer, not grounded text.
  if (!body || /^https?:\/\/\S+$/.test(body)) return capture.failureReason;
  return null;
}

async function enrichLeased(
  event: ClaimedOutboxEvent,
  deps: CaptureEnrichmentDeps,
  capture: typeof captures.$inferSelect,
  token: string,
) {
  const captureId = capture.id;

  // Tier 0 + 1 run on the capture's working text: the paste for an authored or
  // selection capture, the page's fetched reading for a page. A capture with no
  // working text (a blob still awaiting transcription) classifies as empty,
  // exactly as it did when this read `capture.text` alone.
  // Voice first (ASH-298): the transcript becomes the capture's text, then
  // the SAME ladder reads it - no parallel audio pipeline. Unconfigured is
  // honest: the capture keeps its audio, carries the reason, and this event
  // completes instead of redelivering against a missing key forever. A
  // provider ERROR stays redeliverable, like the other tiers.
  let textForLadder = workingText(capture) ?? "";
  if (capture.kind === "voice" && !textForLadder) {
    const transcript = await transcribeVoiceCapture(token, capture, event, deps.transcriber);
    if (transcript === null) return;
    textForLadder = transcript;
  }

  const body = textForLadder;
  const { cleanText, structure } = classifyCapture(body);

  // The LLM tier reads prose only: a URL, code block, or contact block gains
  // nothing from a model naming it, and every skipped call is free.
  const wantsLlm = structure === "prose" && cleanText.length >= LLM_THRESHOLD_CHARS;

  const base = {
    cleanText: cleanText || null,
    structure,
    updatedAt: new Date(),
  };

  if (!wantsLlm) {
    await ownedUpdate(token, captureId, {
      ...base,
      processingState: "enriched",
      failureReason: settledFailureReason(capture, body),
      ...RELEASE,
    });
    return;
  }

  // classifying while the model call is in flight; the inbox query treats it
  // as in-queue, and a crash here leaves a re-deliverable outbox row.
  await ownedUpdate(token, captureId, {
    ...base,
    processingState: "classifying",
  });

  // Tier 2 (ASH-272): the Jev classifier. The registry entry is enabled
  // (registry.ts, verified 2026-10-25), so this tier runs unless the workspace
  // has no JEV_MONTHLY_INPUT_TOKENS budget: the quota ledger has no default
  // allowance, and an unset or zero cap refuses Jev before it spends anything.
  // That refusal is a skip, not an event failure: the deterministic ladder's
  // work would otherwise be thrown away, so `skipped` carries the reason to
  // record. A Jev request error fails the event for redelivery; an unreadable
  // answer degrades to a low-confidence note proposal, never a crash and never
  // a silent skip.
  const jev = await tryJevTriage(token, captureId, event.workspaceId, capture, base, cleanText, structure, deps.judger);
  if (jev.outcome === "handled") return;
  // Why the optional paid tier did not run, on the row the owner reads. A later
  // redelivery that reaches Jev clears it, like every other settled reason.
  const paidTierSkipped = jev.skipped;

  let provider: ReturnType<typeof generationProvider>;
  try {
    provider = generationProvider(process.env);
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) {
      // No key, no model: keep the deterministic tiers' work, mark enriched.
      await ownedUpdate(token, captureId, {
        ...base,
        processingState: "enriched",
        failureReason: settledFailureReason(capture, body) ?? paidTierSkipped,
        ...RELEASE,
      });
      return;
    }
    throw cause;
  }

  let parsed: z.infer<typeof response>;
  try {
    const out = await provider.generate({
      system: SYSTEM,
      prompt: `<<<BEGIN_DOCUMENT>>>\n${cleanText.slice(0, LLM_MAX_INPUT_CHARS)}\n<<<END_DOCUMENT>>>`,
      json: true,
    });
    parsed = response.parse(JSON.parse(out.text));
  } catch (cause) {
    if (cause instanceof GenerationRequestError || cause instanceof GenerationUnconfiguredError) {
      throw cause; // redeliverable: quota exhaustion, provider down, malformed reply
    }
    // A readable-but-wrong model answer is not a transient condition worth
    // retrying: the deterministic tiers already landed, note it and finish.
    await ownedUpdate(token, captureId, {
      processingState: "enriched",
      failureReason: "Enrichment returned an unreadable answer.",
      updatedAt: new Date(),
      ...RELEASE,
    });
    return;
  }

  const tags = parsed.tags
    ?.map((t) => t.toLowerCase().trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  await ownedUpdate(token, captureId, {
    ...base,
    title: parsed.title?.trim() || null,
    domain: parsed.domain?.toLowerCase().trim() || null,
    tags: tags && tags.length > 0 ? tags : null,
    processingState: "enriched",
    failureReason: settledFailureReason(capture, body) ?? paidTierSkipped,
    ...RELEASE,
  });
}

const noul = (answer: JevAnswer | undefined): number => (answer && answer.type === "noul" ? answer.noul : Number.NaN);

type JevTriage =
  | { outcome: "handled"; skipped: null }
  | { outcome: "fallback"; skipped: string | null };

/**
 * Why the paid tier did not run, in the owner's words, or null when it was
 * never in question. Only an exhausted allowance is stated: a disabled or
 * unconfigured provider is the deployment's shape, not news about this capture.
 */
const ALLOWANCE_SKIPPED =
  "Enriched without the paid classification tier: its allowance for this period is used up.";

/**
 * One bundled Jev judgment pass over the capture. Returns "handled" when the
 * Jev path owns the outcome (proposal rows written, capture enriched), and
 * "fallback" when the generation tier should run instead: the entry is disabled
 * in the registry (the owner's kill switch), the workspace set no monthly token
 * budget or has spent it, or the capture is flagged sensitive. In the budget
 * cases `skipped` carries the reason, so a paid tier that did not run is
 * recorded rather than silently omitted.
 */
async function tryJevTriage(
  token: string,
  captureId: string,
  workspaceId: string,
  capture: { title: string | null; kind: string; failureReason: string | null },
  base: { cleanText: string | null; structure: string; updatedAt: Date },
  cleanText: string,
  structure: string,
  injectedJudger?: ClassifyJudger,
): Promise<JevTriage> {
  // Fast path: with no injected judger and the registry entry disabled, fall
  // through without touching the taxonomy table. The shipped entry is enabled
  // (registry.ts, 2026-10-25), so this branch is the owner's kill switch and
  // the test path, not the default.
  if (!injectedJudger && !providerEntry("jev")?.enabled) return { outcome: "fallback", skipped: null };
  const judger = injectedJudger ?? jevClassifier(workspaceId);

  // The domain Choice's options come from the workspace's seeded taxonomy;
  // an unseeded workspace simply asks no domain question (domain stays null).
  // Only level-1 domains are offered: the write side (resolveTaxonomyPath)
  // resolves single slugs at level 1, so offering subdomains or microtopics
  // would present choices the classifier cannot persist.
  const domains = await db
    .select({
      slug: taxonomyNodes.slug,
      description: taxonomyNodes.description,
    })
    .from(taxonomyNodes)
    .where(and(eq(taxonomyNodes.workspaceId, workspaceId), eq(taxonomyNodes.level, 1), isNull(taxonomyNodes.archivedAt)));

  const state = JSON.stringify({
    title: capture.title ?? undefined,
    cleanText: cleanText.slice(0, LLM_MAX_INPUT_CHARS),
    structure,
    source: capture.kind,
  });

  let answers: Record<string, JevAnswer>;
  let model: string;
  try {
    const result = await judger.judge({
      state,
      questions: captureQuestions(domains),
    });
    answers = result.answers;
    model = result.model;
  } catch (cause) {
    if (cause instanceof QuotaExhaustedError) return { outcome: "fallback", skipped: ALLOWANCE_SKIPPED };
    if (cause instanceof JevDisabledError || cause instanceof JevUnconfiguredError) {
      return { outcome: "fallback", skipped: null };
    }
    if (cause instanceof JevRequestError) throw cause; // redeliverable, like generation errors
    throw cause;
  }

  const domainAnswer = answers.domain;
  const domain =
    domainAnswer && domainAnswer.type === "choice"
      ? {
          choice: domainAnswer.choice,
          topProbability: domainAnswer.probabilities[domainAnswer.choice] ?? 0,
        }
      : null;
  const numbers = {
    commitment: noul(answers.commitment),
    contact: noul(answers.contact),
    reference: noul(answers.reference),
    worthless: noul(answers.worthless),
    project: noul(answers.project),
  };
  const unreadable = Object.values(numbers).some((n) => Number.isNaN(n));

  const triage = unreadable
    ? {
        proposals: [
          {
            kind: "note" as const,
            payload: { review: true },
            rationale: "jev returned an unreadable answer; filed for review",
            confidence: "low",
          },
        ],
        domainSlug: null,
      }
    : triageCapture({ ...numbers, domain });

  // The domain label is written only when it resolves in the workspace's
  // taxonomy - a hallucinated slug is a rejected write, never stored.
  let domainSlug: string | null = null;
  if (triage.domainSlug) {
    const path = await resolveTaxonomyPath({ workspaceId }, { slugs: [triage.domainSlug] });
    domainSlug = path ? path[0].slug : null;
  }

  // ASH-305: the write is a compare-and-set, so a duplicate run (a redelivered
  // event after a crash, or the unpark re-queue racing the original) can never
  // double the proposals: only the run that moves the capture out of
  // unprocessed/classifying inserts them, in the same transaction. classifying
  // stays eligible so crash recovery is unchanged. A capture parked mid-flight
  // still finishes; its proposals stay hidden until unpark.
  await withTransaction(async (tx) => {
    const [claimed] = await tx
      .update(captures)
      .set({
        ...base,
        domain: domainSlug,
        processingState: "enriched",
        failureReason: unreadable ? "Jev returned an unreadable answer." : settledFailureReason(capture, cleanText),
        ...RELEASE,
      })
      .where(and(eq(captures.id, captureId), eq(captures.enrichmentLeaseToken, token)))
      .returning({ id: captures.id });
    // Lease lost: a newer holder owns this capture; this run files nothing.
    if (!claimed) throw new EnrichmentLeaseLostError();
    for (const proposal of triage.proposals) {
      await tx.insert(captureProposals).values({
        workspaceId,
        captureId,
        kind: proposal.kind,
        payload: proposal.payload,
        rationale: proposal.rationale,
        model,
        promptVersion: JEV_QUESTIONS_VERSION,
        confidence: proposal.confidence,
      });
    }
  });
  return { outcome: "handled", skipped: null };
}

/**
 * Transcribe a voice capture's audio and persist the words as its text.
 * Returns the transcript ("" for no speech), or null when transcription is
 * not configured - the capture is then marked, never faked. The audio bytes
 * are the immutable original in raw_payload/blob storage; the transcript is
 * derived material and lands in `text`, where the ladder and the owner can
 * read and correct it. Quota admission wraps the provider call exactly like
 * the generation seam: the registry's gemini entry carries the allowance.
 */
async function transcribeVoiceCapture(
  token: string,
  capture: { id: string; workspaceId: string; blobId: string | null },
  event: ClaimedOutboxEvent,
  injected?: TranscriptionProvider,
): Promise<string | null> {
  let provider: TranscriptionProvider;
  try {
    provider = injected ?? transcriptionProvider();
  } catch (cause) {
    if (cause instanceof TranscriptionUnconfiguredError) {
      await ownedUpdate(token, capture.id, {
        processingState: "failed",
        failureReason:
          "Transcription is not configured on this deployment - the audio is kept; ask the owner to set TRANSCRIPTION_PROVIDER.",
        updatedAt: new Date(),
        ...RELEASE,
      });
      return null;
    }
    throw cause;
  }

  if (!capture.blobId) {
    // A voice capture without bytes is a broken write, not a retryable state.
    await ownedUpdate(token, capture.id, {
      processingState: "failed",
      failureReason: "The audio is missing from storage.",
      updatedAt: new Date(),
      ...RELEASE,
    });
    return null;
  }
  const [blob] = await db.select().from(blobObjects).where(eq(blobObjects.id, capture.blobId)).limit(1);
  if (!blob) throw new Error(`voice capture ${capture.id} points at missing blob ${capture.blobId}`);
  const bytes = await readBlob(blob.storageKey);

  const entry = providerEntry(provider.registryId);
  const call = () => provider.transcribe({ bytes, mimeType: blob.mimeType });
  const { text } =
    entry?.quota && entry.enabled
      ? await withQuota(drizzleQuotaStore(), entry, event.workspaceId, 1, call)
      : await call();
  const transcript = text.trim();

  await ownedUpdate(token, capture.id, {
    text: transcript || null,
    processingState: "unprocessed",
    updatedAt: new Date(),
  });
  const ownerAuth = await workspaceOwnerAuth(event.workspaceId);
  if (ownerAuth) {
    await recordAudit(ownerAuth, {
      action: "capture.transcribed",
      subjectType: "capture",
      subjectId: capture.id,
      summary: transcript
        ? `Transcribed with ${provider.name} (${transcript.length} chars)`
        : `No speech found (${provider.name})`,
      metadata: { actor: "transcription" },
      actorKind: "system",
    });
  }
  return transcript;
}
