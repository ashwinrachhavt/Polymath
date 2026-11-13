"use server";

import { z } from "zod";
import { rateOutput, type Rating } from "@/domains/feedback/ratings";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const outputSchema = z.discriminatedUnion("surface", [
  z
    .object({
      surface: z.literal("chat"),
      runId: z.uuid(),
      sequence: z.number().int().min(0).optional(),
      turnId: z.string().min(1).max(200).optional(),
    })
    .refine((value) => value.sequence !== undefined || value.turnId !== undefined),
  z.object({ surface: z.enum(["run", "quiz", "flashcards", "explain", "artifact"]), id: z.uuid() }),
]);

const inputSchema = z.object({
  output: outputSchema,
  // 0 is a run's thumbs-down; rateOutput refuses it on any other surface.
  score: z.number().int().min(0).max(5).nullable(),
  comment: z.string().max(1000).nullable().optional(),
});

export type RateOutputInput = z.input<typeof inputSchema>;
export type RateOutputResult = { ok: true; rating: Rating | null } | { ok: false; error: string };

/** The one write every rating control calls; see domains/feedback/ratings.ts. */
export async function rateOutputAction(input: RateOutputInput): Promise<RateOutputResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That rating could not be read." };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const result = await rateOutput(auth, parsed.data);
    if (!result) return { ok: false, error: "That answer is no longer available to rate." };
    return { ok: true, rating: result.rating };
  } catch (error) {
    return { ok: false, error: actionError(error, "Your rating was not saved.") };
  }
}
