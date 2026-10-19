"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  addDeadline,
  archiveOpportunity,
  changeStage,
  createOpportunity,
  markDeadlineMet,
  NotFoundError,
  StaleWriteError,
  updateOpportunity,
} from "@/domains/opportunities/commands";
import { getOpportunityDetail, OPPORTUNITY_STAGES } from "@/domains/opportunities/queries";
import { CompanyResearchError, runCompanyResearch } from "@/domains/knowledge/company-research";
import { linkDraftToRecord } from "@/app/(workspace)/alfred/dossiers/links";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Pipeline mutations. Same split as relationships: authenticate, parse,
 * delegate; the user-safe errors become { ok: false } and the unexpected
 * rethrows to the error boundary.
 */

const revalidate = () => revalidatePath("/command-center/opportunities");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const uuid = z.string().uuid();

const opportunityFields = {
  title: z.string().trim().min(1).max(300),
  companyId: uuid.nullable().optional(),
  primaryContactId: uuid.nullable().optional(),
  whyItMatters: z.string().max(5_000).optional(),
  sourceType: z.string().trim().max(100).optional(),
  nextCommitment: z.string().max(500).optional(),
  nextCommitmentOn: z.string().date().optional(),
};

type Result = { ok: true } | { ok: false; error: string };

function fail(error: unknown): Result {
  if (error instanceof StaleWriteError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

function toCommitmentAt(date: string | undefined): Date | null {
  // Noon UTC keeps the commitment on the intended calendar day for any
  // workspace behind UTC, same convention as follow-up due dates.
  return date ? new Date(`${date}T12:00:00Z`) : null;
}

export async function createOpportunityAction(input: unknown): Promise<Result> {
  const parsed = z.object(opportunityFields).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields and try again." };
  const auth = await authorize();
  const { nextCommitmentOn, ...rest } = parsed.data;
  try {
    await createOpportunity(auth, { ...rest, nextCommitmentAt: toCommitmentAt(nextCommitmentOn) });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function updateOpportunityAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({ opportunityId: uuid, expectedVersion: z.number().int().min(1), ...opportunityFields })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields and try again." };
  const auth = await authorize();
  const { nextCommitmentOn, ...rest } = parsed.data;
  try {
    await updateOpportunity(auth, { ...rest, nextCommitmentAt: toCommitmentAt(nextCommitmentOn) });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function changeStageAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      opportunityId: uuid,
      expectedVersion: z.number().int().min(1),
      toStage: z.enum(OPPORTUNITY_STAGES),
      note: z.string().max(1_000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That stage change could not be saved." };
  const auth = await authorize();
  try {
    await changeStage(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function archiveOpportunityAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({ opportunityId: uuid, expectedVersion: z.number().int().min(1) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That opportunity could not be archived." };
  const auth = await authorize();
  try {
    await archiveOpportunity(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function addDeadlineAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      opportunityId: uuid,
      label: z.string().trim().min(1).max(200),
      dueOn: z.string().date().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "A deadline needs a label." };
  const auth = await authorize();
  try {
    await addDeadline(auth, { ...parsed.data, dueOn: parsed.data.dueOn || null });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function markDeadlineMetAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({ deadlineId: uuid, expectedVersion: z.number().int().min(1) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "That deadline could not be updated." };
  const auth = await authorize();
  try {
    await markDeadlineMet(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/*
 * ASH-114 opportunity entry point: a public-mode case study on the
 * opportunity's company, persisted as a Studio draft linked to the
 * opportunity record.
 */
export async function researchOpportunityCompanyAction(input: { opportunityId: string; idempotencyKey: string }) {
  const auth = await authorize();
  const parsed = z.object({ opportunityId: z.string().uuid(), idempotencyKey: z.string().uuid() }).parse(input);
  const detail = await getOpportunityDetail(auth, { opportunityId: parsed.opportunityId });
  if (!detail) return { ok: false as const, error: "No such opportunity." };
  if (!detail.companyName) return { ok: false as const, error: "Record a company on this opportunity to research it." };
  try {
    const result = await runCompanyResearch(auth, {
      companyName: detail.companyName,
      mode: "public",
      depth: "standard",
      idempotencyKey: parsed.idempotencyKey,
    });
    await linkDraftToRecord(auth, { artifactId: result.artifactId, targetType: "opportunity", targetId: parsed.opportunityId });
    revalidate();
    return { ok: true as const, artifactId: result.artifactId, title: result.title, manifestSize: result.manifestSize, gapSections: result.gapSections };
  } catch (error) {
    if (error instanceof CompanyResearchError) return { ok: false as const, error: error.message };
    throw error;
  }
}
