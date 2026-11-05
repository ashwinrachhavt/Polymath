import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { enqueueOutbox, type ClaimedOutboxEvent } from "@/domains/audit/outbox";
import { outboxEvents } from "@/domains/audit/schema";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";
import { extractDocument } from "@/domains/knowledge/extraction";
import { embedArtifact } from "@/domains/knowledge/embedding";
import { createZettelsFromSource, type ZettelCardsResult } from "@/domains/knowledge/zettels";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { ConflictError, StaleWriteError, convertCaptureToDocument } from "./commands";
import { captures } from "./schema";

/*
 * "Generate zettels" from the inbox: one control over the open captures that
 * carry text, so a morning's reading becomes idea cards without opening each
 * capture.
 *
 * Two halves, deliberately split. `requestZettelGeneration` is the request
 * half: it picks the captures, takes the receipt, and enqueues one outbox row
 * per capture - all in the caller's transaction, with no model call. The
 * handler is the work half: file the capture as a library document, read its
 * text, and create the zettel cards directly. A request never waits on a
 * generation call, and the queue, not the click, carries the retries.
 *
 * Nothing here proposes. The triggering click is the permission, so the
 * handler writes the cards (the same authorship-is-acceptance pattern a chat
 * save uses) and no proposal row waits for a second decision. Dedupe stands
 * in for review: a second pass lands on the cards the first one made (same
 * span, same dedupe key), and a near-duplicate of an existing card is
 * skipped rather than minted. A candidate whose quote is not verbatim in the
 * capture's text is dropped rather than cited: the capture id is the
 * provenance on the audit row, never an invented quotation.
 */

export const ZETTEL_GENERATION_TOPIC = "capture.zettels_requested";

/** One request is bounded: a whole inbox is many model calls, and the queue is not a batch API. */
export const MAX_ZETTEL_SOURCE_CAPTURES = 50;

/** The states an open capture can hold. Converted and archived rows are not sources. */
const OPEN_STATES = sql`${captures.processingState} in ('unprocessed', 'classifying', 'enriched', 'failed')`;

/**
 * The text a capture offers a model: enrichment's cleaned copy when it produced
 * one, the pasted body otherwise. Null for a file or an unfetched link - those
 * have no body, and the pass must skip rather than propose from a filename.
 * `zettelSourceWhere` expresses this same rule in SQL; keep the two in step.
 */
function zettelSourceText(capture: { cleanText: string | null; text: string | null }): string | null {
  return capture.cleanText?.trim() || capture.text?.trim() || null;
}

/**
 * The open captures a generation pass may read, tenant-scoped. `ids` narrows to
 * an explicit selection; without it the newest open captures are taken, bounded
 * by MAX_ZETTEL_SOURCE_CAPTURES.
 */
function zettelSourceWhere(auth: AuthContext, ids?: string[]) {
  // Same rule as zettelSourceText: the first of cleanText/text that is not blank.
  const hasText = sql`coalesce(nullif(trim(${captures.cleanText}), ''), nullif(trim(${captures.text}), '')) is not null`;
  const parts: SQL[] = [
    eq(captures.workspaceId, auth.workspaceId),
    OPEN_STATES,
    isNull(captures.archivedAt),
    isNull(captures.parkedAt),
    hasText,
  ];
  if (ids?.length) parts.push(inArray(captures.id, ids));
  return and(...parts);
}

export async function listZettelSourceCaptures(auth: AuthContext, input: { ids?: string[] } = {}) {
  return db
    .select({
      id: captures.id,
      version: captures.version,
      title: captures.title,
      processingState: captures.processingState,
    })
    .from(captures)
    .where(zettelSourceWhere(auth, input.ids))
    .orderBy(sql`${captures.createdAt} desc`)
    .limit(MAX_ZETTEL_SOURCE_CAPTURES);
}

/** The row count the inbox uses to enable or disable the control. Cheap: one indexed count. */
export async function countZettelSourceCaptures(auth: AuthContext, input: { ids?: string[] } = {}): Promise<number> {
  const [row] = await db.select({ n: count() }).from(captures).where(zettelSourceWhere(auth, input.ids));
  return row?.n ?? 0;
}

