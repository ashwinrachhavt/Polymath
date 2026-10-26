import { and, eq, inArray, sql } from "drizzle-orm";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { z } from "zod";
import {
  OutboxParkError,
  type ClaimedOutboxEvent,
  type OutboxHandler,
} from "@/domains/audit/outbox";
import {
  GenerationRequestError,
  GenerationUnconfiguredError,
  generationProvider,
} from "@/integrations/generation/provider";
import {
  JevRequestError,
  JevUnconfiguredError,
  type JevAnswer,
} from "@/integrations/jev/client";
import {
  JevDisabledError,
  jevClassifier,
  type ClassifyJudger,
} from "@/integrations/jev/provider";
import { providerEntry } from "@/integrations/providers/registry";
import {
  JEV_QUESTIONS_VERSION,
  captureQuestions,
} from "@/integrations/jev/questions";
import { taxonomyNodes } from "@/domains/knowledge/schema";
import { resolveTaxonomyPath } from "@/domains/knowledge/taxonomy";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { blobObjects } from "../audit/schema";
import { recordAudit } from "@/domains/audit/record";
import { workspaceOwnerAuth } from "@/domains/audit/outbox-handlers";
import { drizzleQuotaStore, withQuota } from "@/integrations/providers/quota";
import { readBlob } from "@/integrations/object-store/object-store";
import {
  transcriptionProvider,
  TranscriptionUnconfiguredError,
  type TranscriptionProvider,
} from "@/integrations/transcription/provider";
import { captureProposals, captures } from "./schema";
import { triageCapture } from "./jev-classify";
import {
  LLM_MAX_INPUT_CHARS,
  LLM_THRESHOLD_CHARS,
  MAX_TAGS,
  classifyCapture,
} from "./classification";
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
 *           whenever Jev is disabled or unconfigured) -> title, domain, tags
 *
 * The LLM proposes, the capture keeps it as signal; nothing is auto-converted.
 * A provider that is not configured is a skip, not a failure: Tier 0+1 already
 * improved the row, and the ladder should not turn into an error pump just
 * because no key is set. A provider error fails the event for redelivery.
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

export const captureEnrichmentRequestedHandler: OutboxHandler = (event) =>
  runCaptureEnrichment(event);

/*
 * ASH-305 enrichment lease. Longest honest run: transcription (60s) + Jev
 * (30s) + generation fallback (30s) = 120s of provider time, so 5 minutes
 * clears it with margin for quota admission and storage reads. A crashed run
 * blocks its redelivery for at most this long. If a run ever outlives the
 * lease it is fenced out, not trusted: its writes match no row and it stops.
 * That bounds duplicate paid calls to the expiry case; it is not exactly-once
 * across expiry.
 */
export const ENRICHMENT_LEASE_MS = 5 * 60_000;
const RELEASE = {
  enrichmentLeaseToken: null,
  enrichmentLeaseUntil: null,
} as const;

class EnrichmentLeaseLostError extends Error {
  constructor() {
    super("enrichment lease lost");
    this.name = "EnrichmentLeaseLostError";
  }
}

/** A write by the lease holder only; zero rows means someone else holds or finished the capture. */
async function ownedUpdate(
  token: string,
  captureId: string,
  set: Partial<typeof captures.$inferInsert>,
) {
  const rows = await db
    .update(captures)
    .set(set)
    .where(
      and(eq(captures.id, captureId), eq(captures.enrichmentLeaseToken, token)),
    )
    .returning({ id: captures.id });
  if (rows.length === 0) throw new EnrichmentLeaseLostError();
}

