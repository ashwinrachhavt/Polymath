import { z } from "zod";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import {
  GenerationRequestError,
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, withQuota, type QuotaStore } from "@/integrations/providers/quota";
import { knownConceptsInstruction } from "./quiz-generator";
import { sourceWindow } from "./source-window";

type GeneratedFlashcard = {
  prompt: string;
  answer: string;
  quote: string;
  sourceIndex: number;
  /** The one idea the card tests, as a short name. A card without one is dropped. */
  concept?: string;
};
type FlashcardGeneratorSource = { title: string; text: string };
export interface FlashcardGenerator {
  readonly name: string;
  generateFromSources(
    sources: FlashcardGeneratorSource[],
    options: {
      cardCount: number;
      learningContext?: { missedQuestions: string[]; notHelpfulExamples: string[] };
      /** Prompts an earlier batch of this deck already made; the model writes new ones. */
      avoidPrompts?: string[];
      /** Which window of a long source this call reads (sourceWindow); batch k reads window k. */
      part?: number;
      /** Concept names this workspace already uses; the model reuses one when it fits. */
      knownConcepts?: string[];
    },
  ): Promise<{ cards: GeneratedFlashcard[] }>;
}
export const FLASHCARD_PROMPT_VERSION = "learning-flashcards@4";
const MAX_INPUT_CHARS = 12000;

const response = z.object({
  cards: z
    .array(
      z.object({
        prompt: z.string().min(1).max(400),
        answer: z.string().min(1).max(1000),
        quote: z.string().min(1).max(500),
        sourceIndex: z.number().int().nonnegative(),
        concept: z.string().optional(),
      }),
    )
    .min(1)
    .max(25),
});

const SYSTEM =
  "Create concise active-recall flashcards from only the supplied sources. Return JSON {cards:[{prompt,answer,quote,sourceIndex,concept}]}. Each card tests one important concept; concept names it as a short noun phrase of one to five words in the terms the source uses, never a sentence and never the source title, and cards on the same idea use the same name; avoid trivial facts, duplicates, and facts requiring outside knowledge. The quote must be a contiguous verbatim excerpt from the indicated source. Never invent or repair evidence. Return fewer cards rather than unsupported ones. " +
  untrustedDataClauseJsonSafe("source text");

function contextInstruction(context?: { missedQuestions: string[]; notHelpfulExamples: string[] }): string {
  if (!context) return "";
  const missed = context.missedQuestions.slice(0, 6).map((item) => item.slice(0, 180));
  const avoid = context.notHelpfulExamples.slice(0, 6).map((item) => item.slice(0, 180));
  if (missed.length === 0 && avoid.length === 0) return "";
  return ` Learner practice history (account-specific): make useful recall cards for these difficult concepts when the selected sources support them: ${JSON.stringify(missed)}. Do not repeat these cards because the learner rated their earlier deck not helpful: ${JSON.stringify(avoid)}.`;
}

function avoidInstruction(prompts: string[] = []): string {
  if (prompts.length === 0) return "";
  const bounded = prompts.map((prompt) => prompt.slice(0, 120));
  return ` This deck already has these cards, so write different ones that test other concepts: ${JSON.stringify(bounded)}.`;
}

function fromGeneration(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): FlashcardGenerator {
  return {
    name: provider.name,
    async generateFromSources(sources, options) {
      const perSourceLimit = Math.floor((MAX_INPUT_CHARS * 0.75) / sources.length);
      const bounded = sources.map((source, sourceIndex) => ({
        sourceIndex,
        title: source.title.slice(0, 120),
        text: sourceWindow(source.text, perSourceLimit, options.part),
      }));
      const system =
        SYSTEM +
        " Return exactly " +
        options.cardCount +
        " cards when the sources support them. Include the zero-based sourceIndex on every card." +
        contextInstruction(options.learningContext) +
        avoidInstruction(options.avoidPrompts) +
        knownConceptsInstruction(options.knownConcepts);
      try {
        const result = await run({ system, prompt: JSON.stringify({ sources: bounded }) });
        return response.parse(JSON.parse(result.text));
      } catch (cause) {
        if (cause instanceof GenerationRequestError)
          throw new Error("Flashcard generation failed (HTTP " + cause.status + ").");
        if (cause instanceof SyntaxError || cause instanceof z.ZodError)
          throw new Error("Flashcard generation returned an unreadable answer.");
        throw cause;
      }
    },
  };
}

export function defaultFlashcardGenerator(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): FlashcardGenerator {
  let provider: GenerationProvider;
  try {
    provider = generationProvider(env, fetchImpl);
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) throw new EmbeddingUnconfiguredError();
    throw cause;
  }
  const entry = providerEntry(provider.registryId);
  return fromGeneration(provider, (input) => {
    const call = () => provider.generate({ ...input, json: true });
    if (workspaceId && entry?.quota && entry.enabled) {
      return withQuota(quotaStore ?? drizzleQuotaStore(), entry, workspaceId, 1, call);
    }
    return call();
  });
}
