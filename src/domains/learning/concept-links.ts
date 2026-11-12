import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { conceptKey, resolveConceptIds } from "@/domains/knowledge/concepts";
import type { TxDrizzle } from "@/lib/db-transaction";
import { conceptLinks } from "./schema";

/** The one item a concept link points at. */
type LinkedItem = { quizQuestionId: string } | { flashcardId: string } | { explainTurnId: string };

/**
 * Record what each new item is about, in the transaction that stores the item.
 * Names resolve to the workspace's concept ids (created when new), so two
 * items that name the same idea share one id.
 */
export async function linkItemsToConcepts(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  tx: TxDrizzle,
  items: ReadonlyArray<LinkedItem & { concept: string }>,
): Promise<void> {
  if (items.length === 0) return;
  const ids = await resolveConceptIds(
    auth,
    items.map((item) => item.concept),
    tx,
  );
  const rows = items.flatMap(({ concept, ...item }) => {
    const conceptId = ids.get(conceptKey(concept));
    return conceptId ? [{ workspaceId: auth.workspaceId, conceptId, ...item }] : [];
  });
  if (rows.length > 0) await tx.insert(conceptLinks).values(rows).onConflictDoNothing();
}

/** A follow-up question that names no concept of its own stays on the concept of the question it follows. */
export async function carryTurnConcepts(
  auth: Pick<AuthContext, "workspaceId">,
  tx: TxDrizzle,
  input: { fromTurnId: string; toTurnId: string },
): Promise<void> {
  const prior = await tx
    .select({ conceptId: conceptLinks.conceptId })
    .from(conceptLinks)
    .where(and(eq(conceptLinks.workspaceId, auth.workspaceId), eq(conceptLinks.explainTurnId, input.fromTurnId)));
  if (prior.length === 0) return;
  await tx
    .insert(conceptLinks)
    .values(
      prior.map(({ conceptId }) => ({ workspaceId: auth.workspaceId, conceptId, explainTurnId: input.toTurnId })),
    )
    .onConflictDoNothing();
}
