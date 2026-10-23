import { and, eq, inArray, sql } from "drizzle-orm";
import { enqueueOutbox } from "@/domains/audit/outbox";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { createTask } from "@/domains/work/commands";
import { embedArtifact } from "@/domains/knowledge/embedding";
import { createNoteInTx, syncNoteLinks } from "@/domains/knowledge/notes";
import { withTransaction } from "@/lib/db-transaction";
import { findCaptureIdByUrl } from "./queries";
import { captures, captureSource } from "./schema";

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

export class ConflictError extends Error {
  readonly code = "conflict";
  /** Set when the conflict is a URL duplicate: the capture already in the inbox. */
  readonly existingId?: string;

  constructor(message: string, existingId?: string) {
    super(message);
    this.existingId = existingId;
  }
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
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
        // A URL capture promises the page's content. The scrape is long work,
        // so it parks in the outbox instead of holding the request open.
        if (capture.kind === "url" && capture.url) {
          await enqueueOutbox(tx, auth, {
            topic: CAPTURE_URL_CONTENT_TOPIC,
            payload: { captureId: capture.id, url: capture.url },
            dispatchKey: `capture-url-content:${capture.id}`,
          });
        }
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

    const sourceText = capture.text ?? capture.url ?? "Captured item";
    const title = input.title?.trim() || (sourceText.length > 120 ? `${sourceText.slice(0, 117)}…` : sourceText);
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
        if (!["unprocessed", "classifying"].includes(capture.processingState)) {
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
              inArray(captures.processingState, ["unprocessed", "classifying"]),
            ),
          )
          .returning();
        if (!updated) {
          throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
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
