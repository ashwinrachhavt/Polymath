"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CompanyResearchError, runCompanyResearch } from "@/domains/knowledge/company-research";
import { ingestSessionRecords } from "@/domains/agents/session-scan";
import { getProjectDetail } from "@/domains/knowledge/projects";
import { editGeneratedDraft } from "@/domains/knowledge/studio";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { collectSessionRecords } from "@/lib/agent-artifacts/scan";
import { DRAFT_LINK_TARGETS, linkDraftToRecord, unlinkDraftFromRecord } from "@/app/(workspace)/projects-links";

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

const revalidate = () => {
  revalidatePath("/projects");
  revalidatePath("/artifacts");
};

export async function editStudioDraftAction(input: {
  artifactId: string;
  expectedVersion: number;
  /** A report's body. Exactly one of text/structured is required. */
  text?: string;
  /** A deck's or infographic's structure. */
  structured?: unknown;
  idempotencyKey: string;
}) {
  const auth = await authorize();
  const parsed = z
    .object({
      artifactId: z.uuid(),
      expectedVersion: z.number().int().min(1),
      text: z.string().min(1).max(100_000).optional(),
      structured: z.unknown().optional(),
      idempotencyKey: z.uuid(),
    })
    .refine((v) => Boolean(v.text) !== Boolean(v.structured), {
      message: "Send either text or structured content, not both.",
    })
    .parse(input);
  const result = await editGeneratedDraft(auth, {
    artifactId: parsed.artifactId,
    expectedVersion: parsed.expectedVersion,
    text: parsed.text,
    structured: parsed.structured as Parameters<typeof editGeneratedDraft>[1]["structured"],
    idempotencyKey: parsed.idempotencyKey,
  });
  revalidate();
  return result;
}

export async function linkDraftToRecordAction(input: {
  artifactId: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
}) {
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

export async function unlinkDraftFromRecordAction(input: {
  artifactId: string;
  linkId: string;
  idempotencyKey: string;
}) {
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
export async function researchDossierCompanyAction(input: {
  projectId: string;
  companyName: string;
  idempotencyKey: string;
}) {
  const auth = await authorize();
  const parsed = z
    .object({
      projectId: z.uuid(),
      companyName: z.string().trim().min(1).max(300),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  if (!(await getProjectDetail(auth, parsed.projectId))) {
    return { ok: false as const, error: "No such project." };
  }
  try {
    const result = await runCompanyResearch(auth, {
      companyName: parsed.companyName,
      mode: "dossier-only",
      dossierId: parsed.projectId,
      depth: "standard",
      idempotencyKey: parsed.idempotencyKey,
    });
    revalidate();
    return {
      ok: true as const,
      artifactId: result.artifactId,
      title: result.title,
      manifestSize: result.manifestSize,
      gapSections: result.gapSections,
    };
  } catch (error) {
    if (error instanceof CompanyResearchError) return { ok: false as const, error: error.message };
    throw error;
  }
}

/*
 * Local agent-artifact scan (Workbench D1): read the user's own Claude Code /
 * Codex folders, parse them defensively, and store sessions locally. Nothing
 * is sent to a model or off the machine — the disclosure the brief carries is
 * true because this action is the only ingest path. Scan scope is the whole
 * workspace (roots come from env), matching happens by cwd, and the project
 * page wires the button (PR C).
 */
const scanAgentSessionsInput = z.object({
  /** What these sessions were for, when the operator says it at scan time. */
  decisionNote: z.string().trim().min(1).max(2000).optional(),
});

export async function scanAgentSessionsAction(input: { decisionNote?: string }): Promise<
  | {
      ok: true;
      imported: number;
      updated: number;
      blobsDeduped: number;
      sessionIds: string[];
      /** Files set aside by the guard or parsers, with reasons. */
      skipped: { source: string; path: string; kind: string; reason: string }[];
      /** Sources that could not be scanned at all (agent not installed, root missing). */
      unavailable: { source: string; kind: string; message: string }[];
      /** Defensive-decode counters: records read vs lines set aside. */
      decode: { records: number; skippedRecords: number };
    }
  | { ok: false; error: string }
> {
  const auth = await authorize();
  const parsed = scanAgentSessionsInput.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "A decision note is optional, but what you typed is too long (max 2000)." };

  try {
    const scan = await collectSessionRecords();
    const ingest = await ingestSessionRecords(auth, scan.records, { decisionNote: parsed.data.decisionNote });
    revalidate();
    return {
      ok: true,
      imported: ingest.imported,
      updated: ingest.updated,
      blobsDeduped: ingest.blobsDeduped,
      sessionIds: ingest.sessionIds,
      skipped: scan.skipped,
      unavailable: scan.unavailable,
      decode: scan.records.reduce(
        (totals, record) => ({
          records: totals.records + record.parsed.stats.records,
          skippedRecords: totals.skippedRecords + record.parsed.stats.skippedRecords,
        }),
        { records: 0, skippedRecords: 0 },
      ),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The scan failed." };
  }
}
