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
import {
  CalendarExecuteNotAllowedError,
  approveCalendarProposal,
  rejectCalendarProposal,
} from "@/domains/calendar/proposals";
import { AttemptAlreadyClaimedError } from "@/domains/actions/attempts";
import { ProposalConflictError, ProposalNotFoundError, StaleRevisionError } from "@/domains/actions/commands";
import { createEvent } from "@/domains/calendar/commands";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const known = [EventNotFoundError, EventVersionConflictError, InvalidRangeError, NoFreeSlotError, IdempotencyConflictError, ProposalConflictError, ProposalNotFoundError, StaleRevisionError, CalendarExecuteNotAllowedError, AttemptAlreadyClaimedError];

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

const decision = z.object({ proposalId: uuid, expectedVersion: z.number().int().min(1), revisionId: uuid });

export async function approveProposalAction(input: { proposalId: string; expectedVersion: number; revisionId: string }) {
  const parsed = decision.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That request was not valid." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "admin");
  return guarded(() => approveCalendarProposal(auth, parsed.data));
}

export async function rejectProposalAction(input: { proposalId: string; expectedVersion: number; revisionId: string }) {
  const parsed = decision.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That request was not valid." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return guarded(async () => {
    await rejectCalendarProposal(auth, parsed.data);
    return {};
  });
}

export async function addBlockAction(input: { title: string; startsAt: string; endsAt: string; idempotencyKey?: string }) {
  const parsed = z
    .object({ title: z.string().trim().min(1).max(200), startsAt: z.coerce.date(), endsAt: z.coerce.date(), idempotencyKey: uuid.optional() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the block a title and a start and end time." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return guarded(async () => {
    await createEvent(auth, parsed.data);
    return {};
  });
}
