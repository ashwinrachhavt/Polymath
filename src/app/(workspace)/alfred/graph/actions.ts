"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SynthesisError, synthesizeZettel } from "@/domains/knowledge/notes";
import { linkCards } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/* Graph canvas writes: tie two cards, or combine several into one new zettel. */

const linkInput = z.object({ artifactId: z.string().uuid(), targetId: z.string().uuid() });
const combineInput = z.object({
  sourceIds: z.array(z.string().uuid()).min(2).max(8),
  title: z.string().trim().max(300).optional(),
  idempotencyKey: z.string().uuid().optional(),
});

type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };

export async function linkCardsAction(input: z.input<typeof linkInput>): Promise<Result<object>> {
  const parsed = linkInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Those cards cannot be linked." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await linkCards(auth, parsed.data);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not link those cards." };
  }
  revalidatePath("/alfred/graph");
  revalidatePath("/alfred/notebook");
  return { ok: true };
}

export async function combineCardsAction(input: z.input<typeof combineInput>): Promise<Result<{ id: string }>> {
  const parsed = combineInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick two to eight cards to combine." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const created = await synthesizeZettel(auth, parsed.data);
    revalidatePath("/alfred/graph");
    revalidatePath("/alfred/notebook");
    return { ok: true, id: created.id };
  } catch (error) {
    if (error instanceof SynthesisError) return { ok: false, error: error.message };
    throw error;
  }
}
