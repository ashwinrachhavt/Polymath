import { and, eq, inArray, sql } from "drizzle-orm";
import { enqueueOutbox } from "@/domains/audit/outbox";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { createTask } from "@/domains/work/commands";
import { embedArtifact } from "@/domains/knowledge/embedding";
import { createNoteInTx, syncNoteLinks } from "@/domains/knowledge/notes";
import { intakeFile } from "@/domains/knowledge/intake";
import { DRAFT_TEMPLATE_KIND, DRAFT_TEMPLATE_LABEL, draftBody, draftTitle, type DraftTemplate } from "./draft-templates";
import { proposeLinearIssue, renderLinearIssueDraft } from "./linear-issue-proposal";
import { withTransaction } from "@/lib/db-transaction";
import { db } from "@/lib/db";
import { findCaptureIdByUrl } from "./queries";
import { deleteBlob, ObjectStoreUnconfiguredError, putBlob } from "@/integrations/object-store/object-store";
import type { FileValidationResult } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";
import { blobObjects } from "../audit/schema";
import { captureProposals, captures, captureSource } from "./schema";

/*
 * Inbox commands (ASH-137 A02). Clarify-before-commit: conversion is a
 * decision the owner makes per capture, in one transaction - the canonical
 * task and the capture's lineage edge commit together or not at all.
 *
 * The original always lives in `captures.rawPayload`, which no command edits.
 * `captures.text` is the working body, editable until the capture converts;
 * after conversion the derived record owns the content, so a later edit would
 * silently desync it.
 */

/** Fired when a URL capture lands; the handler fills the capture's text. */
export const CAPTURE_URL_CONTENT_TOPIC = "capture.url_content_requested";
export const CAPTURE_ENRICHMENT_TOPIC = "capture.enrichment_requested";

export class ConflictError extends Error {
  readonly code = "conflict";
  /** Set when the conflict is a URL duplicate: the capture already in the inbox. */
  readonly existingId?: string;

  constructor(message: string, existingId?: string) {
    super(message);
    this.existingId = existingId;
  }
}

