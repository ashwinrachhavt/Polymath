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
  /**
   * Groups the audit rows of one use case (a capture conversion and the
   * proposal decision that drove it) so the read side can tell one story
   * without time-window heuristics. Opt-in per use case: historical rows
   * carry none and read conservatively.
   */
  operationId?: string;
};

/**
 * A system caller has no user: actorId is null and the audit row says so
 * (actorKind "system"). AuthContext still satisfies the door's context shape
 * (its userId string widens to null), but a request surface that wants to
 * audit as a person passes its AuthContext - the system shape stays a
 * deliberate choice at the call site, not something a request falls into.
 */
export type SystemAuditContext = { workspaceId: string; userId: null };

/**
 * The door's context is the minimal structural shape of an audit actor: the
 * workspace the row names and the user who acted (null for system callers).
 * AuthContext satisfies it structurally. One caller cannot: invitation
 * acceptance runs before the invitee has any workspace context, and writes
 * its row into the workspace being joined, naming the acceptor's id directly.
 */
export async function recordAudit(
  auth: { workspaceId: string; userId: string | null },
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
    operationId: input.operationId ?? null,
  });
}