/** Count outbox rows that have not settled yet: the pending zettelize passes. */
export async function countQueuedZettelPasses(auth: AuthContext): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, auth.workspaceId),
        eq(outboxEvents.topic, ZETTEL_GENERATION_TOPIC),
        // The queue is the pending rows, not the table (the partial index's
        // own rule): dispatched rows have landed, failed rows retry.
        eq(outboxEvents.status, "pending"),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The status vocabulary a watching zettelize verb speaks, derived from the
 * count that already exists: no new table, no new state machine. Working
 * counts the outbox rows still owed; done covers the rest - the cards are in
 * the library. The watch never reports failure here: a queue-wide status read
 * with zero owed rows is simply caught up.
 */
export function zettelQueuePhase(input: { queuedPasses: number }): "working" | "done" {
  return input.queuedPasses > 0 ? "working" : "done";
}

export function zettelQueueLabel(input: { queuedPasses: number }): string {
  return input.queuedPasses > 0 ? "Creating zettels…" : "The ideas queue is clear.";
}

export type ZettelGenerationRequest = {
  /** Captures this request newly queued. */
  queued: number;
  /** Targets that were not eligible (no text, archived, already converted). */
  skipped: number;
  captureIds: string[];
  /** True when the key was seen before: the numbers are the first request's. */
  replayed: boolean;
};

/**
 * Queue a generation pass. Idempotent on `idempotencyKey`: a replay returns the
 * first request's answer and enqueues nothing. The outbox row is the queue
 * record; the cards' own zettel.created rows are the activity trail.
 */
export async function requestZettelGeneration(
  auth: AuthContext,
  input: { captureIds?: string[]; idempotencyKey: string },
): Promise<ZettelGenerationRequest> {
  const ids = input.captureIds?.length ? [...new Set(input.captureIds)] : undefined;
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "generateZettels", captureIds: ids ?? "all" },
      async () => {
        const rows = await listZettelSourceCaptures(auth, { ids });
        const captureIds: string[] = [];
        for (const row of rows) {
          const queued = await enqueueOutbox(tx, auth, {
            topic: ZETTEL_GENERATION_TOPIC,
            payload: { captureId: row.id },
            dispatchKey: `zettel-generation:${input.idempotencyKey}:${row.id}`,
          });
          if (!queued.enqueued) continue;
          captureIds.push(row.id);
        }
        const requested = ids?.length ?? rows.length;
        return { queued: captureIds.length, skipped: Math.max(0, requested - captureIds.length), captureIds };
      },
    );
    return { ...value, replayed };
  });
}

export type ZettelGenerationDeps = {
  /**
   * The actor for background work. The dispatcher runs outside a request, so
   * the handler is registered with workspaceOwnerAuth rather than carrying a
   * context of its own.
   */
  auth?: (workspaceId: string) => Promise<AuthContext | null>;
  /** Test seam: a fake extractor keeps the pass free and deterministic. */
  extractor?: ZettelExtractor;
};

/**
 * The work half: one capture in, cards out. A capture that already became
 * a task, note, or draft keeps that home - the owner chose it, and filing a
 * second document would be a silent duplicate. A capture that never became a
 * document is filed through the one intake path, so its text, extraction,
 * lineage edge, and audit row are the ordinary ones.
 *
 * Returns how many cards this pass created. Zero is a normal answer: the
 * capture offered no text to read, it made no claims, every candidate was a
 * repeat, or the model is not configured. A malformed event or a failed
 * extraction throws, so the dispatcher retries with backoff instead of
 * losing the request.
 */
