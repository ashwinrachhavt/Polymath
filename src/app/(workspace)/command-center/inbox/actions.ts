"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { DRAFT_TEMPLATES, type DraftTemplate } from "@/domains/capture/draft-templates";
import {
  ConflictError,
  NotFoundError,
  StaleWriteError,
  convertCaptureToDocument,
  convertCaptureToDraft,
  convertCaptureToNote,
  convertCaptureToTask,
  createCapture,
  retryCaptureUrl,
  setCaptureState,
  updateCaptureText,
} from "@/domains/capture/commands";
import { readCaptureEnrichment, requestCaptureEnrich } from "@/domains/capture/enrich";
import { ENRICH_PENDING_LABEL } from "@/domains/capture/enrich-state";
import { CAPTURE_KINDS, setCaptureKind, type CaptureKind } from "@/domains/capture/kind-label";
import { unparkCapture } from "@/domains/capture/parking";
import { getAuthContext } from "@/lib/auth";
import { capturesTag, tasksTag } from "@/lib/cache-tags";
import { requireRole } from "@/lib/auth/guards";
import type { WorkState } from "@/components/work-status";
import type { Result } from "@/lib/result";

/* Inbox actions (A02). Every write carries the version the caller rendered. */

const revalidate = (auth: Awaited<ReturnType<typeof authorize>>) => {
  updateTag(capturesTag(auth));
  revalidatePath("/command-center/inbox");
};

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "The inbox write failed." };
}

export async function captureTextAction(input: {
  text: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string; existingId?: string }> {
  const auth = await authorize();
  let capture: { id: string };
  try {
    capture = await createCapture(auth, input);
  } catch (error) {
    // A duplicate already names the capture it collided with; pass the id so
    // the notice can open it.
    if (error instanceof ConflictError) return { ok: false, error: error.message, existingId: error.existingId };
    return fail(error);
  }
  revalidate(auth);
  return { ok: true, id: capture.id };
}

export async function makeTaskAction(input: { captureId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await convertCaptureToTask(auth, input);
  } catch (error) {
    return fail(error);
  }
  updateTag(tasksTag(auth));
  revalidate(auth);
  return { ok: true };
}

const makeDraftInput = z.object({
  captureId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  template: z.enum(DRAFT_TEMPLATES),
});

/** Turn a capture into a starter draft (email / product spec / tech spec) - one transaction, same guards as note conversion. */
export async function makeDraftAction(input: {
  captureId: string;
  expectedVersion: number;
  template: DraftTemplate;
}): Promise<Result> {
  const auth = await authorize();
  const parsed = makeDraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That draft request was malformed. Reload and try again." };
  try {
    await convertCaptureToDraft(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidatePath("/polymath/notes");
  revalidate(auth);
  return { ok: true };
}

/** Accept a capture into the notebook: the note is created in the same transaction, links resolved. */
export async function makeDocumentAction(input: { captureId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await convertCaptureToDocument(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidatePath("/polymath/knowledge");
  revalidate(auth);
  return { ok: true };
}

export async function makeNoteAction(input: { captureId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await convertCaptureToNote(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidatePath("/polymath/notes");
  revalidate(auth);
  return { ok: true };
}

const updateTextInput = z.object({
  captureId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  text: z.string().trim().min(1),
  idempotencyKey: z.string().uuid().optional(),
});

/**
 * Edit the working body of an open capture. The immutable original stays in
 * rawPayload, so this is an honest edit rather than a rewrite of history. A
 * stale version or a converted capture comes back as the message the editor
 * shows inline; the caller's draft is never lost to it.
 */
export async function updateCaptureTextAction(input: {
  captureId: string;
  expectedVersion: number;
  text: string;
  idempotencyKey?: string;
}): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const parsed = updateTextInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "A capture cannot be emptied. Archive it instead." };

  const auth = await authorize();
  let capture: { version: number };
  try {
    capture = await updateCaptureText(auth, parsed.data);
  } catch (error) {
    if (error instanceof ConflictError || error instanceof StaleWriteError) {
      return { ok: false, error: error.message };
    }
    return fail(error);
  }
  revalidate(auth);
  return { ok: true, version: capture.version };
}

export async function setCaptureStateAction(input: {
  captureId: string;
  expectedVersion: number;
  state: "discarded" | "unprocessed";
}): Promise<Result> {
  const auth = await authorize();
  try {
    await setCaptureState(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

export async function unparkCaptureAction(input: { captureId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await unparkCapture(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

const retryUrlInput = z.object({ captureId: z.string().uuid() });

/**
 * Fetch a failed capture's page again. The command needs no version: it does
 * not edit what the person wrote, only re-queues the fetch. A capture from
 * another workspace is a not-found by design.
 */
export async function retryCaptureUrlAction(input: { captureId: string }): Promise<Result> {
  const parsed = retryUrlInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That capture could not be found. Reload the inbox." };
  const auth = await authorize();
  try {
    await retryCaptureUrl(auth, parsed.data);
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { ok: false, error: error.message };
    }
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

const setKindInput = z.object({ captureId: z.string().uuid(), kind: z.enum(CAPTURE_KINDS) });

/**
 * The person's correction of a capture's kind label. It is stored with source
 * "user", so later enrichment never overwrites it. No version: the label is
 * its own axis, apart from the text an open editor holds.
 */
export async function setCaptureKindAction(input: { captureId: string; kind: CaptureKind }): Promise<Result> {
  const parsed = setKindInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That kind is not one the inbox knows. Reload and try again." };
  const auth = await authorize();
  try {
    const found = await setCaptureKind(auth, parsed.data);
    if (!found) return { ok: false, error: "That capture could not be found. Reload the inbox." };
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

const enrichInput = z.object({ captureId: z.string().uuid() });

/**
 * Enrich a link capture: queue one fetch-and-summarize run. Long-running, so
 * the click only queues it; the detail pane watches the stored state. A click
 * while a run is pending, or after the summary landed, changes nothing.
 */
export async function enrichCaptureAction(input: { captureId: string }): Promise<Result> {
  const parsed = enrichInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That capture could not be found. Reload the inbox." };
  const auth = await authorize();
  let enqueued: boolean;
  try {
    ({ enqueued } = await requestCaptureEnrich(auth, parsed.data));
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) return { ok: false, error: error.message };
    return fail(error);
  }
  if (enqueued) revalidate(auth);
  return { ok: true };
}

/** The detail pane's poll while an Enrich run is pending: a read, never a revalidation. */
export async function captureEnrichStatusAction(input: {
  captureId: string;
}): Promise<{ ok: true; state: WorkState } | { ok: false; error: string }> {
  const parsed = enrichInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That capture could not be found. Reload the inbox." };
  const auth = await authorize();
  const enrichment = await readCaptureEnrichment(auth, parsed.data.captureId);
  if (!enrichment) return { ok: false, error: "That capture could not be found. Reload the inbox." };
  const state: WorkState =
    enrichment.status === "pending"
      ? { phase: "working", label: ENRICH_PENDING_LABEL }
      : enrichment.status === "failed"
        ? { phase: "failed", label: enrichment.error }
        : { phase: "done", label: "Summary ready." };
  return { ok: true, state };
}
