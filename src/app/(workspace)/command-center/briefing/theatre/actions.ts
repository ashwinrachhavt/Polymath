"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  scheduleSessionFromCapture,
  startScheduledFocusSession,
  unscheduleFocusSession,
} from "@/domains/focus/commands";
import { ConflictError, StaleWriteError } from "@/domains/focus/commands";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The theatre's mutations (ASH-308). Standard server-action order:
 * authenticate -> resolve context -> parse -> domain command (the receipt and
 * the audit row live inside it, in the same transaction) -> revalidate. The
 * client never supplies workspace or owner; the idempotency key travels with
 * the drag so a double-fire replays instead of duplicating.
 */

const scheduleSchema = z.object({
  captureId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
  idempotencyKey: z.string().min(8).max(200),
});

export type TheatreActionResult = { ok: true } | { ok: false; message: string };

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

function labelled(cause: unknown): TheatreActionResult {
  if (cause instanceof ConflictError || cause instanceof StaleWriteError) {
    return { ok: false, message: cause.message };
  }
  return { ok: false, message: "The slot could not be scheduled. Try again." };
}

export async function scheduleCaptureAction(input: z.input<typeof scheduleSchema>): Promise<TheatreActionResult> {
  const auth = await authorize();
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That schedule request is not well formed." };
  try {
    await scheduleSessionFromCapture(auth, {
      captureId: parsed.data.captureId,
      scheduledAt: new Date(parsed.data.scheduledAt),
      idempotencyKey: parsed.data.idempotencyKey,
    });
    revalidatePath("/command-center/briefing");
    return { ok: true };
  } catch (cause) {
    return labelled(cause);
  }
}

const unscheduleSchema = z.object({ sessionId: z.string().uuid() });

export async function unscheduleSessionAction(input: z.input<typeof unscheduleSchema>): Promise<TheatreActionResult> {
  const auth = await authorize();
  const parsed = unscheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That scheduled block is not well formed." };
  try {
    await unscheduleFocusSession(auth, { sessionId: parsed.data.sessionId });
    revalidatePath("/command-center/briefing");
    return { ok: true };
  } catch (cause) {
    return labelled(cause);
  }
}

const startSchema = z.object({ sessionId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() });

export async function startScheduledSessionAction(input: z.input<typeof startSchema>): Promise<TheatreActionResult> {
  const auth = await authorize();
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That scheduled block is not well formed." };
  try {
    await startScheduledFocusSession(auth, { sessionId: parsed.data.sessionId, expectedVersion: parsed.data.expectedVersion });
    revalidatePath("/command-center/briefing");
    return { ok: true };
  } catch (cause) {
    return labelled(cause);
  }
}
