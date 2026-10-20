"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { approveItem, approveItems, createDeck, generateQuiz, recordAttempt, retireItem } from "@/domains/learning/commands";
import { LEARNING_RESULTS } from "@/domains/learning/commands";
import type { LearningResult } from "@/domains/learning/sm2";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The learning surface's mutations (NotebookLM parity, S4). Every one is a
 * member-or-above write; generation is the only expensive call and it runs
 * inside the request because a quiz batch is two provider calls, not a crawl.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const revalidate = () => revalidatePath("/alfred/learning");

export async function createDeckAction(input: { name: string; description?: string }) {
  const auth = await authorize();
  const parsed = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional() }).parse(input);
  const deck = await createDeck(auth, parsed);
  revalidate();
  return deck;
}

export async function generateQuizAction(input: { deckId: string; documentId: string; count?: number }) {
  const auth = await authorize();
  const parsed = z
    .object({ deckId: z.uuid(), documentId: z.uuid(), count: z.number().int().min(1).max(20).optional() })
    .parse(input);
  const out = await generateQuiz(auth, parsed);
  revalidate();
  return out;
}

export async function approveItemAction(input: { itemId: string }) {
  const auth = await authorize();
  const parsed = z.object({ itemId: z.uuid() }).parse(input);
  const out = await approveItem(auth, parsed);
  revalidate();
  return out;
}

export async function approveItemsAction(input: { itemIds: string[] }) {
  const auth = await authorize();
  const parsed = z.object({ itemIds: z.array(z.uuid()).min(1).max(100) }).parse(input);
  const out = await approveItems(auth, parsed);
  revalidate();
  return out;
}

export async function retireItemAction(input: { itemId: string; reason?: string }) {
  const auth = await authorize();
  const parsed = z.object({ itemId: z.uuid(), reason: z.string().trim().max(300).optional() }).parse(input);
  const out = await retireItem(auth, parsed);
  revalidate();
  return out;
}

export async function recordAttemptAction(input: { itemId: string; result: LearningResult; idempotencyKey: string; durationMs?: number }) {
  const auth = await authorize();
  const parsed = z
    .object({
      itemId: z.uuid(),
      result: z.enum(LEARNING_RESULTS as unknown as [LearningResult, ...LearningResult[]]),
      idempotencyKey: z.uuid(),
      durationMs: z.number().int().min(0).max(600_000).optional(),
    })
    .parse(input);
  const out = await recordAttempt(auth, parsed);
  revalidate();
  return out;
}
