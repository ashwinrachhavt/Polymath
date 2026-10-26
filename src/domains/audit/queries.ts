import { and, desc, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";
import { auditEvents } from "./schema";

export type ActivityRow = {
  action: string;
  actorKind: string;
  subjectType: string;
  summary: string;
  createdAt: Date;
};

/*
 * The workspace's own audit feed, newest first. Every domain already writes
 * these rows through recordAudit; this is the read surface the Activity rail
 * never had (the rail read a browser-local preview log instead). Same
 * audience as every workspace surface - the per-document history read in
 * library.ts is the existing precedent.
 *
 * The feed widens nothing:
 *
 * - PRIVATE_SUBJECT_TYPES keeps private Supervisor exchanges out. A thread
 *   is one member's private assistant conversation (respond.ts refuses to
 *   project it into shared knowledge for exactly that reason), and its audit
 *   summaries can carry the member's own query text. Workspace membership is
 *   not authorization to read those, so thread events never join the feed.
 * - sanitizeSummary applies action-specific projection. The only callsite
 *   that embeds a freeform field not otherwise visible to every member is
 *   integration.connection_failed, whose reason string comes off the wire
 *   from the provider attempt; the feed keeps the established-visible
 *   "Connection failed: provider as alias" prefix and drops the reason.
 * - Raw metadata payloads and subject ids are never selected at all.
 */
const PRIVATE_SUBJECT_TYPES = ["thread"] as const;

export function sanitizeSummary(action: string, summary: string): string {
  if (action === "integration.connection_failed") {
    const cut = summary.indexOf(" — ");
    return cut === -1 ? summary : summary.slice(0, cut);
  }
  return summary;
}

export async function listWorkspaceActivity(auth: AuthContext, { limit = 50 }: { limit?: number } = {}): Promise<ActivityRow[]> {
  const rows = await db
    .select({
      action: auditEvents.action,
      actorKind: auditEvents.actorKind,
      subjectType: auditEvents.subjectType,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, auth.workspaceId), notInArray(auditEvents.subjectType, [...PRIVATE_SUBJECT_TYPES])))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, summary: sanitizeSummary(row.action, row.summary) }));
}
