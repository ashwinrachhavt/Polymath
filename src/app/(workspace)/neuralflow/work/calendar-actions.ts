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
import { bindGuarded } from "@/lib/result";

const known = [
  EventNotFoundError,
  EventVersionConflictError,
  InvalidRangeError,
  NoFreeSlotError,
  IdempotencyConflictError,
  ProposalConflictError,
  ProposalNotFoundError,
  StaleRevisionError,
  CalendarExecuteNotAllowedError,
  AttemptAlreadyClaimedError,
];

const guarded = bindGuarded({
  domainErrors: known,
  onSuccess: () => revalidatePath("/neuralflow/work"),
  mapError: (error) => {
    if (error instanceof Error && error.message.startsWith("task not found")) return "That task no longer exists.";
    return undefined;
  },
});

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

export async function approveProposalAction(input: {
  proposalId: string;
  expectedVersion: number;
  revisionId: string;
}) {
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

export async function addBlockAction(input: {
  title: string;
  startsAt: string;
  endsAt: string;
  idempotencyKey?: string;
}) {
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(200),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date(),
      idempotencyKey: uuid.optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the block a title and a start and end time." } as const;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return guarded(async () => {
    await createEvent(auth, parsed.data);
    return {};
  });
}
