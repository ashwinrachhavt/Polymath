import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documentExtractions, documents, projectSources, projects, sources } from "./schema";
import { agentRuns } from "@/domains/agents/schema";

/*
 * Projects: a name plus a set of documents in this workspace. A project is a
 * boundary, so it only ever holds documents the caller's workspace owns:
 * attaching a foreign or unknown id fails the whole command and writes nothing.
 * Each attachment pins the document's latest succeeded extraction hash, so the
 * project says which version of the text it was built from.
 */

export class ProjectError extends Error {
  constructor(public readonly code: "documents_not_found" | "project_not_found" | "invalid_name", message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function sourceFor(tx: Tx, auth: AuthContext, doc: { fileId: string | null; title: string }): Promise<string> {
  if (doc.fileId) {
    const [existing] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.workspaceId, auth.workspaceId), eq(sources.fileId, doc.fileId), eq(sources.kind, "document")))
      .limit(1);
    if (existing) return existing.id;
  }
  const [created] = await tx
    .insert(sources)
    .values({ workspaceId: auth.workspaceId, kind: "document", title: doc.title, fileId: doc.fileId, createdBy: auth.userId, updatedBy: auth.userId })
    .returning({ id: sources.id });
  return created.id;
}

/** Attach inside an open transaction. Throws if any id is not a live document of this workspace. */
async function attach(tx: Tx, auth: AuthContext, projectId: string, documentIds: string[]) {
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return 0;
  const docs = await tx
    .select({ id: documents.id, fileId: documents.fileId, title: documents.title })
    .from(documents)
    .where(and(inArray(documents.id, ids), eq(documents.workspaceId, auth.workspaceId), sql`${documents.archivedAt} is null`));
  if (docs.length !== ids.length) {
    throw new ProjectError("documents_not_found", "One or more documents are not in this workspace.");
  }
  let attached = 0;
  for (const doc of docs) {
    const [latest] = await tx
      .select({ contentHash: documentExtractions.contentHash })
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, doc.id), eq(documentExtractions.workspaceId, auth.workspaceId), eq(documentExtractions.status, "succeeded")))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1);
    const sourceId = await sourceFor(tx, auth, doc);
    const rows = await tx
      .insert(projectSources)
      .values({ workspaceId: auth.workspaceId, projectId, sourceId, pinnedContentHash: latest?.contentHash ?? null })
      .onConflictDoNothing({ target: [projectSources.projectId, projectSources.sourceId] })
      .returning({ id: projectSources.id });
    attached += rows.length;
  }
  return attached;
}

export async function createProject(auth: AuthContext, input: { name: string; documentIds?: string[] }) {
  const name = input.name.trim();
  if (!name || name.length > 200) throw new ProjectError("invalid_name", "Give the project a name of up to 200 characters.");
  return withTransaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ workspaceId: auth.workspaceId, title: name, createdBy: auth.userId, updatedBy: auth.userId })
      .returning({ id: projects.id, title: projects.title });
    if (input.documentIds?.length) await attach(tx, auth, project.id, input.documentIds); // a foreign id throws and rolls the project back too
    return project;
  });
}

export async function attachDocuments(auth: AuthContext, input: { projectId: string; documentIds: string[] }) {
  return withTransaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!project) throw new ProjectError("project_not_found", "No such project.");
    return { attached: await attach(tx, auth, input.projectId, input.documentIds) };
  });
}

export async function listProjects(auth: AuthContext) {
  return db
    .select({
      id: projects.id,
      title: projects.title,
      emoji: projects.emoji,
      description: projects.description,
      pinnedAt: projects.pinnedAt,
      updatedAt: projects.updatedAt,
      documentCount: sql<number>`(select count(*)::int from ${projectSources} ps where ps.project_id = "projects"."id")`,
    })
    .from(projects)
    .where(and(eq(projects.workspaceId, auth.workspaceId), sql`${projects.archivedAt} is null`))
    .orderBy(desc(projects.updatedAt));
}