/** The object store refused the bytes before any row existed; the caller can retry, nothing was captured. */
export class StorageWriteFailedError extends Error {
  readonly code = "storage_write_failed";
  constructor(cause: unknown) {
    super("The file could not be stored. Nothing was captured - try again.");
    this.name = "StorageWriteFailedError";
    this.cause = cause;
  }
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

/** The row is gone (or never belonged to this workspace). */
export class NotFoundError extends Error {
  readonly code = "not_found";
}

function isUniqueViolation(cause: unknown): boolean {
  return (cause as { cause?: { code?: string } })?.cause?.code === "23505";
}

export async function createCapture(
  auth: AuthContext,
  input: {
    text: string;
    /**
     * A URL-only capture is the inbox's paste path; a page grab from the
     * companion carries the article text too, so the URL is provenance, not
     * the capture itself. Only url-only captures dedupe on URL.
     */
    url?: string;
    title?: string;
    source?: (typeof captureSource.enumValues)[number];
    idempotencyKey?: string;
  },
) {
  const trimmed = input.text.trim();
  if (!trimmed) throw new ConflictError("Nothing to capture.");
  const isUrl = !input.url && /^https?:\/\/\S+$/i.test(trimmed);
  const url = isUrl ? trimmed : (input.url?.trim() || null);
  try {
    return await withTransaction(async (tx) => {
      const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "createCapture", ...input }, async () => {
        const [capture] = await tx
          .insert(captures)
          .values({
            workspaceId: auth.workspaceId,
            kind: isUrl ? "url" : "text",
            source: input.source ?? "quick_capture",
            rawPayload: {
              ...(url ? { url } : {}),
              ...(isUrl ? {} : { text: trimmed }),
              ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            },
            text: isUrl ? null : trimmed,
            url,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning();
        await recordAudit(
          auth,
          { action: "capture.created", subjectType: "capture", subjectId: capture.id, summary: `Captured ${capture.kind}` },
          tx,
        );
        // A URL capture promises the page's content; a page grab from the
        // companion carries its own text, but that text is flattened innerText,
        // not markdown — the scrape replaces it with the page's real structure
        // once it lands (the grab survives in rawPayload). The scrape is long
        // work, so it parks in the outbox instead of holding the request open.
        if (capture.url) {
          await enqueueOutbox(tx, auth, {
            topic: CAPTURE_URL_CONTENT_TOPIC,
            payload: { captureId: capture.id, url: capture.url },
            dispatchKey: `capture-url-content:${capture.id}`,
          });
        }
        // Enrichment runs after URL content lands, so the ladder classifies
        // the fetched reading text, not just the address.
        await enqueueOutbox(tx, auth, {
          topic: CAPTURE_ENRICHMENT_TOPIC,
          payload: { captureId: capture.id },
          dispatchKey: `capture-enrichment:${capture.id}`,
          ...(capture.kind === "url" ? { availableAt: new Date(Date.now() + 30_000) } : {}),
        });
        return capture;
      });
      return value;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      // The only unique constraint a capture can hit is (workspace, source, url),
      // so point the caller at the row that is already there: told it exists
      // becomes a link to it. The API keeps its four-member 409 body byte-exact
      // (companion contract); the id rides along as an additive member.
      const existing = url
        ? await findCaptureIdByUrl(auth, { source: input.source ?? "quick_capture", url })
        : undefined;
      throw new ConflictError("That URL is already in the inbox.", existing);
    }
    throw cause;
  }
}

/**
 * File/screenshot capture (ASH-220): the `file` kind had a schema seat
 * (captures.blobId) but no writer. The bytes land in the object store FIRST;
 * the blob_objects row and the capture then commit in one transaction, so
 * there is never a capture pointing at bytes that failed to record, nor a
 * recorded blob without its capture. Retry safety belongs to the caller's
 * receipt (the route checks Idempotency-Key BEFORE calling this): a bare
 * retry without the key stores a second object, same as document intake.
 *
 * A sniff failure still captures - quarantined, never silently filed under
 * the client's claimed type: a preserved original beats a lost upload. A
 * quarantined capture carries rawPayload.quarantined and octet-stream, and
 * nothing downstream may promise its content (no extraction, no search text,
 * no preview) - the capture IS the file, its filename is the only label.
 * Verified files are likewise not extracted here: `text` stays null, so
 * search and semantic surfaces never imply the file's contents are readable.
 */
/** The receipt payload for a file capture - route pre-check and command receipt must hash this exact shape. */
export function fileCaptureReceiptRequest(contentHash: string, filename: string) {
  return { op: "createFileCapture", contentHash, filename };
}

export async function createFileCapture(
  auth: AuthContext,
  input: {
    bytes: Uint8Array;
    /** The uploader's filename - a label only, never trusted for type (validateFile already sniffed). */
    filename: string;
    /** From validateFile. A failed verdict quarantines the original rather than rejecting it. */
    verdict: FileValidationResult;
    /** sha256 hex of the bytes when the caller already has it. */
    contentHash?: string;
    source?: (typeof captureSource.enumValues)[number];
    /**
     * First-party idempotency key. The ROUTE checks the receipt before the
     * blob write (a replay must not store a second object); the receipt here
     * is the in-transaction backstop that serializes racing first attempts.
     */
    idempotencyKey?: string;
  },
): Promise<{ captureId: string; quarantined: boolean; contentHash: string }> {
  const filename = input.filename.trim().slice(0, 500);
  if (!filename) throw new ConflictError("Name the file.");
  const contentHash = input.contentHash ?? (await sha256Hex(input.bytes));
  const mimeType = input.verdict.ok ? input.verdict.mimeType : "application/octet-stream";
  // Network write outside the transaction: a storage failure throws before any
  // row exists, so the caller gets a clean error and nothing half-created.
  let stored: Awaited<ReturnType<typeof putBlob>>;
  try {
    stored = await putBlob({ bytes: input.bytes, filename, contentType: mimeType, workspaceId: auth.workspaceId, contentHash });
  } catch (cause) {
    // No rows exist yet; a storage fault is a clean, retryable failure, never
    // an ambiguous 500 that might have half-created something.
    if (cause instanceof ObjectStoreUnconfiguredError) throw cause;
    throw new StorageWriteFailedError(cause);
  }
  let lostRace = false;
  try {
    const result = await withTransaction(async (tx) => {
      const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, fileCaptureReceiptRequest(contentHash, filename), async () => {
    const blobRow =
      (await tx
        .insert(blobObjects)
        .values({
          workspaceId: auth.workspaceId,
          storageKey: stored.storageKey,
          contentHash,
          sizeBytes: input.bytes.byteLength,
          mimeType,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing({ target: blobObjects.storageKey })
        .returning({ id: blobObjects.id }))[0] ??
      (
        await tx
          .select({ id: blobObjects.id })
          .from(blobObjects)
          .where(eq(blobObjects.storageKey, stored.storageKey))
      )[0];
      if (!blobRow) throw new Error("blob row missing after insert");
      const [capture] = await tx
        .insert(captures)
        .values({
          workspaceId: auth.workspaceId,
          // Content decides the kind, same as the verdict decides the type: a
          // sniffed audio payload is a voice capture, everything else a file.
          kind: mimeType.startsWith("audio/") ? "voice" : "file",
          source: input.source ?? "quick_capture",
          rawPayload: {
            filename,
            mimeType,
            sizeBytes: input.bytes.byteLength,
            contentHash,
            ...(input.verdict.ok ? {} : { quarantined: true }),
          },
          text: null,
          blobId: blobRow.id,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "capture.created", subjectType: "capture", subjectId: capture.id, summary: `Captured file ${filename}` },
        tx,
      );
        // Audio is promised a transcript (ASH-298): the outbox carries the
        // wait, and the handler's unconfigured path answers honestly instead
        // of looping. Non-audio files have no text to classify - the capture
        // IS the file - so nothing else enqueues.
        if (capture.kind === "voice") {
          await enqueueOutbox(tx, auth, {
            topic: CAPTURE_ENRICHMENT_TOPIC,
            payload: { captureId: capture.id },
            dispatchKey: `capture-enrichment:${capture.id}`,
          });
        }
        return { captureId: capture.id, quarantined: !input.verdict.ok, contentHash };
      });
      lostRace = replayed;
      return value;
    });
    // Lost idempotency race: the response is the winner's, and the object this
    // run stored is referenced by nothing - remove it.
    if (lostRace) await deleteBlob(stored.storageKey).catch(() => {});
    return result;
  } catch (cause) {
    // The rows rolled back; the just-stored object is garbage. Best-effort
    // cleanup, then the original error - never a misleading success.
    await deleteBlob(stored.storageKey).catch(() => {});
    throw cause;
  }
}

/**
 * Turn a capture into a canonical task. The task row, the lineage edge
 * (convertedType/convertedId/convertedAt) and the audit row are one commit;
 * a stale version or an already-converted capture is a user-safe error, not
 * a second task.
 */
export async function convertCaptureToTask(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number; title?: string },
) {
  return withTransaction(async (tx) => {
    const [capture] = await tx
      .select()
      .from(captures)
      .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
      .limit(1);
    if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
    if (capture.processingState === "converted") {
      throw new ConflictError("That capture was already converted.");
    }
    if (capture.version !== input.expectedVersion) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }

    const sourceText =
      capture.text ??
      capture.url ??
      // A file capture's only label is its filename; its bytes are not text.
      ((capture.rawPayload as { filename?: string } | null)?.filename?.trim() || null) ??
      "Captured item";
    // The title is the first line; a multi-line capture keeps its full text
    // as the description, so nothing the owner wrote is lost or crammed into
    // the title.
    const firstLine = sourceText.split("\n").map((line) => line.trim()).find(Boolean) ?? sourceText;
    const title = input.title?.trim() || (firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine);
    const task = await createTask(
      auth,
      {
        title,
        description: capture.text && capture.text !== title ? capture.text : undefined,
      },
      tx,
    );

    const [updated] = await tx
      .update(captures)
      .set({
        processingState: "converted",
        convertedType: "task",
        convertedId: task.id,
        convertedAt: new Date(),
        version: sql`${captures.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(and(eq(captures.id, capture.id), eq(captures.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "capture.converted", subjectType: "capture", subjectId: capture.id, summary: `Capture became task: ${title}` },
      tx,
    );
    return { capture: updated, task };
  });
}

/**
 * Turn a capture into a notebook note (Capture and Notes spec, slice 1). The
 * note's first version is the capture text verbatim, wiki links resolve in
 * the same commit, and the capture's lineage edge (convertedType "note")
 * lands in the same transaction - a stale version or an already-converted
 * capture is a user-safe error, never a second note. The embedding refresh
 * follows the commit best-effort, like a checkpoint from the editor.
 */
export async function convertCaptureToNote(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number; title?: string },
) {
  const result = await withTransaction(async (tx) => {
    const [capture] = await tx
      .select()
      .from(captures)
      .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
      .limit(1);
    if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
    if (capture.processingState === "converted") {
      throw new ConflictError("That capture was already converted.");
    }
    if (capture.version !== input.expectedVersion) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }

    const body = capture.text ?? (capture.url ? `[${capture.url}](${capture.url})` : "Captured item");
    const firstLine = (capture.text ?? capture.url ?? "Captured item").split("\n").map((line) => line.trim()).find(Boolean) ?? "Captured item";
    const title = input.title?.trim() || (firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine);
    const note = await createNoteInTx(tx, auth, { title, content: { format: "markdown", text: body }, plainText: body });
    await syncNoteLinks(tx, auth, note.id, body);

    const [updated] = await tx
      .update(captures)
      .set({
        processingState: "converted",
        convertedType: "note",
        convertedId: note.id,
        convertedAt: new Date(),
        version: sql`${captures.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(and(eq(captures.id, capture.id), eq(captures.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "capture.converted", subjectType: "capture", subjectId: capture.id, summary: `Capture became note: ${title}` },
      tx,
    );
    return { capture: updated, note };
  });
  try {
    await embedArtifact(auth, { artifactId: result.note.id });
  } catch (cause) {
    console.error(`embedArtifact after capture conversion failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return result;
}

/**
 * Turn a text capture into a library document (Capture spec: the inbox owns
 * the triggers that create zettels from captured knowledge). The capture's
 * cleaned text becomes the document's markdown bytes through the one intake
 * path, so extraction and the enrichment pipeline (embed, zettel proposals,
 * link) follow from the extraction event intake writes - no capture-specific
 * pipeline. The capture's lineage edge (convertedType "document") and the
 * audit row ride inside intake's transaction: a stale version or an
 * already-converted capture rolls the whole intake back, never a second
 * document.
 */
export async function convertCaptureToDocument(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number; title?: string },
) {
  const [capture] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
    .limit(1);
  if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
  if (capture.processingState === "converted") {
    throw new ConflictError("That capture was already converted.");
  }
  if (capture.version !== input.expectedVersion) {
    throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
  }

  // The enriched text is the document when the ladder produced it; the raw
  // paste otherwise. Only text carries in - a file capture's bytes are
  // already stored under their own filename.
  const body = (capture.cleanText ?? capture.text ?? "").trim();
  if (!body) throw new ConflictError("That capture has no text to file.");
  const firstLine = body.split("\n").map((line) => line.trim()).find(Boolean) ?? "Captured text";
  const title = input.title?.trim() || capture.title?.trim() || (firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine);

  const result = await intakeFile(auth, {
    bytes: new TextEncoder().encode(body),
    filename: `${title}.md`,
    title,
    verdict: { ok: true, mimeType: "text/markdown" },
    origin: "capture",
    inTransaction: async (tx, { documentId }) => {
      const [updated] = await tx
        .update(captures)
        .set({
          processingState: "converted",
          convertedType: "document",
          convertedId: documentId,
          convertedAt: new Date(),
          version: sql`${captures.version} + 1`,
          updatedAt: new Date(),
          updatedBy: auth.userId,
        })
        .where(and(eq(captures.id, capture.id), eq(captures.version, input.expectedVersion)))
        .returning();
      if (!updated) {
        throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
      }
      await recordAudit(
        auth,
        { action: "capture.converted", subjectType: "capture", subjectId: capture.id, summary: `Capture became document: ${title}` },
        tx,
      );
    },
  });
  return { documentId: result.documentId, fileId: result.fileId };
}

/**
 * Turn a capture into a starter draft in a picked writing template ("turn it
 * into anything" - the Omnibox inbox row of the Product Spec). Same guards as
 * convertCaptureToNote: tenant-scoped, unconverted, version-checked, one
 * transaction. The template is a deterministic scaffold with the capture
 * quoted verbatim as source material - the system invents no prose. The
 * template value itself is validated at the action boundary (zod enum).
 */
export async function convertCaptureToDraft(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number; template: DraftTemplate },
) {
  const result = await withTransaction(async (tx) => {
    const [capture] = await tx
      .select()
      .from(captures)
      .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
      .limit(1);
    if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
    if (capture.processingState === "converted") {
      throw new ConflictError("That capture was already converted.");
    }
    if (capture.version !== input.expectedVersion) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }

    const material = capture.text ?? (capture.url ? capture.url : "Captured item");
    const firstLine = material.split("\n").map((line) => line.trim()).find(Boolean) ?? "Captured item";
    let title = draftTitle(input.template, firstLine);
    let body = draftBody(input.template, { firstLine, material });
    if (input.template === "linear-issue") {
      // ASH-285 part 2: with a generation provider configured, fill the
      // scaffold into a fully formed proposal grounded in the capture. Any
      // failure keeps the honest deterministic scaffold - never fake content.
      try {
        const { proposal, proposer } = await proposeLinearIssue(auth, { title: firstLine, text: material });
        title = `Linear issue: ${proposal.title}`;
        body = renderLinearIssueDraft(proposal, { sourceMaterial: material, proposer });
      } catch {
        /* scaffold stands */
      }
    }
    const draft = await createNoteInTx(tx, auth, {
      title,
      content: { format: "markdown", text: body },
      plainText: body,
      kind: DRAFT_TEMPLATE_KIND[input.template],
    });
    await syncNoteLinks(tx, auth, draft.id, body);

    const [updated] = await tx
      .update(captures)
      .set({
        processingState: "converted",
        convertedType: `draft:${input.template}`,
        convertedId: draft.id,
        convertedAt: new Date(),
        version: sql`${captures.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(and(eq(captures.id, capture.id), eq(captures.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "capture.converted", subjectType: "capture", subjectId: capture.id, summary: `Capture became ${DRAFT_TEMPLATE_LABEL[input.template].toLowerCase()}: ${title}` },
      tx,
    );
    return { capture: updated, draft };
  });
  try {
    await embedArtifact(auth, { artifactId: result.draft.id });
  } catch (cause) {
    console.error(`embedArtifact after capture conversion failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return result;
}

/**
 * Edit the working body of an open capture. `rawPayload` keeps the original
 * exactly as it arrived, so this changes what the person is clarifying, never
 * what was captured. Only an unprocessed or classifying capture may be edited:
 * a converted capture's text already became a task or note, and editing it
 * here would silently desync that record. Version-checked and idempotent like
 * every other write.
 */
export async function updateCaptureText(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number; text: string; idempotencyKey?: string },
) {
  const text = input.text.trim();
  if (!text) throw new ConflictError("A capture cannot be emptied. Archive it instead.");

  return withTransaction(async (tx) => {
    const { value } = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "updateCaptureText", captureId: input.captureId, expectedVersion: input.expectedVersion, text },
      async () => {
        const [capture] = await tx
          .select()
          .from(captures)
          .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
          .limit(1);
        if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
        if (capture.processingState === "converted") {
          throw new ConflictError("This capture was already converted. Editing it here would desync the record it became.");
        }
        // An enriched capture is still the owner's working text: only the
        // conversion boundary (above) closes editing. Editing an enriched
        // capture re-opens it and re-queues the ladder below, so the
        // classification the owner sees always read the words on screen.
        if (!["unprocessed", "classifying", "enriched"].includes(capture.processingState)) {
          throw new ConflictError("This capture is no longer open for editing. Reload the inbox.");
        }
        if (capture.version !== input.expectedVersion) {
          throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
        }

        const [updated] = await tx
          .update(captures)
          .set({
            text,
            version: sql`${captures.version} + 1`,
            updatedAt: new Date(),
            updatedBy: auth.userId,
          })
          .where(
            and(
              eq(captures.workspaceId, auth.workspaceId),
              eq(captures.id, capture.id),
              eq(captures.version, input.expectedVersion),
              inArray(captures.processingState, ["unprocessed", "classifying", "enriched"]),
            ),
          )
          .returning();
        if (!updated) {
          throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
        }
        // The words the classification read just changed: re-open the capture
        // and re-queue the ladder. Voice is safe - the transcription tier
        // only fills an empty text, so a corrected transcript is never
        // re-transcribed over the owner's words.
        if (capture.processingState === "enriched") {
          await tx
            .update(captures)
            .set({ processingState: "unprocessed", updatedAt: new Date(), updatedBy: auth.userId })
            .where(eq(captures.id, capture.id));
          await enqueueOutbox(tx, auth, {
            topic: CAPTURE_ENRICHMENT_TOPIC,
            payload: { captureId: capture.id },
            // A repeated dispatchKey enqueues nothing, so each edit re-queues
            // under the version it created.
            dispatchKey: `capture-enrichment:${capture.id}:edit-v${capture.version + 1}`,
          });
        }
        await recordAudit(
          auth,
          { action: "capture.edited", subjectType: "capture", subjectId: updated.id, summary: "Capture text edited" },
          tx,
        );
        return updated;
      },
    );
    return value;
  });
}

/** Archive (discard) or restore a capture. Version-checked like every write. */
export async function setCaptureState(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number; state: "discarded" | "unprocessed" },
) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(captures)
      .set({
        processingState: input.state,
        version: sql`${captures.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(captures.workspaceId, auth.workspaceId),
          eq(captures.id, input.captureId),
          eq(captures.version, input.expectedVersion),
          // Archive only what is still open; restore only what is archived. A
          // converted capture's lineage edge is never flipped back by hand.
          input.state === "discarded"
            ? inArray(captures.processingState, ["unprocessed", "classifying", "enriched", "failed"])
            : eq(captures.processingState, "discarded"),
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      {
        action: input.state === "discarded" ? "capture.archived" : "capture.restored",
        subjectType: "capture",
        subjectId: updated.id,
        summary: input.state === "discarded" ? "Capture archived" : "Capture restored to the inbox",
      },
      tx,
    );
    return updated;
  });
}

/* --- Classification proposal decisions (ASH-314) --- */

export type AcceptedProposal = {
  kind: (typeof captureProposals.$inferSelect)["kind"];
  /** What the accept produced; the UI links to it. Null for a discard. */
  resultType: "task" | "note" | "discard";
  resultId: string | null;
};

async function loadPendingProposal(auth: AuthContext, proposalId: string) {
  const [proposal] = await db
    .select()
    .from(captureProposals)
    .where(and(eq(captureProposals.workspaceId, auth.workspaceId), eq(captureProposals.id, proposalId)))
    .limit(1);
  if (!proposal) throw new NotFoundError("That suggestion no longer exists. Reload the inbox.");
  if (proposal.status !== "pending") throw new ConflictError("That suggestion was already decided.");
  return proposal;
}

/*
 * The owner confirms the system's read: the proposal's kind drives the same
 * conversion the manual buttons run, then the proposal records what it made.
 * The conversion is the guarded write (stale version, already-converted);
 * the decision stamp follows it, claimed on still-pending so a raced second
 * accept can never double-record.
 *
 * Contact proposals carry no fields to create a record from yet - the CRM
 * workflow (ASH-287) owns them - so accepting one is refused here and never
 * offered in the UI.
 */
export async function acceptCaptureProposal(auth: AuthContext, input: { proposalId: string }): Promise<AcceptedProposal> {
  const proposal = await loadPendingProposal(auth, input.proposalId);
  if (proposal.kind === "contact") {
    throw new ConflictError("A contact starts from the CRM page - the suggestion only flags it.");
  }

  const [capture] = await db
    .select({ id: captures.id, version: captures.version })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, proposal.captureId)))
    .limit(1);
  if (!capture) throw new NotFoundError("That capture no longer exists. Reload the inbox.");

  let resultType: AcceptedProposal["resultType"];
  let resultId: string | null;
  if (proposal.kind === "task") {
    const { task } = await convertCaptureToTask(auth, { captureId: capture.id, expectedVersion: capture.version });
    resultType = "task";
    resultId = task.id;
  } else if (proposal.kind === "note") {
    const { note } = await convertCaptureToNote(auth, { captureId: capture.id, expectedVersion: capture.version });
    resultType = "note";
    resultId = note.id;
  } else if (proposal.kind === "discard") {
    await setCaptureState(auth, { captureId: capture.id, expectedVersion: capture.version, state: "discarded" });
    resultType = "discard";
    resultId = null;
  } else {
    // project / company / opportunity / reference / event: kinds the enum
    // admits but no conversion path exists for. Never fake one.
    throw new ConflictError(`Turning a capture into a ${proposal.kind} is not built yet.`);
  }

  const [decided] = await db
    .update(captureProposals)
    .set({
      status: "accepted",
      decidedAt: new Date(),
      decidedBy: auth.userId,
      resultType,
      resultId,
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(captureProposals.workspaceId, auth.workspaceId),
        eq(captureProposals.id, proposal.id),
        eq(captureProposals.status, "pending"),
      ),
    )
    .returning({ id: captureProposals.id });
  if (!decided) throw new ConflictError("That suggestion was already decided.");

  await recordAudit(auth, {
    action: "capture.proposal_accepted",
    subjectType: "capture",
    subjectId: capture.id,
    summary: `Accepted ${proposal.kind} suggestion${resultType === "discard" ? "" : `; became ${resultType}`}`,
  });
  return { kind: proposal.kind, resultType, resultId };
}

/** The owner overrules the system's read. The capture itself is untouched. */
export async function rejectCaptureProposal(auth: AuthContext, input: { proposalId: string }): Promise<void> {
  const proposal = await loadPendingProposal(auth, input.proposalId);
  const [decided] = await db
    .update(captureProposals)
    .set({ status: "rejected", decidedAt: new Date(), decidedBy: auth.userId, updatedBy: auth.userId })
    .where(
      and(
        eq(captureProposals.workspaceId, auth.workspaceId),
        eq(captureProposals.id, proposal.id),
        eq(captureProposals.status, "pending"),
      ),
    )
    .returning({ id: captureProposals.id });
  if (!decided) throw new ConflictError("That suggestion was already decided.");
  await recordAudit(auth, {
    action: "capture.proposal_rejected",
    subjectType: "capture",
    subjectId: proposal.captureId,
    summary: `Rejected ${proposal.kind} suggestion`,
  });
}
