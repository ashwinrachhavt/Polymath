import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { AgentEngine } from "@/domains/agents/engine";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { withReceipt } from "@/domains/audit/receipt";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { artifactLinks, artifactVersions, artifacts, dossierSources, dossiers, sources } from "./schema";
import { documents } from "./schema";

/*
 * Studio Generate: a run that names a dossier, whose output is saved as a DRAFT
 * artifact linked to the pinned document versions it was built from. The owner
 * then saves (keeps it as reviewed) or discards it. Nothing in this file can
 * publish: no code path sets the `published` status.
 */

export class StudioError extends Error {
  constructor(
    public readonly code: "dossier_not_found" | "run_not_found" | "no_output" | "not_a_draft" | "draft_not_found" | "record_not_found" | "empty_text" | "stale_or_locked" | "unsupported_kind",
    message: string,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

/*
 * The kinds Studio generates and can reopen. A report, a deck and an
 * infographic are the same container with a different shape, so every guard
 * below reads this one set. Hardcoding "report" here is what filed a generated
 * deck as a report and then refused to open it (eng review, 2026-10-19).
 */
export const GENERATABLE_KINDS = ["report", "deck", "infographic"] as const;
export type GeneratableKind = (typeof GENERATABLE_KINDS)[number];

export function isGeneratableKind(value: string): value is GeneratableKind {
  return (GENERATABLE_KINDS as readonly string[]).includes(value);
}

/** Starts the run. The objective names the dossier, and the run is bound to it so search stays inside it. */
export async function startStudioGenerate(
  auth: AuthContext,
  input: { dossierId: string; brief: string },
  engine: AgentEngine,
) {
  const [dossier] = await db
    .select({ id: dossiers.id, title: dossiers.title })
    .from(dossiers)
    .where(and(eq(dossiers.id, input.dossierId), eq(dossiers.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!dossier) throw new StudioError("dossier_not_found", "No such dossier.");
  return engine.start({
    auth,
    profileName: "alfred",
    objective: `Using only the documents in the dossier "${dossier.title}", write a draft: ${input.brief.trim()}`,
    subjects: [{ type: "dossier", id: dossier.id }],
    estimateUsd: "0.50",
  });
}

/**
 * Saves a finished run's last assistant message as a draft artifact. Idempotent
 * per run (one artifact per run). Links the dossier's documents with the
 * content hash each was pinned at, and the run itself.
 */
export async function saveGeneratedDraft(auth: AuthContext, input: { runId: string; title?: string; kind?: GeneratableKind }) {
  const kind = input.kind ?? "report";
  if (!isGeneratableKind(kind)) throw new StudioError("unsupported_kind", "That artifact kind is not generated here.");
  return withTransaction(async (tx) => {
    const [run] = await tx
      .select({ id: agentRuns.id, subjects: agentRuns.subjects, objective: agentRuns.objective })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!run) throw new StudioError("run_not_found", "No such run.");

    const [existing] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.producedByRunId, run.id), eq(artifacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (existing) return { artifactId: existing.id, created: false };

    const events = await tx
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.workspaceId, auth.workspaceId), eq(runEvents.type, "message")))
      .orderBy(desc(runEvents.sequence));
    const last = events.map((e) => e.data as { role?: string; content?: unknown }).find((d) => d?.role === "assistant" && typeof d.content === "string");
    if (!last) throw new StudioError("no_output", "This run has produced no output yet.");
    const text = last.content as string;

    const dossierSubject = (Array.isArray(run.subjects) ? (run.subjects as Array<{ type?: string; id?: string }>) : []).find((s) => s?.type === "dossier");
    const [artifact] = await tx
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind,
        title: (input.title?.trim() || run.objective).slice(0, 200),
        status: "draft",
        producedByRunId: run.id,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    const [version] = await tx
      .insert(artifactVersions)
      .values({ workspaceId: auth.workspaceId, artifactId: artifact.id, versionNumber: 1, content: { text }, plainText: text, reason: "generated", createdBy: auth.userId })
      .returning({ id: artifactVersions.id });
    await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));