export async function setProjectPinned(auth: AuthContext, input: { projectId: string; pinned: boolean }) {
  const [row] = await db
    .update(projects)
    .set({ pinnedAt: input.pinned ? new Date() : null, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${projects.version} + 1` })
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, auth.workspaceId), sql`${projects.archivedAt} is null`))
    .returning({ id: projects.id, pinnedAt: projects.pinnedAt });
  if (!row) throw new ProjectError("project_not_found", "No such project.");
  return row;
}

export async function updateProject(
  auth: AuthContext,
  input: { projectId: string; title?: string; description?: string; instructions?: string; emoji?: string },
) {
  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: auth.userId, version: sql`${projects.version} + 1` };
  if (input.title !== undefined) {
    const name = input.title.trim();
    if (!name || name.length > 200) throw new ProjectError("invalid_name", "Give the project a name of up to 200 characters.");
    patch.title = name;
  }
  if (input.description !== undefined) patch.description = input.description.trim() || null;
  if (input.instructions !== undefined) patch.instructions = input.instructions.trim() || null;
  if (input.emoji !== undefined) patch.emoji = input.emoji.trim() || null;
  const [row] = await db
    .update(projects)
    .set(patch)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, auth.workspaceId), sql`${projects.archivedAt} is null`))
    .returning({ id: projects.id, title: projects.title, description: projects.description, instructions: projects.instructions, emoji: projects.emoji });
  if (!row) throw new ProjectError("project_not_found", "No such project.");
  return row;
}

/** The document ids a project holds, or null when the project is not in this workspace. */
export async function projectDocumentIds(auth: AuthContext, projectId: string): Promise<string[] | null> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!project) return null;
  const rows = await db
    .select({ id: documents.id })
    .from(projectSources)
    .innerJoin(sources, eq(sources.id, projectSources.sourceId))
    .innerJoin(documents, and(eq(documents.fileId, sources.fileId), eq(documents.workspaceId, auth.workspaceId)))
    .where(and(eq(projectSources.projectId, projectId), eq(projectSources.workspaceId, auth.workspaceId)));
  return [...new Set(rows.map((r) => r.id))];
}

/** One project with its documents, or null when it is not in this workspace. */
export async function getProjectDetail(auth: AuthContext, projectId: string) {
  const [project] = await db
    .select({
      id: projects.id,
      title: projects.title,
      description: projects.description,
      descriptionSeed: projects.descriptionSeed,
      instructions: projects.instructions,
      emoji: projects.emoji,
      pinnedAt: projects.pinnedAt,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, auth.workspaceId), sql`${projects.archivedAt} is null`))
    .limit(1);
  if (!project) return null;
  const docs = await db
    .select({ id: documents.id, title: documents.title, mimeType: documents.mimeType })
    .from(projectSources)
    .innerJoin(sources, eq(sources.id, projectSources.sourceId))
    .innerJoin(documents, and(eq(documents.fileId, sources.fileId), eq(documents.workspaceId, auth.workspaceId)))
    .where(and(eq(projectSources.projectId, projectId), eq(projectSources.workspaceId, auth.workspaceId)));
  const seen = new Set<string>();
  return { ...project, documents: docs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))) };
}

/** The workspace's filed documents, for the attach picker. */
/*
 * The documents a project can pick up. Each row carries its latest extraction
 * status so the picker can say which ones are unread yet (a project pins the
 * latest succeeded text, and a document without one contributes nothing).
 */
export async function listAttachableDocuments(auth: AuthContext) {
  const docs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), sql`${documents.archivedAt} is null`, sql`${documents.fileId} is not null`))
    .orderBy(desc(documents.createdAt))
    .limit(200);
  if (docs.length === 0) return docs.map((doc) => ({ ...doc, extractionStatus: null as string | null }));
  const extractions = await db
    .select({ documentId: documentExtractions.documentId, status: documentExtractions.status })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.workspaceId, auth.workspaceId), inArray(documentExtractions.documentId, docs.map((doc) => doc.id))))
    .orderBy(desc(documentExtractions.createdAt));
  const latest = new Map<string, string>();
  for (const row of extractions) if (!latest.has(row.documentId)) latest.set(row.documentId, row.status);
  return docs.map((doc) => ({ ...doc, extractionStatus: latest.get(doc.id) ?? null }));
}

/** The runs bound to a project (Studio Generate, research, and automations bind with a project subject), newest first. */
export async function listProjectRuns(auth: AuthContext, projectId: string, limit = 20) {
  return db
    .select({ id: agentRuns.id, state: agentRuns.state, objective: agentRuns.objective, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, auth.workspaceId), sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "project", id: projectId }])}::jsonb`))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}
