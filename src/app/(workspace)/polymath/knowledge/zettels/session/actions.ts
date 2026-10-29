"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import {
  addCardToSitting,
  createSitting,
  endSitting,
  getSitting,
} from "@/domains/knowledge/sittings";
import { commitNoteSnapshot, createNote } from "@/domains/knowledge/notes";

/*
 * Sitting server actions (plan §7): the shell talks to the server through
 * these; the creation stream itself lives on the §16.6 endpoint.
 */

/** New sitting (§14.1): create and land in the workspace with the cursor blinking. */
export async function createSittingAction(input: { topic?: string; sourceDocumentId?: string }) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const sitting = await createSitting(auth, {
    topic: input.topic?.trim() || undefined,
    // §7: seeding from the inbox flow passes a document reference; there is
    // no separate seed action.
    sourceContext: input.sourceDocumentId ? `document:${input.sourceDocumentId}` : undefined,
  });
  redirect(`/polymath/knowledge/zettels/session/${sitting.id}`);
}

export async function endSittingAction(input: { sittingId: string; closingReflection?: string }) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  await endSitting(auth, input.sittingId, input.closingReflection?.trim() || undefined);
}

const SaveCard = z.object({
  sittingId: z.string().uuid(),
  artifactId: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(8).max(200),
  title: z.string().max(500),
  content: z.unknown(),
  plainText: z.string(),
});

/*
 * Save-first (§3): the pause saves the draft as an artifact version and only
 * then does the creation run start. Double-submit creates one artifact
 * (§11): the idempotency key rides createNote/commitNoteSnapshot's receipt.
 */
export async function saveSittingCardAction(raw: unknown): Promise<{ artifactId: string; versionNumber: number } | { error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = SaveCard.safeParse(raw);
  if (!input.success) return { error: "invalid_input" };
  const sitting = await getSitting(auth, input.data.sittingId);
  if (!sitting) return { error: "sitting_not_found" };

  if (input.data.artifactId && input.data.expectedVersion) {
    const snapshot = await commitNoteSnapshot(auth, {
      idempotencyKey: input.data.idempotencyKey,
      artifactId: input.data.artifactId,
      expectedVersion: input.data.expectedVersion,
      content: input.data.content as never,
      plainText: input.data.plainText,
    });
    return { artifactId: input.data.artifactId, versionNumber: snapshot.versionNumber };
  }
  const created = await createNote(auth, {
    idempotencyKey: input.data.idempotencyKey,
    title: input.data.title.trim() || "Untitled",
    content: input.data.content as never,
    plainText: input.data.plainText,
    kind: "zettel",
  });
  await addCardToSitting(auth, { sittingId: sitting.id, artifactId: created.id, role: "created_here" });
  return { artifactId: created.id, versionNumber: 1 };
}
