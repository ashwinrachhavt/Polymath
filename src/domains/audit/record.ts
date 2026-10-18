import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { auditEvents } from "./schema";

/*
 * One audit write. A change with no audit row did not happen, which makes this
 * the most-called insert in the codebase and the one place the row's shape
 * should live. Passing `tx` keeps it in the caller's transaction, which is the
 * rule: the audit row commits with the change or not at all.
 */

export type AuditInput = {
  action: string;
  subjectType: string;
  subjectId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  actorKind?: "user" | "system" | "agent";
};

export async function recordAudit(
  auth: AuthContext,
  input: AuditInput,
  tx: TxDrizzle | typeof db = db,
) {
  await tx.insert(auditEvents).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    actorKind: input.actorKind ?? "user",
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    summary: input.summary,
    metadata: input.metadata ?? null,
  });
}
