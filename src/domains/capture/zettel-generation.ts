import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { submitGenerationJob } from "@/domains/jobs/commands";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";
import { extractDocument } from "@/domains/knowledge/extraction";
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
 * half: it picks the captures, takes the receipt, and accepts one generation
 * job per capture ("capture.zettelize") - all in the caller's transaction,
 * with no model call. The runner is the work half: file the capture as a
 * library document, read its text, and create the zettel cards directly. A
 * request never waits on a generation call; each capture's job shows its
 * progress in the jobs panel and fails, with a retry, on its own.
 *
 * Nothing here proposes. The triggering click is the permission, so the
 * runner writes the cards (the same authorship-is-acceptance pattern a chat
 * save uses) and no proposal row waits for a second decision. Dedupe stands
 * in for review: a second pass lands on the cards the first one made (same
 * span, same dedupe key), and a near-duplicate of an existing card is
 * skipped rather than minted. A candidate whose quote is not verbatim in the
 * capture's text is dropped rather than cited: the capture id is the
 * provenance on the audit row, never an invented quotation.
 */

export const ZETTELIZE_KIND = "capture.zettelize";

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

export type ZettelGenerationRequest = {
  /** Captures this request newly queued. */
  queued: number;
  /** Targets that were not eligible (no text, archived, already converted). */
  skipped: number;
  captureIds: string[];
  /** The jobs this request accepted, to start once it has committed. */
  started: Array<{ jobId: string; attempt: number }>;
  /** True when the key was seen before: the numbers are the first request's. */
  replayed: boolean;
};

const MAX_TITLE_CHARS = 60;

/** What the job's row says: the capture's own name, short. */
function zettelizeTitle(capture: { title: string | null }): string {
  const name = capture.title?.trim() || "a capture";
  return `Zettels: ${name.length > MAX_TITLE_CHARS ? `${name.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : name}`;
}

/**
 * Queue a generation pass. Idempotent on `idempotencyKey`: a replay returns the
 * first request's answer and accepts nothing. Each capture's job is the queue
 * record; the cards' own zettel.created rows are the activity trail. The
 * caller starts `started` (kickGenerationJob) after this returns.
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
        const started: Array<{ jobId: string; attempt: number }> = [];
        for (const row of rows) {
          const { job, created } = await submitGenerationJob(
            auth,
            {
              kind: ZETTELIZE_KIND,
              subject: `capture:${row.id}`,
              idempotencyKey: `zettelize:${input.idempotencyKey}:${row.id}`,
              title: zettelizeTitle(row),
              input: { captureId: row.id },
            },
            tx,
          );
          if (!created) continue;
          captureIds.push(row.id);
          started.push({ jobId: job.id, attempt: job.attempt });
        }
        const requested = ids?.length ?? rows.length;
        return {
          queued: captureIds.length,
          skipped: Math.max(0, requested - captureIds.length),
          captureIds,
          started,
        };
      },
    );
    return { ...value, replayed };
  });
}

export type ZettelizeDeps = {
  /** Test seam: a fake extractor keeps the pass free and deterministic. */
  extractor?: ZettelExtractor;
  /** Says which step the pass is on; the job runner passes run.progress. */
  progress?: (step: string) => Promise<void>;
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
 * repeat, or the model is not configured. A failed extraction throws, and the
 * job fails with a retry.
 */
export async function zettelizeCapture(
  auth: AuthContext,
  input: { captureId: string },
  deps: ZettelizeDeps = {},
): Promise<{ created: number; unreadChars: number }> {
  const captureId = input.captureId;
  const progress = deps.progress ?? (async () => {});
  const [capture] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, captureId), eq(captures.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!capture || capture.archivedAt || capture.parkedAt || capture.processingState === "discarded")
    return { created: 0, unreadChars: 0 };

  let documentId = capture.convertedType === "document" ? capture.convertedId : null;
  await progress("Filing the capture");
  if (!documentId) {
    if (capture.convertedType) return { created: 0, unreadChars: 0 };
    if (!zettelSourceText(capture)) return { created: 0, unreadChars: 0 };
    try {
      const filed = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
      documentId = filed.documentId;
    } catch (cause) {
      if (!(cause instanceof ConflictError) && !(cause instanceof StaleWriteError)) throw cause;
      const [again] = await db
        .select({ convertedType: captures.convertedType, convertedId: captures.convertedId, version: captures.version })
        .from(captures)
        .where(eq(captures.id, capture.id))
        .limit(1);
      if (again?.convertedType === "document") {
        documentId = again.convertedId;
      } else if (again && !again.convertedType && cause instanceof StaleWriteError) {
        const filed = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: again.version });
        documentId = filed.documentId;
      }
    }
  }
  if (!documentId) return { created: 0, unreadChars: 0 };

  await progress("Reading it");
  const extraction = await extractDocument(auth, { documentId });
  if (!extraction.ok) throw new Error(extraction.error);

  await progress("Writing zettels");
  let pass: ZettelCardsResult;
  try {
    pass = await createZettelsFromSource(auth, { documentId, extractor: deps.extractor });
  } catch (cause) {
    if (cause instanceof EmbeddingUnconfiguredError) return { created: 0, unreadChars: 0 };
    throw cause;
  }

  if (pass.created.length > 0) {
    await recordAudit(auth, {
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
    });
  }
  return { created: pass.created.length, unreadChars: pass.unreadChars };
}

const zettelizeInput = z.object({ captureId: z.uuid() });

/** The capture.zettelize job: one capture's pass, as its maker, with its steps on the job. */
export const zettelizeRunner =
  (deps: Pick<ZettelizeDeps, "extractor"> = {}): GenerationJobRunner =>
  async (auth, raw, run) => {
    const parsed = zettelizeInput.safeParse(raw);
    if (!parsed.success) throw new Error("malformed zettelize input");
    const { created } = await zettelizeCapture(auth, parsed.data, { ...deps, progress: (step) => run.progress(step) });
    return {
      href: "/polymath/ideas",
      notice: created > 0 ? `Made ${created} zettel${created === 1 ? "" : "s"}.` : "No new ideas were found in it.",
    };
  };
