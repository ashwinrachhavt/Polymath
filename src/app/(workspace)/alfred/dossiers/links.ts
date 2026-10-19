import { and, desc, eq } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import { companies, contacts } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { artifactLinks, artifacts } from "@/domains/knowledge/schema";
import { StudioError, type DraftLinkRow } from "@/domains/knowledge/studio";
import { opportunities } from "@/domains/opportunities/schema";
import { tasks } from "@/domains/work/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";

/*
 * Attaching a Studio draft to the record it informs. This module lives at the
 * app layer because it crosses domains: the link row is knowledge's, and the
 * targets are work tasks, CRM contacts, and opportunities.
 */

export const DRAFT_LINK_TARGETS = ["task", "contact", "company", "opportunity"] as const;
export type DraftLinkTarget = (typeof DRAFT_LINK_TARGETS)[number];

/** The picklist for the attach control: a few recent records of each kind. */
export async function listLinkableRecords(auth: AuthContext) {
  const [taskRows, contactRows, companyRows, opportunityRows] = await Promise.all([
    db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.workspaceId, auth.workspaceId)).orderBy(desc(tasks.updatedAt)).limit(12),
    db
      .select({ id: contacts.id, title: contacts.fullName })
      .from(contacts)
      .where(eq(contacts.workspaceId, auth.workspaceId))
      .orderBy(desc(contacts.updatedAt))
      .limit(12),
    db
      .select({ id: companies.id, title: companies.name })
      .from(companies)
      .where(eq(companies.workspaceId, auth.workspaceId))
      .orderBy(desc(companies.updatedAt))
      .limit(12),
    db
      .select({ id: opportunities.id, title: opportunities.title })
      .from(opportunities)
      .where(eq(opportunities.workspaceId, auth.workspaceId))
      .orderBy(desc(opportunities.updatedAt))
      .limit(12),
  ]);
  return { task: taskRows, contact: contactRows, company: companyRows, opportunity: opportunityRows };
}

async function targetExists(workspaceId: string, targetType: DraftLinkTarget, targetId: string): Promise<boolean> {
  if (targetType === "task") {
    const [row] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, targetId), eq(tasks.workspaceId, workspaceId))).limit(1);
    return !!row;
  }
  if (targetType === "contact") {
    const [row] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, targetId), eq(contacts.workspaceId, workspaceId))).limit(1);
    return !!row;
  }
  if (targetType === "company") {
    const [row] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, targetId), eq(companies.workspaceId, workspaceId))).limit(1);
    return !!row;
  }
  const [row] = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.id, targetId), eq(opportunities.workspaceId, workspaceId))).limit(1);
  return !!row;
}

export async function linkDraftToRecord(auth: AuthContext, input: { artifactId: string; targetType: DraftLinkTarget; targetId: string }) {
  const [artifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!artifact) throw new StudioError("draft_not_found", "No such draft.");
  if (!(await targetExists(auth.workspaceId, input.targetType, input.targetId))) {
    throw new StudioError("record_not_found", "That record was not found.");
  }
  await withTransaction(async (tx) => {
    await tx
      .insert(artifactLinks)
      .values({ workspaceId: auth.workspaceId, artifactId: input.artifactId, targetType: input.targetType, targetId: input.targetId, label: null })
      .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "draft.record.linked",
      subjectType: "artifact",
      subjectId: input.artifactId,
      summary: `Attached Studio draft to a ${input.targetType}`,
    });
  });
}

export async function unlinkDraftFromRecord(auth: AuthContext, input: { artifactId: string; linkId: string }) {
  await withTransaction(async (tx) => {
    await tx
      .delete(artifactLinks)
      .where(and(eq(artifactLinks.id, input.linkId), eq(artifactLinks.artifactId, input.artifactId), eq(artifactLinks.workspaceId, auth.workspaceId)));
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "draft.record.unlinked",
      subjectType: "artifact",
      subjectId: input.artifactId,
      summary: "Detached Studio draft from a record",
    });
  });
}

/** Resolves display titles for a draft's record links, keyed by link id. */
export async function resolveLinkTitles(auth: AuthContext, links: DraftLinkRow[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const byType = new Map<string, string[]>();
  for (const link of links) {
    byType.set(link.targetType, [...(byType.get(link.targetType) ?? []), link.targetId]);
  }
  const titles = new Map<string, string>();
  const taskIds = byType.get("task") ?? [];
  if (taskIds.length) {
    const rows = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.workspaceId, auth.workspaceId));
    for (const r of rows) if (taskIds.includes(r.id)) titles.set(r.id, r.title);
  }
  const companyIds = byType.get("company") ?? [];
  if (companyIds.length) {
    const rows = await db.select({ id: companies.id, title: companies.name }).from(companies).where(eq(companies.workspaceId, auth.workspaceId));
    for (const r of rows) if (companyIds.includes(r.id)) titles.set(r.id, r.title);
  }
  const contactIds = byType.get("contact") ?? [];
  if (contactIds.length) {
    const rows = await db.select({ id: contacts.id, title: contacts.fullName }).from(contacts).where(eq(contacts.workspaceId, auth.workspaceId));
    for (const r of rows) if (contactIds.includes(r.id)) titles.set(r.id, r.title);
  }
  const opportunityIds = byType.get("opportunity") ?? [];
  if (opportunityIds.length) {
    const rows = await db.select({ id: opportunities.id, title: opportunities.title }).from(opportunities).where(eq(opportunities.workspaceId, auth.workspaceId));
    for (const r of rows) if (opportunityIds.includes(r.id)) titles.set(r.id, r.title);
  }
  for (const link of links) out[link.id] = titles.get(link.targetId) ?? "Untitled";
  return out;
}
