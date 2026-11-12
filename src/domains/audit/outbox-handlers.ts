import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { runExtractionPass } from "@/domains/knowledge/extraction";
import { EMBEDDING_RETRY_TOPIC, embeddingRetryRequestedHandler } from "@/domains/knowledge/embedding-retry";
import { FACT_SUGGESTION_TOPIC, factSuggestionRequestedHandler } from "@/domains/facts/generate";
import { GENERATION_JOB_TOPIC, generationJobRequestedHandler } from "@/domains/jobs/commands";
import { TIDY_PASS_TOPIC, tidyPassRequestedHandler } from "@/domains/knowledge/tidy";
import { RUN_CRITIQUE_TOPIC, runCritiqueRequestedHandler } from "@/domains/agents/critique";
import { MEMORY_DREAM_TOPIC, memoryDreamRequestedHandler } from "@/domains/agents/memory-dreaming";
import { THREAD_CHANGED_TOPIC, threadChangedHandler } from "@/domains/knowledge/thread-graph";
import { FOCUS_FOLLOW_UP_TOPIC, followUpRequestedHandler } from "@/domains/focus/follow-up";
import { urlContentRequestedHandler } from "@/domains/capture/url-content-handler";
import { CAPTURE_ENRICHMENT_TOPIC, CAPTURE_URL_CONTENT_TOPIC } from "@/domains/capture/commands";
import { captureEnrichmentRequestedHandler } from "@/domains/capture/enrichment-handler";
import { CAPTURE_ENRICH_TOPIC, captureEnrichRequestedHandler } from "@/domains/capture/enrich";
import { memberships } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import type { OutboxHandler } from "./outbox";

/*
 * Consumers for the outbox dispatcher (ASH-134 Q03). Intake queues
 * `document.extraction_requested` in the same transaction as the upload; this
 * is the first consumer that turns it into work. Delivery is at-least-once, so
 * the handler leans on extractDocument's own claim: a succeeded extraction for
 * the same content hash returns deduplicated instead of calling the provider.
 */

/** The actor for background work: the workspace's earliest active owner. Null when none exists. */
export async function workspaceOwnerAuth(workspaceId: string): Promise<AuthContext | null> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner"), eq(memberships.status, "active")),
    )
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row ? { userId: row.userId, workspaceId, role: "owner" } : null;
}

export const extractionRequestedHandler: OutboxHandler = async (event) => {
  const payload = event.payload as { documentId?: unknown } | null;
  const documentId = typeof payload?.documentId === "string" ? payload.documentId : null;
  // A malformed or fileless intent can never succeed; completing it avoids
  // five pointless retries before dead-lettering.
  if (!documentId) return;
  const auth = await workspaceOwnerAuth(event.workspaceId);
  if (!auth) throw new Error("workspace has no active owner to act for the extraction");
  // Read, then mirror - one pass, shared with the surfaces that just created
  // a document (see runExtractionPass). Redelivery dedupes the extraction.
  await runExtractionPass(auth, { documentId });
};

/*
 * Built on first use, not at module evaluation: handlers import
 * workspaceOwnerAuth from this file, and an eagerly built map would read their
 * bindings before they exist.
 */
let handlers: Record<string, OutboxHandler> | null = null;

export function outboxHandlers(): Record<string, OutboxHandler> {
  if (handlers) return handlers;
  handlers = {
    "document.extraction_requested": extractionRequestedHandler,
    [THREAD_CHANGED_TOPIC]: threadChangedHandler(workspaceOwnerAuth),
    [FOCUS_FOLLOW_UP_TOPIC]: followUpRequestedHandler(workspaceOwnerAuth),
    [CAPTURE_URL_CONTENT_TOPIC]: urlContentRequestedHandler,
    [CAPTURE_ENRICHMENT_TOPIC]: captureEnrichmentRequestedHandler,
    [CAPTURE_ENRICH_TOPIC]: captureEnrichRequestedHandler(workspaceOwnerAuth),
    [RUN_CRITIQUE_TOPIC]: runCritiqueRequestedHandler(workspaceOwnerAuth),
    [EMBEDDING_RETRY_TOPIC]: embeddingRetryRequestedHandler(workspaceOwnerAuth),
    [FACT_SUGGESTION_TOPIC]: factSuggestionRequestedHandler,
    [TIDY_PASS_TOPIC]: tidyPassRequestedHandler(workspaceOwnerAuth),
    [MEMORY_DREAM_TOPIC]: memoryDreamRequestedHandler(workspaceOwnerAuth),
    [GENERATION_JOB_TOPIC]: generationJobRequestedHandler,
  };
  return handlers;
}

/**
 * Topics that are written on purpose and consumed by nobody.
 *
 * Every one of these commits alongside an `recordAudit` carrying the same action,
 * so the audit row is the record and the outbox row exists so a future consumer can
 * subscribe without a backfill. Declaring them is the difference between a queue
 * where "pending" means work-in-flight and a queue where "pending" sometimes means
 * "never". Without this list the two are indistinguishable and the dispatcher keeps
 * retrying rows nobody will ever claim.
 *
 * Adding a topic here asserts that no consumer is required. That is a review
 * decision, not a convenience: if a security cache or a user-visible state depends
 * on the event, it needs a handler instead.
 */
export { AUDIT_ONLY_TOPICS } from "./outbox-topics";