    await tx.insert(artifactLinks).values({ workspaceId: auth.workspaceId, artifactId: artifact.id, targetType: "run", targetId: run.id, label: "produced by" });
    if (dossierSubject?.id) {
      const pinned = await tx
        .select({ documentId: documents.id, hash: dossierSources.pinnedContentHash })
        .from(dossierSources)
        .innerJoin(dossiers, and(eq(dossiers.id, dossierSources.dossierId), eq(dossiers.workspaceId, auth.workspaceId)))
        .innerJoin(sources, eq(sources.id, dossierSources.sourceId))
        .innerJoin(documents, and(eq(documents.fileId, sources.fileId), eq(documents.workspaceId, auth.workspaceId)))
        .where(and(eq(dossierSources.dossierId, dossierSubject.id), eq(dossierSources.workspaceId, auth.workspaceId)));
      for (const p of pinned) {
        await tx
          .insert(artifactLinks)
          .values({ workspaceId: auth.workspaceId, artifactId: artifact.id, targetType: "document", targetId: p.documentId, label: `pinned:${p.hash ?? "none"}` })
          .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
      }
    }
    return { artifactId: artifact.id, created: true };
  });
}

async function decide(auth: AuthContext, artifactId: string, status: "reviewed" | "archived", action: string) {
  return withTransaction(async (tx) => {
    // Only a draft can be decided, so a saved or discarded one is never rewritten.
    const [row] = await tx
      .update(artifacts)
      .set({ status, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${artifacts.version} + 1`, ...(status === "archived" ? { archivedAt: new Date() } : {}) })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.status, "draft")))
      .returning({ id: artifacts.id });
    if (!row) throw new StudioError("not_a_draft", "This draft was not found or was already decided.");
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId, actorId: auth.userId, actorKind: "user", action,
      subjectType: "artifact", subjectId: artifactId, summary: action === "draft.saved" ? "Saved generated draft" : "Discarded generated draft",
    });
  });
}

/** Keep the draft. It becomes "reviewed", never "published". */
export const saveDraft = (auth: AuthContext, input: { artifactId: string }) => decide(auth, input.artifactId, "reviewed", "draft.saved");
/** Throw it away: archived, hidden, versions kept for the record. */
export const discardDraft = (auth: AuthContext, input: { artifactId: string }) => decide(auth, input.artifactId, "archived", "draft.discarded");

/** The artifact each run produced, keyed by run id — so a run row can render its save/keep/discard state. */
export async function draftsForRuns(auth: AuthContext, runIds: string[]) {
  const map = new Map<string, { artifactId: string; status: string }>();
  if (runIds.length === 0) return map;
  const rows = await db
    .select({ runId: artifacts.producedByRunId, artifactId: artifacts.id, status: artifacts.status })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, auth.workspaceId), inArray(artifacts.producedByRunId, runIds)));
  for (const row of rows) if (row.runId) map.set(row.runId, { artifactId: row.artifactId, status: row.status });
  return map;
}

/** Open generated drafts, newest first — the list behind GET /api/v1/drafts. */
export async function listDrafts(auth: AuthContext) {
  return db
    .select({ artifactId: artifacts.id, title: artifacts.title, runId: artifacts.producedByRunId, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.status, "draft"), sql`${artifacts.archivedAt} is null`))
    .orderBy(desc(artifacts.createdAt))
    .limit(100);
}

/* ---------------------------------------------------------------------------
 * Draft workbench: open a saved draft with the pinned sources it stands on,
 * and edit it as a new version under the notebook's optimistic-concurrency
 * guard. Record links (task/contact/opportunity) live in the dossiers app
 * module, which owns those cross-domain imports.
 * ------------------------------------------------------------------------- */

export type DraftLinkRow = { id: string; targetType: string; targetId: string; label: string | null };

export type DraftDetail = {
  artifact: { id: string; title: string; status: string; version: number };
  text: string;
  /** The documents this draft was generated from, each at the hash it was pinned at. */
  sources: { documentId: string; title: string; pinnedHash: string | null }[];
  /** Raw record links; the app layer resolves their titles. */
  links: DraftLinkRow[];
};

const RECORD_LINK_TARGETS = ["task", "contact", "company", "opportunity"] as const;

export async function getDraftDetail(auth: AuthContext, artifactId: string): Promise<DraftDetail> {
  const [artifact] = await db
    .select({
      id: artifacts.id,
      kind: artifacts.kind,
      title: artifacts.title,
      status: artifacts.status,
      version: artifacts.version,
      currentVersionId: artifacts.currentVersionId,
    })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!artifact || !isGeneratableKind(artifact.kind)) throw new StudioError("draft_not_found", "No such draft.");

  const [version] = artifact.currentVersionId
    ? await db
        .select({ plainText: artifactVersions.plainText })
        .from(artifactVersions)
        .where(and(eq(artifactVersions.id, artifact.currentVersionId), eq(artifactVersions.workspaceId, auth.workspaceId)))
        .limit(1)
    : [null];

  const linkRows = await db
    .select({ id: artifactLinks.id, targetType: artifactLinks.targetType, targetId: artifactLinks.targetId, label: artifactLinks.label })
    .from(artifactLinks)
    .where(and(eq(artifactLinks.artifactId, artifact.id), eq(artifactLinks.workspaceId, auth.workspaceId)));

  const documentIds = linkRows.filter((l) => l.targetType === "document").map((l) => l.targetId);
  const docs = documentIds.length
    ? await db
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(and(inArray(documents.id, documentIds), eq(documents.workspaceId, auth.workspaceId)))
    : [];
  const docTitles = new Map(docs.map((d) => [d.id, d.title]));

  return {
    artifact: { id: artifact.id, title: artifact.title, status: artifact.status, version: artifact.version },
    text: version?.plainText ?? "",
    sources: linkRows
      .filter((l) => l.targetType === "document" && docTitles.has(l.targetId))
      .map((l) => ({
        documentId: l.targetId,
        title: docTitles.get(l.targetId) as string,
        pinnedHash: l.label?.startsWith("pinned:") ? l.label.slice("pinned:".length) : null,
      })),
    links: linkRows.filter((l) => (RECORD_LINK_TARGETS as readonly string[]).includes(l.targetType)),
  };
}

/**
 * Appends an edited version and moves the pointer, guarded by the caller's
 * last-seen version. Drafts and reviewed drafts are editable; an archived one
 * is not. Idempotent under the receipt, and a stale expectedVersion loses.
 */
export async function editGeneratedDraft(
  auth: AuthContext,
  input: { artifactId: string; expectedVersion: number; text: string; note?: string; idempotencyKey: string },
) {
  const text = input.text.trim();
  if (!text) throw new StudioError("empty_text", "The draft needs some text.");
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "editGeneratedDraft", ...input }, async () => {
      const [updated] = await tx
        .update(artifacts)
        .set({ updatedAt: new Date(), updatedBy: auth.userId, version: sql`${artifacts.version} + 1` })
        .where(
          and(
            eq(artifacts.id, input.artifactId),
            eq(artifacts.workspaceId, auth.workspaceId),
            eq(artifacts.version, input.expectedVersion),
            inArray(artifacts.kind, GENERATABLE_KINDS),
            inArray(artifacts.status, ["draft", "reviewed"]),
          ),
        )
        .returning({ id: artifacts.id });
      if (!updated) throw new StudioError("stale_or_locked", "This draft changed elsewhere or was archived. Reload and try again.");
      const [last] = await tx
        .select({ n: artifactVersions.versionNumber })
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, input.artifactId), eq(artifactVersions.workspaceId, auth.workspaceId)))
        .orderBy(desc(artifactVersions.versionNumber))
        .limit(1);
      const [version] = await tx
        .insert(artifactVersions)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: input.artifactId,
          versionNumber: (last?.n ?? 0) + 1,
          content: { text },
          plainText: text,
          reason: "edited",
          createdBy: auth.userId,
        })
        .returning({ id: artifactVersions.id });
      await tx
        .update(artifacts)
        .set({ currentVersionId: version.id })
        .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)));
      await tx.insert(auditEvents).values({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        actorKind: "user",
        action: "draft.edited",
        subjectType: "artifact",
        subjectId: input.artifactId,
        summary: "Edited Studio draft",
      });
      return { artifactId: input.artifactId, version: input.expectedVersion + 1 };
    });
    return value;
  });
}
