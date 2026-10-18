import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { AgentEngine } from "@/domains/agents/engine";
import { agentRuns, runEvents } from "@/domains/agents/schema";
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
  constructor(public readonly code: "dossier_not_found" | "run_not_found" | "no_output" | "not_a_draft", message: string) {
    super(message);
    this.name = "StudioError";
  }
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
export async function saveGeneratedDraft(auth: AuthContext, input: { runId: string; title?: string }) {
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
        kind: "report",
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
