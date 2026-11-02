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

/*
 * Turns a document's text into a short graded quiz (learn-harness
 * replication). Same discipline as the reading summarizer: the model
 * proposes questions pinned to verbatim quotes, the domain disposes -
 * verifyQuiz re-locates every quote and drops anything it cannot prove.
 * Model access goes through the generation seam with the shared quota
 * ledger, so an exhausted free allowance stops the call instead of falling
 * back to a paid route.
 *
 * The prompt encodes the source quiz extension's construction rules: every
 * option is a bare claim, distractors are mutations of the correct claim
 * from one believable misconception in the same skeleton and register (so
 * the answer never leaks by format), the explanation is required and
 * revealed only after answering, and grading anchors on option values, not
 * positions.
 */

export type GeneratedQuestion = {
  prompt: string;
  choices: Array<{ value: string; label: string }>;
  /** The correct choice's value, exactly. Verified against the choices. */
  answerValue: string;
  explanation: string;
  /** Verbatim supporting passage from the document. */
  quote: string;
};

export interface QuizGenerator {
  /** Recorded on the quiz row, e.g. "openrouter:openai/gpt-4o-mini". */
  readonly name: string;
  generate(extractionText: string): Promise<{ questions: GeneratedQuestion[] }>;
}

export const QUIZ_PROMPT_VERSION = "learn-quiz@2";

const MAX_INPUT_CHARS = 12_000;

const choiceSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

const questionSchema = z.object({
  prompt: z.string().min(1),
  choices: z.array(choiceSchema).min(2).max(5),
  // Deliberately unvalidated here: answerValue matching a choice's value is
  // verifyQuiz's job (the drop-and-count discipline), not a zod refinement.
  answerValue: z.string(),
  explanation: z.string().min(1),
  quote: z.string().min(1),
});

const response = z.object({
  questions: z.array(questionSchema).min(1).max(10),
});

const SYSTEM = `You write a short quiz over a document so a reader can check what they learned. Return JSON with exactly this shape: {"questions":[{"prompt","choices":[{"value","label"}],"answerValue","explanation","quote"}]}.
"prompt": one question answerable ONLY from the document - never a question about the document itself.
"choices": one correct option plus 2 to 4 wrong options. Each "label" is a bare claim - no justification inside an option; the reasoning belongs in "explanation". Write the correct claim first, then build each wrong option by mutating it from one specific, believable misconception, keeping the same sentence skeleton, length, and register, so the correct answer never leaks by format. Never "all of the above", never "none of the above". "value" is a short stable id for the option, unique within the question.
"answerValue": the correct option's "value", exactly.
"explanation": why the correct claim is true and the tempting wrong ones are not. Required.
"quote": the passage from the document, copied exactly as the reader sees it, that grounds the question. Keep it to one sentence, at most about 30 words. If no passage supports a question, drop the question.
3 to 6 questions. Never invent a fact, a quote, or a question to fill the shape. ${untrustedDataClauseJsonSafe("article")}`;

function fromGeneration(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): QuizGenerator {
  return {
    name: provider.name,
    async generate(text) {
      let out: { text: string };
      try {
        out = await run({ system: SYSTEM, prompt: text.slice(0, MAX_INPUT_CHARS) });
      } catch (cause) {
        if (cause instanceof GenerationRequestError) {
          throw new Error(`Quiz generation failed (HTTP ${cause.status}).`);
        }
        throw cause;
      }
      try {
        return response.parse(JSON.parse(out.text));
      } catch {
        throw new Error("Quiz generation returned an unreadable answer.");
      }
    },
  };
}

/*
 * The default generator: the resolved generation provider, with quota
 * admission when the provider carries a metered allowance and the workspace
 * is known. One quiz is one request against the provider's daily cap.
 */
export function defaultQuizGenerator(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): QuizGenerator {
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
