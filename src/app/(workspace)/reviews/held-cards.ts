import type { QueueCardData } from "./reviews-queue";

/*
 * Decided cards the queue keeps rendering after the action's revalidate
 * drops them from the server list. The decide action calls
 * revalidatePath("/reviews"), the refetched payload honors the current
 * filter, and the pending filter omits the just-decided card - patching
 * only listed items would unmount it in the same beat that its refusal or
 * import outcome arrives, taking the feedback with it. A held snapshot
 * carries that feedback - and only that - until the next real navigation,
 * where the persisted row says the same thing.
 *
 * Held only where there is post-decision feedback to show: an effect
 * outcome or a committed refusal. A decision-only success drains from the
 * pending queue on revalidation, by design.
 *
 * Keyed by (proposal, version), the decided overlay's key space: a fresh
 * version of the same proposal in the server list is the current truth and
 * the snapshot for its old version must never mask it - the merge skips a
 * held card whose proposal id is listed at ANY version.
 */
export type HeldCards = Record<string, QueueCardData>;

export function holdDecidedCard(held: HeldCards, item: QueueCardData, decision: "approved" | "rejected"): void {
  held[`${item.id}:${item.version}`] = { ...item, status: decision, decidedAt: new Date().toISOString() };
}

export function mergeHeldDecidedCards(listed: QueueCardData[], held: HeldCards): QueueCardData[] {
  const entries = Object.values(held);
  if (entries.length === 0) return listed;
  const listedIds = new Set(listed.map((item) => item.id));
  const heldRows = entries.filter((snapshot) => !listedIds.has(snapshot.id));
  return heldRows.length === 0 ? listed : [...listed, ...heldRows];
}
