"use server";

import { cancelCorrespondence, draftCorrespondence, requestSendApproval } from "@/domains/crm/correspondence";
import { gmailMailSender } from "@/domains/crm/mail-sender";
import { resolveUnknownSend, sendApprovedCorrespondence } from "@/domains/crm/send-executor";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ImportBusyError, ImportLimitError, importConnections, type ImportSummary } from "@/domains/identity/party-csv";
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
import { mergeCompanies, mergeContacts } from "@/domains/crm/dedupe";
import { and, eq } from "drizzle-orm";
import { companies, relationshipStatus } from "@/domains/crm/schema";
import { CompanyResearchError, runCompanyResearch } from "@/domains/knowledge/company-research";
import { db } from "@/lib/db";
import { linkDraftToRecord } from "@/app/(workspace)/alfred/dossiers/links";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Relationships mutations. Each action authenticates, parses, then delegates
 * to the domain command; the user-safe errors (conflict, stale write, not
 * found) become { ok: false } results and anything unexpected rethrows to the
 * error boundary, same split as the import action above this folder.
 */

/*
 * Mutations can land from any of the three surfaces (people, companies, the
 * contact workspace), so all three revalidate.
 */
const revalidate = () => {
  for (const path of [
    "/command-center/relationships/people",
    "/command-center/relationships/companies",
    "/command-center/relationships/contacts",
  ]) revalidatePath(path);
};

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
    if (error instanceof ImportLimitError || error instanceof ImportBusyError) {
      return { ok: false, error: error.message };
    }
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

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(error: unknown): { ok: false; error: string } {
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

/* C03 outreach: drafts and the approval gate. Nothing sends from here. */
export async function draftCorrespondenceAction(input: { contactId: string; subject?: string; body: string }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!input.body.trim()) return { ok: false, error: "The draft needs a body." };
  try {
    await draftCorrespondence(auth, {
      contactId: input.contactId,
      subject: input.subject?.trim() || undefined,
      body: input.body.trim(),
    });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function cancelCorrespondenceAction(input: { correspondenceId: string; expectedVersion: number }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await cancelCorrespondence(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function requestSendApprovalAction(input: { correspondenceId: string; expectedVersion: number }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await requestSendApproval(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/*
 * The send step of the approval journey: the owner approved the exact
 * recipient, account, subject and body in Reviews; this executes that
 * approval through the wired Gmail adapter. The executor re-checks every one
 * of those bindings at send time, so a draft, contact address or account
 * changed after approval is refused here, not sent. The outcome is returned
 * so the screen can say "sent", "failed" or "unknown - reconcile" truthfully.
 */
export async function sendApprovedCorrespondenceAction(input: {
  correspondenceId: string;
}): Promise<Result<{ state: "sent" | "failed" | "unknown" }>> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const parsed = z.object({ correspondenceId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Malformed send request." };
  try {
    const result = await sendApprovedCorrespondence(auth, {
      correspondenceId: parsed.data.correspondenceId,
      sender: gmailMailSender(),
    });
    revalidate();
    return { ok: true, state: result.state };
  } catch (error) {
    revalidate();
    return fail(error);
  }
}

/*
 * ASH-191: close a send whose outcome the provider never confirmed. Without
 * this the draft stayed blocked forever and the only exit was editing the
 * database by hand. The caller reports what the provider actually holds — the
 * message, or nothing — and the command records that as evidence.
 */
export async function resolveUnknownSendAction(input: {
  attemptId: string;
  outcome: "sent" | "absent";
  providerObjectId?: string;
}): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const parsed = z
    .object({
      attemptId: z.uuid(),
      outcome: z.enum(["sent", "absent"]),
      providerObjectId: z.string().trim().min(1).optional(),
    })
    .refine((value) => value.outcome !== "sent" || Boolean(value.providerObjectId), {
      message: "Give the provider's message id when the message exists.",
      path: ["providerObjectId"],
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details and try again." };
  try {
    await resolveUnknownSend(auth, {
      attemptId: parsed.data.attemptId,
      observation:
        parsed.data.outcome === "sent"
          ? { observedState: "sent", providerObjectId: parsed.data.providerObjectId! }
          : { observedState: "absent" },
      source: "human_check",
    });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/*
 * ASH-114 company-record entry point: a public-mode case study on this
 * company, persisted as a Studio draft and linked back to the company record
 * so the workbench shows where it belongs.
 */
export async function researchCompanyRecordAction(input: { companyId: string; idempotencyKey: string }) {
  const auth = await authorize();
  const parsed = z.object({ companyId: z.uuid(), idempotencyKey: z.uuid() }).parse(input);
  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, parsed.companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) return { ok: false as const, error: "No such company." };
  try {
    const result = await runCompanyResearch(auth, {
      companyName: company.name,
      mode: "public",
      depth: "standard",
      idempotencyKey: parsed.idempotencyKey,
    });
    await linkDraftToRecord(auth, { artifactId: result.artifactId, targetType: "company", targetId: company.id });
    revalidate();
    return { ok: true as const, artifactId: result.artifactId, title: result.title, manifestSize: result.manifestSize, gapSections: result.gapSections };
  } catch (error) {
    if (error instanceof CompanyResearchError) return { ok: false as const, error: error.message };
    throw error;
  }
}

const mergeFields = {
  sourceId: uuid,
  targetId: uuid,
  expectedTargetVersion: z.number().int().min(1),
};

export async function mergeContactsAction(input: unknown): Promise<{ ok: true; merged: string; into: string } | { ok: false; error: string }> {
  const parsed = z.object(mergeFields).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That merge could not be read. Reload and try again." };
  const auth = await authorize();
  try {
    const result = await mergeContacts(auth, parsed.data);
    revalidate();
    return { ok: true, merged: result.merged, into: result.into };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The merge failed." };
  }
}

export async function mergeCompaniesAction(input: unknown): Promise<{ ok: true; merged: string; into: string } | { ok: false; error: string }> {
  const parsed = z.object(mergeFields).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That merge could not be read. Reload and try again." };
  const auth = await authorize();
  try {
    const result = await mergeCompanies(auth, parsed.data);
    revalidate();
    return { ok: true, merged: result.merged, into: result.into };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The merge failed." };
  }
}
