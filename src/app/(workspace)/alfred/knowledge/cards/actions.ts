"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acceptCard, proposeCard, resumeCard, retireCard, reviewCard, suspendCard } from "@/domains/knowledge/cards";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The cards surface's mutations. Deciding is a write, so every action
 * requires member or above. The domain commands carry the real guards
 * (workspace scope, expected version, allowed-from states); these actions
 * only authenticate, parse, and revalidate.
 */

const uuid = z.string().uuid();

const transitionSchema = z.object({
  cardId: uuid,
  expectedVersion: z.number().int().positive(),
  idempotencyKey: uuid.optional(),
});

const revalidate = () => revalidatePath("/alfred/knowledge/cards");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export async function proposeCardAction(input: unknown) {
  const parsed = z
    .object({
      prompt: z.string().trim().min(1).max(2000),
      answer: z.string().trim().min(1).max(4000),
      artifactId: uuid,
      idempotencyKey: uuid.optional(),
    })
    .parse(input);
  const auth = await authorize();
  const card = await proposeCard(auth, parsed);
  revalidate();
  return card;
}

export async function acceptCardAction(input: unknown) {
  const parsed = transitionSchema.parse(input);
  const auth = await authorize();
  await acceptCard(auth, parsed);
  revalidate();
}

export async function suspendCardAction(input: unknown) {
  const parsed = transitionSchema.parse(input);
  const auth = await authorize();
  await suspendCard(auth, parsed);
  revalidate();
}

export async function resumeCardAction(input: unknown) {
  const parsed = transitionSchema.parse(input);
  const auth = await authorize();
  await resumeCard(auth, parsed);
  revalidate();
}

export async function retireCardAction(input: unknown) {
  const parsed = transitionSchema.parse(input);
  const auth = await authorize();
  await retireCard(auth, parsed);
  revalidate();
}

export async function reviewCardAction(input: unknown) {
  const parsed = transitionSchema
    .extend({
      outcome: z.enum(["correct", "wrong"]),
      responseText: z.string().trim().max(4000).optional(),
      durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
    })
    .parse(input);
  const auth = await authorize();
  const result = await reviewCard(auth, parsed);
  revalidate();
  return result;
}
