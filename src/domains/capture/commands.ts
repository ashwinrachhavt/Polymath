import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { createTask } from "@/domains/work/commands";
import { withTransaction } from "@/lib/db-transaction";
import { captures, captureSource } from "./schema";

/*
 * Inbox commands (ASH-137 A02). Clarify-before-commit: conversion is a
 * decision the owner makes per capture, in one transaction - the canonical
 * task and the capture's lineage edge commit together or not at all. The
 * original text is never edited or deleted by these commands.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
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
        return capture;
      });
      return value;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("That URL is already in the inbox.");
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
