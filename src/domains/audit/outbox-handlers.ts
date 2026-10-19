import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { extractDocument } from "@/domains/knowledge/extraction";
import { memberships } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import type { OutboxHandler } from "./outbox";

/*
 * Consumers for the outbox dispatcher (ASH-134 Q03). Intake queues
 * `document.extraction_requested` in the same transaction as the upload; this
 * is the first consumer that turns it into work. Delivery is at-least-once, so
 * the handler leans on extractDocument's own claim: a succeeded extraction for
 * the same content hash returns deduplicated instead of calling the provider.
 */

/** The actor for background work: the workspace's earliest active owner. Null when none exists. */
export async function workspaceOwnerAuth(workspaceId: string): Promise<AuthContext | null> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(
      eq(memberships.workspaceId, workspaceId),
      eq(memberships.role, "owner"),
      eq(memberships.status, "active"),
    ))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row ? { userId: row.userId, workspaceId, role: "owner" } : null;
}

export const extractionRequestedHandler: OutboxHandler = async (event) => {
  const payload = event.payload as { documentId?: unknown } | null;
  const documentId = typeof payload?.documentId === "string" ? payload.documentId : null;
  // A malformed or fileless intent can never succeed; completing it avoids
  // five pointless retries before dead-lettering.
  if (!documentId) return;
  const auth = await workspaceOwnerAuth(event.workspaceId);
  if (!auth) throw new Error("workspace has no active owner to act for the extraction");
  const result = await extractDocument(auth, { documentId });
  // `in_progress` elsewhere throws nothing; a provider failure is recorded on
  // the extraction row and is retried by redelivery, so surface it.
  if (!result.ok) throw new Error(result.error);
};

export const outboxHandlers: Record<string, OutboxHandler> = {
  "document.extraction_requested": extractionRequestedHandler,
};