export async function runZettelGenerationRequested(
  event: ClaimedOutboxEvent,
  deps: ZettelGenerationDeps = {},
): Promise<{ created: number; unreadChars: number }> {
  const raw = event.payload ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${ZETTEL_GENERATION_TOPIC} has a malformed payload (${typeof raw}); redeploy the producer`);
  }
  const captureId =
    typeof (raw as { captureId?: unknown }).captureId === "string" ? (raw as { captureId: string }).captureId : null;
  if (!captureId) throw new Error(`${ZETTEL_GENERATION_TOPIC} is missing captureId`);
  if (!deps.auth) throw new Error(`${ZETTEL_GENERATION_TOPIC} has no actor resolver`);

  const auth = await deps.auth(event.workspaceId);
  if (!auth) throw new Error("workspace has no active owner to act for the zettel pass");

  const [capture] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, captureId), eq(captures.workspaceId, event.workspaceId)))
    .limit(1);
  if (!capture || capture.archivedAt || capture.parkedAt || capture.processingState === "discarded")
    return { created: 0, unreadChars: 0 };

  let documentId = capture.convertedType === "document" ? capture.convertedId : null;
  if (!documentId) {
    // Converted to something the owner chose is a decision, not a failure.
    if (capture.convertedType) return { created: 0, unreadChars: 0 };
    if (!zettelSourceText(capture)) return { created: 0, unreadChars: 0 };
    try {
      const filed = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
      documentId = filed.documentId;
    } catch (cause) {
      if (!(cause instanceof ConflictError) && !(cause instanceof StaleWriteError)) throw cause;
      // A racing conversion or an edit won: re-read the row rather than retry
      // blind against a version that no longer exists.
      const [again] = await db
        .select({ convertedType: captures.convertedType, convertedId: captures.convertedId, version: captures.version })
        .from(captures)
        .where(eq(captures.id, capture.id))
        .limit(1);
      if (again?.convertedType === "document") {
        documentId = again.convertedId;
      } else if (again && !again.convertedType && cause instanceof StaleWriteError) {
        // The text changed under us; one retry against the new version is
        // honest - the owner's edit is what should be read.
        const filed = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: again.version });
        documentId = filed.documentId;
      }
    }
  }
  if (!documentId) return { created: 0, unreadChars: 0 };

  const extraction = await extractDocument(auth, { documentId });
  if (!extraction.ok) throw new Error(extraction.error);

  /*
   * The pass and its audit are one transaction, so the audit row commits with
   * the cards it describes and two racing passes cannot both see zero.
   */
  const outcome = await withTransaction(async (tx): Promise<{ created: number; unreadChars: number; cards: ZettelCardsResult["created"] }> => {
    let pass: ZettelCardsResult;
    try {
      pass = await createZettelsFromSource(auth, { documentId, extractor: deps.extractor, tx });
    } catch (cause) {
      // No model configured is a skip, not a failure: retrying five times cannot
      // conjure a key, and the inbox disables the control in that state anyway.
      if (cause instanceof EmbeddingUnconfiguredError) return { created: 0, unreadChars: 0, cards: [] };
      throw cause;
    }

    if (pass.created.length > 0) {
      await recordAudit(
        auth,
        {
          action: "capture.zettels_created",
          subjectType: "capture",
          subjectId: capture.id,
          summary: `Created ${pass.created.length} zettel${pass.created.length === 1 ? "" : "s"}`,
          metadata: {
            documentId,
            readChars: pass.readChars,
            unreadChars: pass.unreadChars,
            unreadSections: pass.unreadSections,
            skippedRepeats: pass.skippedRepeats,
            skippedDuplicates: pass.skippedDuplicates,
            skippedSpans: pass.skippedSpans,
          },
        },
        tx,
      );
    }
    return { created: pass.created.length, unreadChars: pass.unreadChars, cards: pass.created };
  });
  // Whoever owns the commit owns the embeds: the new cards join the semantic
  // graph best-effort after the transaction lands, and a failed or
  // unconfigured embedding pass never blocks the cards themselves.
  for (const card of outcome.cards) {
    try {
      await embedArtifact(auth, { artifactId: card.artifactId });
    } catch (cause) {
      console.error(
        `embedArtifact after zettel creation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return { created: outcome.created, unreadChars: outcome.unreadChars };
}
