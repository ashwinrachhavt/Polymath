"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FlashcardError, generateFlashcardDeck, getFlashcardDeck, rateFlashcard } from "@/domains/learning/flashcards";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const projectIdSchema = z.uuid();
const generateSchema = z.object({
  projectId: z.uuid(),
  documentIds: z.array(z.uuid()).min(1).max(8),
  cardCount: z.number().int().min(3).max(15),
  idempotencyKey: z.uuid(),
});

export async function generateNotebookFlashcardsAction(input: z.input<typeof generateSchema>) {
  const parsed = generateSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Choose one to eight ready sources and 3 to 15 cards." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    if (!notebookSources || parsed.data.documentIds.some((id) => !notebookSources.includes(id))) {
      return { ok: false as const, error: "Choose sources that belong to this notebook." };
    }
    const result = await generateFlashcardDeck(auth, { ...parsed.data, notebookId: parsed.data.projectId });
    revalidatePath("/projects/" + parsed.data.projectId + "/notebook");
    return { ok: true as const, ...result };
  } catch (error) {
    if (error instanceof FlashcardError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not generate flashcards from these sources.") };
  }
}

export async function getNotebookFlashcardDeckAction(input: { projectId: string; deckId: string }) {
  const parsed = z.object({ projectId: projectIdSchema, deckId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "That flashcard deck is not available." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    const deck = await getFlashcardDeck(auth, parsed.data.deckId, true);
    if (
      !notebookSources ||
      !deck ||
      deck.notebookId !== parsed.data.projectId ||
      deck.sourceManifest.some((source) => !notebookSources.includes(source.documentId))
    ) {
      return { ok: false as const, error: "That flashcard deck is not in this notebook." };
    }
    return { ok: true as const, deck: { id: deck.id, title: deck.title, cards: deck.cards } };
  } catch (error) {
    return { ok: false as const, error: actionError(error, "Could not load this flashcard deck.") };
  }
}

const rateSchema = z.object({
  projectId: z.uuid(),
  deckId: z.uuid(),
  flashcardId: z.uuid(),
  rating: z.enum(["again", "hard", "good", "easy"]),
});

export async function rateNotebookFlashcardAction(input: z.input<typeof rateSchema>) {
  const parsed = rateSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Choose a valid flashcard rating." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    const deck = await getFlashcardDeck(auth, parsed.data.deckId);
    const belongs = deck?.cards.some((card) => card.id === parsed.data.flashcardId);
    if (
      !notebookSources ||
      !deck ||
      deck.notebookId !== parsed.data.projectId ||
      !belongs ||
      deck.sourceManifest.some((source) => !notebookSources.includes(source.documentId))
    ) {
      return { ok: false as const, error: "That flashcard is not in this notebook." };
    }
    const result = await rateFlashcard(auth, parsed.data);
    revalidatePath("/projects/" + parsed.data.projectId + "/notebook/flashcards");
    return { ok: true as const, dueAt: result.dueAt.toISOString() };
  } catch (error) {
    if (error instanceof FlashcardError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not save this flashcard rating.") };
  }
}
