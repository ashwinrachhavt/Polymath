"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CompanyResearchError, runCompanyResearch } from "@/domains/knowledge/company-research";
import { getDossierDetail } from "@/domains/knowledge/dossiers";
import { editGeneratedDraft } from "@/domains/knowledge/studio";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { DRAFT_LINK_TARGETS, linkDraftToRecord, unlinkDraftFromRecord } from "./links";

/*
 * The draft workbench's mutation surface: editing a draft appends a version
 * under the expectedVersion guard, and attaching links it to a task, contact,
 * or opportunity. All writes are member-or-above; each takes an idempotency
 * key so a double-submit is safe.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const revalidate = () => revalidatePath("/alfred/dossiers");

export async function editStudioDraftAction(input: { artifactId: string; expectedVersion: number; text: string; idempotencyKey: string }) {
  const auth = await authorize();
  const parsed = z
    .object({
      artifactId: z.uuid(),
      expectedVersion: z.number().int().min(1),
      text: z.string().min(1).max(100_000),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  const result = await editGeneratedDraft(auth, parsed);
  revalidate();
  return result;
}

export async function linkDraftToRecordAction(input: { artifactId: string; targetType: string; targetId: string; idempotencyKey: string }) {
  const auth = await authorize();
  const parsed = z
    .object({
      artifactId: z.uuid(),
      targetType: z.enum(DRAFT_LINK_TARGETS),
      targetId: z.uuid(),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  await linkDraftToRecord(auth, parsed);
  revalidate();
  return { linked: true };
}

export async function unlinkDraftFromRecordAction(input: { artifactId: string; linkId: string; idempotencyKey: string }) {
  const auth = await authorize();
  const parsed = z
    .object({
      artifactId: z.uuid(),
      linkId: z.uuid(),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  await unlinkDraftFromRecord(auth, parsed);
  revalidate();
  return { unlinked: true };
}

/*
 * ASH-114 dossier entry point: a case study that reads only this dossier's
 * pinned sources. Dossier-only mode is the engine's structural guarantee -
 * no query text exists to run, so this can never silently web-search.
 */
export async function researchDossierCompanyAction(input: { dossierId: string; companyName: string; idempotencyKey: string }) {
  const auth = await authorize();
  const parsed = z
    .object({
      dossierId: z.uuid(),
      companyName: z.string().trim().min(1).max(300),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  if (!(await getDossierDetail(auth, parsed.dossierId))) {
    return { ok: false as const, error: "No such dossier." };
  }
  try {
    const result = await runCompanyResearch(auth, {
      companyName: parsed.companyName,
      mode: "dossier-only",
      dossierId: parsed.dossierId,
      depth: "standard",
      idempotencyKey: parsed.idempotencyKey,
    });
    revalidate();
    return { ok: true as const, artifactId: result.artifactId, title: result.title, manifestSize: result.manifestSize, gapSections: result.gapSections };
  } catch (error) {
    if (error instanceof CompanyResearchError) return { ok: false as const, error: error.message };
    throw error;
  }
}
