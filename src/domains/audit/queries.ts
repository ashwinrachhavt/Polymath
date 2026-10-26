import { desc, eq } from "drizzle-orm";
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
 */
export async function listWorkspaceActivity(auth: AuthContext, { limit = 50 }: { limit?: number } = {}): Promise<ActivityRow[]> {
  return db
    .select({
      action: auditEvents.action,
      actorKind: auditEvents.actorKind,
      subjectType: auditEvents.subjectType,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, auth.workspaceId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}
