"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ConflictError, convertCaptureToNote, createCapture, setCaptureState, StaleWriteError } from "@/domains/capture/commands";
import { archiveDocument, DocumentLifecycleError } from "@/domains/knowledge/documents";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The capture inbox's mutations over the shared capture domain (ASH-137
 * A02). Capture writes and returns - classification never blocks. Accept and
 * edit both convert the capture into a notebook note in one transaction;
 * discard archives it. Every write is version-checked at the row, so a
 * double submit or a stale page throws instead of deciding twice.
 */

const uuid = z.string().uuid();

const revalidate = () => revalidatePath("/alfred/inbox");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export type CaptureActionResult = { ok: true; message: string; noteId?: string } | { ok: false; message: string };

function failure(cause: unknown): CaptureActionResult {
  if (cause instanceof StaleWriteError || cause instanceof ConflictError || cause instanceof DocumentLifecycleError) return { ok: false, message: cause.message };
  throw cause;
}

export async function captureTextAction(raw: { text: string; idempotencyKey: string }): Promise<CaptureActionResult> {
  const auth = await authorize();
  const input = z.object({ text: z.string().min(1).max(20000), idempotencyKey: uuid }).parse(raw);
  try {
    await createCapture(auth, input);
  } catch (cause) {
    return failure(cause);
  }
  revalidate();
  return { ok: true, message: "Captured to the inbox." };
}

export async function acceptCaptureAction(raw: { captureId: string; expectedVersion: number }): Promise<CaptureActionResult> {
  const auth = await authorize();
  const input = z.object({ captureId: uuid, expectedVersion: z.number().int().min(1) }).parse(raw);
  try {
    const { note } = await convertCaptureToNote(auth, input);
    revalidate();
    revalidatePath("/alfred/notebook");
    return { ok: true, message: "Accepted. It is in your notebook now.", noteId: note.id };
  } catch (cause) {
    return failure(cause);
  }
}

export async function discardCaptureAction(raw: { captureId: string; expectedVersion: number }): Promise<CaptureActionResult> {
  const auth = await authorize();
  const input = z.object({ captureId: uuid, expectedVersion: z.number().int().min(1) }).parse(raw);
  try {
    await setCaptureState(auth, { ...input, state: "discarded" });
  } catch (cause) {
    return failure(cause);
  }
  revalidate();
  return { ok: true, message: "Discarded." };
}

export async function discardDocumentAction(raw: { documentId: string; expectedVersion: number }): Promise<CaptureActionResult> {
  const auth = await authorize();
  const input = z.object({ documentId: uuid, expectedVersion: z.number().int().min(1) }).parse(raw);
  try {
    await archiveDocument(auth, input);
  } catch (cause) {
    return failure(cause);
  }
  revalidate();
  return { ok: true, message: "Discarded." };
}
