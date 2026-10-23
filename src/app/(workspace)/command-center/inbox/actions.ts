"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import {
  ConflictError,
  StaleWriteError,
  convertCaptureToNote,
  convertCaptureToTask,
  createCapture,
  setCaptureState,
  updateCaptureText,
} from "@/domains/capture/commands";
import { getAuthContext } from "@/lib/auth";
import { capturesTag, tasksTag } from "@/lib/cache-tags";
import { requireRole } from "@/lib/auth/guards";

/* Inbox actions (A02). Every write carries the version the caller rendered. */

type Result = { ok: true } | { ok: false; error: string };

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

export async function captureTextAction(input: { text: string }): Promise<
  { ok: true; id: string } | { ok: false; error: string; existingId?: string }
> {
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

/** Accept a capture into the notebook: the note is created in the same transaction, links resolved. */
export async function makeNoteAction(input: { captureId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await convertCaptureToNote(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidatePath("/alfred/notes");
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