export const runCaptureEnrichment = async (
  event: ClaimedOutboxEvent,
  deps: CaptureEnrichmentDeps = {},
) => {
  const raw = event.payload ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${CAPTURE_ENRICHMENT_TOPIC} has a malformed payload (${typeof raw}); redeploy the producer`,
    );
  }
  const captureId =
    typeof (raw as { captureId?: unknown }).captureId === "string"
      ? (raw as { captureId: string }).captureId
      : null;
  if (!captureId)
    throw new Error(`${CAPTURE_ENRICHMENT_TOPIC} is missing captureId`);

  const [capture] = await db
    .select()
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1);
  if (!capture || capture.workspaceId !== event.workspaceId) return;
  if (
    capture.processingState !== "unprocessed" &&
    capture.processingState !== "classifying"
  )
    return;
  // Parked (ASH-305): set aside, so no new model call or proposal. Unpark re-queues this.
  if (capture.parkedAt) return;

  const token = crypto.randomUUID();
  const acquired = await db
    .update(captures)
    .set({
      enrichmentLeaseToken: token,
      enrichmentLeaseUntil: new Date(Date.now() + ENRICHMENT_LEASE_MS),
    })
    .where(
      and(
        eq(captures.id, captureId),
        eq(captures.workspaceId, event.workspaceId),
        inArray(captures.processingState, ["unprocessed", "classifying"]),
        sql`${captures.parkedAt} is null`,
        sql`(${captures.enrichmentLeaseUntil} is null or ${captures.enrichmentLeaseUntil} <= now())`,
      ),
    )
    .returning({ id: captures.id });
  if (acquired.length === 0) {
    const [now] = await db
      .select()
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1);
    if (
      !now ||
      (now.processingState !== "unprocessed" &&
        now.processingState !== "classifying") ||
      now.parkedAt
    )
      return;
    // Another run holds the lease: look again when it should be done. A park
    // counts no attempt, so a busy capture never dead-letters this event.
    const remaining =
      (now.enrichmentLeaseUntil?.getTime() ?? Date.now()) - Date.now();
    throw new OutboxParkError(
      Math.min(Math.max(remaining + 1000, 5000), ENRICHMENT_LEASE_MS),
      "capture is being enriched",
    );
  }

  try {
    await enrichLeased(event, deps, capture, token);
  } catch (cause) {
    if (cause instanceof EnrichmentLeaseLostError) return;
    // A failed attempt frees the claim so the redelivery isn't parked behind its own corpse.
    await db
      .update(captures)
      .set(RELEASE)
      .where(
        and(
          eq(captures.id, captureId),
          eq(captures.enrichmentLeaseToken, token),
        ),
      );
    throw cause;
  }
};

async function enrichLeased(
  event: ClaimedOutboxEvent,
  deps: CaptureEnrichmentDeps,
  capture: typeof captures.$inferSelect,
  token: string,
) {
  const captureId = capture.id;

  // Tier 0 + 1 run on whatever text exists: the paste itself, or the fetched
  // page for a URL capture.
  // Voice first (ASH-298): the transcript becomes the capture's text, then
  // the SAME ladder reads it - no parallel audio pipeline. Unconfigured is
  // honest: the capture keeps its audio, carries the reason, and this event
  // completes instead of redelivering against a missing key forever. A
  // provider ERROR stays redeliverable, like the other tiers.
  let textForLadder = capture.text ?? "";
  if (capture.kind === "voice" && !capture.text) {
    const transcript = await transcribeVoiceCapture(
      token,
      capture,
      event,
      deps.transcriber,
    );
    if (transcript === null) return;
    textForLadder = transcript;
  }

  const body = textForLadder;
  const { cleanText, structure } = classifyCapture(body);

  // The LLM tier reads prose only: a URL, code block, or contact block gains
  // nothing from a model naming it, and every skipped call is free.
  const wantsLlm =
    structure === "prose" && cleanText.length >= LLM_THRESHOLD_CHARS;

  const base = {
    cleanText: cleanText || null,
    structure,
    updatedAt: new Date(),
  };

  if (!wantsLlm) {
    await ownedUpdate(token, captureId, {
      ...base,
      processingState: "enriched",
      failureReason: null,
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

  // Tier 2 (ASH-272): the Jev classifier, when the registry enables it. The
  // registry entry ships disabled, so today this always falls through to the
  // generation prompt below with byte-identical behavior. A Jev request
  // error fails the event for redelivery; an unreadable answer degrades to a
  // low-confidence note proposal, never a crash and never a silent skip.
  const jev = await tryJevTriage(
    token,
    captureId,
    event.workspaceId,
    capture,
    base,
    cleanText,
    structure,
    deps.judger,
  );
  if (jev === "handled") return;

  let provider: ReturnType<typeof generationProvider>;
  try {
    provider = generationProvider(process.env);
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) {
      // No key, no model: keep the deterministic tiers' work, mark enriched.
      await ownedUpdate(token, captureId, {
        ...base,
        processingState: "enriched",
        failureReason: null,
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
    if (
      cause instanceof GenerationRequestError ||
      cause instanceof GenerationUnconfiguredError
    ) {
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
    failureReason: null,
    ...RELEASE,
  });
}

const noul = (answer: JevAnswer | undefined): number =>
  answer && answer.type === "noul" ? answer.noul : Number.NaN;

/**
 * One bundled Jev judgment pass over the capture. Returns "handled" when the
 * Jev path owns the outcome (proposal rows written, capture enriched),
 * "fallback" when the generation tier should run instead (Jev disabled or
 * unconfigured - the pre-ASH-272 behavior, unchanged).
 */
async function tryJevTriage(
  token: string,
  captureId: string,
  workspaceId: string,
  capture: { title: string | null; kind: string },
  base: { cleanText: string | null; structure: string; updatedAt: Date },
  cleanText: string,
  structure: string,
  injectedJudger?: ClassifyJudger,
): Promise<"handled" | "fallback"> {
  // Fast path: with no injected judger and the registry entry disabled (the
  // shipped default), fall through without touching the taxonomy table, so
  // the disabled-Jev path stays byte-identical to the pre-ASH-272 ladder.
  if (!injectedJudger && !providerEntry("jev")?.enabled) return "fallback";
  const judger = injectedJudger ?? jevClassifier(workspaceId);

  // The domain Choice's options come from the workspace's seeded taxonomy; an
  // unseeded workspace simply asks no domain question (domain stays null).
  const domains = await db
    .select({
      slug: taxonomyNodes.slug,
      description: taxonomyNodes.description,
    })
    .from(taxonomyNodes)
    .where(eq(taxonomyNodes.workspaceId, workspaceId));

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
    if (
      cause instanceof JevDisabledError ||
      cause instanceof JevUnconfiguredError
    )
      return "fallback";
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
    const path = await resolveTaxonomyPath(
      { workspaceId },
      { slugs: [triage.domainSlug] },
    );
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
        failureReason: unreadable ? "Jev returned an unreadable answer." : null,
        ...RELEASE,
      })
      .where(
        and(
          eq(captures.id, captureId),
          eq(captures.enrichmentLeaseToken, token),
        ),
      )
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
  return "handled";
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
  const [blob] = await db
    .select()
    .from(blobObjects)
    .where(eq(blobObjects.id, capture.blobId))
    .limit(1);
  if (!blob)
    throw new Error(
      `voice capture ${capture.id} points at missing blob ${capture.blobId}`,
    );
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
