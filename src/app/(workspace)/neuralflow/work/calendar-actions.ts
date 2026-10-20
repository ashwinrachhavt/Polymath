"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { IdempotencyConflictError } from "@/domains/audit/receipt";
import {
  EventNotFoundError,
  EventVersionConflictError,
  InvalidRangeError,
  NoFreeSlotError,
  blockTimeForTask,
  cancelEvent,
  moveEvent,
} from "@/domains/calendar/commands";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const known = [EventNotFoundError, EventVersionConflictError, InvalidRangeError, NoFreeSlotError, IdempotencyConflictError];

async function guarded<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await run();
    revalidatePath("/neuralflow/work");
    return { ok: true, ...value };
  } catch (error) {
    if (known.some((E) => error instanceof E)) return { ok: false, error: (error as Error).message };
    if (error instanceof Error && error.message.startsWith("task not found")) return { ok: false, error: "That task no longer exists." };
    throw error;
  }
}

const uuid = z.string().uuid();

export async function blockTimeAction(input: {
  taskId: string;
  minutes?: number;
  utcOffsetMinutes?: number;
  idempotencyKey?: string;
}) {
  const parsed = z
    .object({
      taskId: uuid,
      minutes: z.number().int().min(5).max(480).optional(),
      utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
      idempotencyKey: uuid.optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That request was not valid." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return guarded(() => blockTimeForTask(auth, parsed.data));
}

export async function moveEventAction(input: {
  eventId: string;
  expectedVersion: number;
  startsAt: string;
  endsAt: string;
  idempotencyKey?: string;
}) {
  const parsed = z
    .object({
      eventId: uuid,
      expectedVersion: z.number().int().min(1),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date(),
      idempotencyKey: uuid.optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That request was not valid." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return guarded(() => moveEvent(auth, parsed.data));
}

export async function cancelEventAction(input: { eventId: string; expectedVersion: number; idempotencyKey?: string }) {
  const parsed = z
    .object({ eventId: uuid, expectedVersion: z.number().int().min(1), idempotencyKey: uuid.optional() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That request was not valid." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return guarded(() => cancelEvent(auth, parsed.data));
}
