"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { rateArtifact } from "@/domains/knowledge/artifact-feedback";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const inputSchema = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("artifact"), id: z.uuid() }),
    z.object({ kind: z.literal("quiz"), id: z.uuid() }),
    z.object({ kind: z.literal("flashcard_deck"), id: z.uuid() }),
  ]),
  rating: z.enum(["helpful", "not_helpful"]),
});

export async function rateArtifactAction(input: z.input<typeof inputSchema>) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Choose helpful or not helpful." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await rateArtifact(auth, parsed.data);
    revalidatePath("/artifacts");
    revalidatePath("/learn");
    return { ok: true as const, ...result };
  } catch (error) {
    return { ok: false as const, error: actionError(error, "Could not save your feedback.") };
  }
}
