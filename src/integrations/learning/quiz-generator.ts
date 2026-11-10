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
import { sourceWindow } from "./source-window";

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
  /** Verbatim supporting passage from its source. */
  quote: string;
  /** Zero-based index into the requested source manifest. */
  sourceIndex?: number;
};

type QuizGeneratorSource = { title: string; text: string };
type QuizGeneratorOptions = {
  questionCount?: number;
  learningContext?: { missedQuestions: string[]; notHelpfulExamples: string[] };
  /** Prompts an earlier batch of this quiz already asked; the model writes new ones. */
  avoidPrompts?: string[];
  /** Which window of a long source this call reads (sourceWindow); batch k reads window k. */
  part?: number;
};

export interface QuizGenerator {
  /** Recorded on the quiz row, e.g. "openrouter:openai/gpt-4o-mini". */
  readonly name: string;
  generate(extractionText: string, options?: QuizGeneratorOptions): Promise<{ questions: GeneratedQuestion[] }>;
  generateFromSources?(
    sources: QuizGeneratorSource[],
    options?: QuizGeneratorOptions,
  ): Promise<{ questions: GeneratedQuestion[] }>;
}

export const QUIZ_PROMPT_VERSION = "learn-quiz@6";

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
  sourceIndex: z.number().int().nonnegative().optional(),
});

const response = z.object({
  questions: z.array(questionSchema).min(1).max(25),
});

const SYSTEM = `You write a quiz over a document so a reader can check what they learned. Return JSON with exactly this shape: {"questions":[{"prompt","choices":[{"value","label"}],"answerValue","explanation","quote"}]}.
The user message is the document text, and it is your ONLY source. You may recognize the text from training - do not answer from memory anyway: every fact, every question, and every quote must come from the text you were given, exactly as printed there. If a question would need a part of the document that is not present in the text you received, drop it.
"prompt": one question answerable ONLY from the document - never a question about the document itself.
"choices": one correct option plus 2 to 4 wrong options. Each "label" is a bare claim - no justification inside an option; the reasoning belongs in "explanation". Write the correct claim first, then build each wrong option by mutating it from one specific, believable misconception, keeping the same sentence skeleton, length, and register, so the correct answer never leaks by format. Never "all of the above", never "none of the above". "value" is a short stable id for the option, unique within the question.
"answerValue": the correct option's "value", exactly.
"explanation": why the correct claim is true and the tempting wrong ones are not. Required.
"quote": a contiguous span of the provided text, copied character-for-character as printed there (punctuation, capitalization, spelling - including odd spacing or fragments from the source). Never reconstruct it from memory, never tidy it, never splice non-adjacent sentences. Keep it to one sentence, at most about 30 words. If no passage in the provided text supports a question, drop the question.
Never invent a fact, a quote, or a question to fill the shape; return fewer questions instead. ${untrustedDataClauseJsonSafe("article")}`;

function contextInstruction(context?: { missedQuestions: string[]; notHelpfulExamples: string[] }): string {
  if (!context) return "";
  const missed = context.missedQuestions.slice(0, 6).map((item) => item.slice(0, 180));
  const avoid = context.notHelpfulExamples.slice(0, 6).map((item) => item.slice(0, 180));
  if (missed.length === 0 && avoid.length === 0) return "";
  return ` Learner practice history (account-specific): revisit these concepts when the selected sources support them: ${JSON.stringify(missed)}. Avoid repeating these questions because the learner rated their earlier quiz not helpful: ${JSON.stringify(avoid)}.`;
}

function avoidInstruction(prompts: string[] = []): string {
  if (prompts.length === 0) return "";
  const bounded = prompts.map((prompt) => prompt.slice(0, 120));
  return ` This quiz already asks these questions, so write different ones that test other ideas: ${JSON.stringify(bounded)}.`;
}

function fromGeneration(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): QuizGenerator {
  async function call(system: string, prompt: string) {
    try {
      const out = await run({ system, prompt });
      return response.parse(JSON.parse(out.text));
    } catch (cause) {
      if (cause instanceof GenerationRequestError) {
        throw new Error(`Quiz generation failed (HTTP ${cause.status}).`);
      }
      if (cause instanceof SyntaxError || cause instanceof z.ZodError) {
        throw new Error("Quiz generation returned an unreadable answer.");
      }
      throw cause;
    }
  }

  return {
    name: provider.name,
    generate(text, options) {
      const system = `${SYSTEM}${options?.questionCount ? ` Generate exactly ${options.questionCount} questions when the source supports them.` : ""}${contextInstruction(options?.learningContext)}${avoidInstruction(options?.avoidPrompts)}`;
      return call(system, sourceWindow(text, MAX_INPUT_CHARS, options?.part));
    },
    generateFromSources(sources, options) {
      const perSourceLimit = Math.floor((MAX_INPUT_CHARS * 0.75) / sources.length);
      const bounded = sources.map((source, sourceIndex) => ({
        sourceIndex,
        title: source.title.slice(0, 120),
        text: sourceWindow(source.text, perSourceLimit, options?.part),
      }));
      const system = `${SYSTEM} Each question must include the zero-based sourceIndex for the one source that supports its answer and quote. Return that sourceIndex with every question.${options?.questionCount ? ` Generate exactly ${options.questionCount} questions when the sources support them.` : ""}${contextInstruction(options?.learningContext)}${avoidInstruction(options?.avoidPrompts)}`;
      return call(system, JSON.stringify({ sources: bounded }));
    },
  };
}

/*
 * The default generator: the resolved generation provider, with quota
 * admission when the provider carries a metered allowance and the workspace
 * is known. Each batch of a quiz is one request against the provider's daily cap.
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
