"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ImportLimitError, importConnections, type ImportSummary } from "@/domains/identity/party-csv";
import {
  addObservation,
  archiveContact,
  ConflictError,
  createCompany,
  createContact,
  createFollowUp,
  NotFoundError,
  resolveFollowUp,
  StaleWriteError,
  updateContact,
} from "@/domains/crm/commands";
import { relationshipStatus } from "@/domains/crm/schema";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Relationships mutations. Each action authenticates, parses, then delegates
 * to the domain command; the user-safe errors (conflict, stale write, not
 * found) become { ok: false } results and anything unexpected rethrows to the
 * error boundary, same split as the import action above this folder.
 */

const revalidate = () => revalidatePath("/command-center/relationships");

/*
 * The import takes CSV text, not a File: the client reads the file and posts
 * the string, which keeps this a plain server action instead of a route
 * handler with a body-size contract to maintain.
 */
export async function importConnectionsCsv(input: {
  csv: string;
}): Promise<{ ok: true; summary: ImportSummary } | { ok: false; error: string }> {
  const parsed = z.object({ csv: z.string().min(1).max(5_000_000) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That file could not be read as text." };

  const auth = await getAuthContext();
  try {
    const summary = await importConnections(auth, { csv: parsed.data.csv });
    revalidate();
    return { ok: true, summary };
  } catch (error) {
    // A deliberate refusal is the one error the owner can act on; anything
    // else is rethrown to the error boundary.
    if (error instanceof ImportLimitError) return { ok: false, error: error.message };
    throw error;
  }
}

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const uuid = z.string().uuid();

const contactFields = {
  fullName: z.string().trim().min(1).max(300),
  primaryEmail: z.string().trim().email().max(320).or(z.literal("")).optional(),
  phone: z.string().trim().max(40).optional(),
  title: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  relationshipStatus: z.enum(relationshipStatus.enumValues).optional(),
  notes: z.string().max(10_000).optional(),
  companyId: uuid.nullable().optional(),
};

type Result = { ok: true } | { ok: false; error: string };

function fail(error: unknown): Result {
  if (error instanceof ConflictError || error instanceof StaleWriteError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

export async function createContactAction(input: unknown): Promise<Result> {
  const parsed = z.object(contactFields).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields and try again." };
  const auth = await authorize();
  try {
    await createContact(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function updateContactAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({ contactId: uuid, expectedVersion: z.number().int().min(1), ...contactFields })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields and try again." };
  const auth = await authorize();
  try {
    await updateContact(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function archiveContactAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({ contactId: uuid, expectedVersion: z.number().int().min(1) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That contact could not be archived." };
  const auth = await authorize();
  try {
    await archiveContact(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function addObservationAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      contactId: uuid,
      body: z.string().trim().min(1).max(5_000),
      source: z.enum(["stated", "document", "observed"]),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "An observation needs some text first." };
  const auth = await authorize();
  try {
    await addObservation(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function createFollowUpAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      contactId: uuid,
      dueAt: z.string().date().optional(),
      note: z.string().max(2_000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That follow-up could not be saved." };
  const auth = await authorize();
  try {
    await createFollowUp(auth, {
      contactId: parsed.data.contactId,
      // `date()` guarantees YYYY-MM-DD; noon UTC keeps the due date on the
      // intended calendar day for any workspace behind UTC.
      dueAt: parsed.data.dueAt ? new Date(`${parsed.data.dueAt}T12:00:00Z`) : null,
      note: parsed.data.note,
    });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function resolveFollowUpAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      followUpId: uuid,
      expectedVersion: z.number().int().min(1),
      resolution: z.enum(["done", "cancelled"]),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That follow-up could not be updated." };
  const auth = await authorize();
  try {
    await resolveFollowUp(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function createCompanyAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(300),
      domain: z.string().trim().max(253).optional(),
      description: z.string().max(2_000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "A company needs at least a name." };
  const auth = await authorize();
  try {
    await createCompany(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}
