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

export const EXPLAIN_IT_PROMPT_VERSION = "learning-explain-it@2";
const MAX_INPUT_CHARS = 12000;

export type ExplainSource = { title: string; text: string };
export type ProposedEvidence = { quote: string; sourceIndex: number };
/** `concept` is the one idea the question asks about, as a short name. */
export type ExplainQuestion = { prompt: string; evidence: ProposedEvidence[]; concept: string };
type ExplainGrade = "correct" | "partial" | "incorrect" | "uncertain";
export type ExplainEvaluation = {
  grade: ExplainGrade;
  feedback: string;
  evidence: ProposedEvidence[];
  nextQuestion: string | null;
  nextEvidence: ProposedEvidence[];
  /** The idea the next question asks about; null keeps the current question's concept. */
  nextConcept: string | null;
};

export interface ExplainItGenerator {
  readonly name: string;
  start(sources: ExplainSource[]): Promise<ExplainQuestion>;
  evaluate(input: {
    sources: ExplainSource[];
    question: string;
    answer: string;
    history: Array<{ question: string; answer: string; grade: ExplainGrade | null }>;
  }): Promise<ExplainEvaluation>;
}

const evidenceSchema = z
  .array(
    z.object({
      quote: z.string().min(1).max(500),
      sourceIndex: z.number().int().nonnegative(),
    }),
  )
  .max(3);

const startResponse = z.object({
  prompt: z.string().min(1).max(600),
  evidence: evidenceSchema.min(1),
  concept: z.string().trim().min(1).max(80),
});

const evaluationResponse = z.object({
  grade: z.enum(["correct", "partial", "incorrect", "uncertain"]),
  feedback: z.string().min(1).max(1200),
  evidence: evidenceSchema,
  nextQuestion: z.string().max(600).nullable(),
  nextEvidence: evidenceSchema,
  nextConcept: z.string().max(80).nullish().transform((value) => value ?? null),
});

function boundedSources(sources: ExplainSource[]) {
  const perSourceLimit = Math.floor((MAX_INPUT_CHARS * 0.75) / sources.length);
  return sources.map((source, sourceIndex) => ({
    sourceIndex,
    title: source.title.slice(0, 120),
    text: source.text.slice(0, perSourceLimit),
  }));
}

function fromGeneration(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): ExplainItGenerator {
  async function call<T>(system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
    try {
      const result = await run({ system, prompt });
      return schema.parse(JSON.parse(result.text));
    } catch (cause) {
      if (cause instanceof GenerationRequestError)
        throw new Error("Explain It generation failed (HTTP " + cause.status + ").");
      if (cause instanceof SyntaxError || cause instanceof z.ZodError)
        throw new Error("Explain It returned an unreadable answer.");
      throw cause;
    }
  }

  return {
    name: provider.name,
    start(sources) {
      const system =
        "Create one guided own-words question answerable from the provided selected sources only. Return JSON {prompt,evidence:[{quote,sourceIndex}],concept}. concept names the one idea the question asks about as a short noun phrase of one to five words in the source's own terms. The evidence must be a contiguous verbatim quote from the indicated source. Ask for reasoning, not recall of a trivial phrase. Use no outside knowledge. " +
        untrustedDataClauseJsonSafe("sources");
      return call(system, JSON.stringify({ sources: boundedSources(sources) }), startResponse);
    },
    evaluate(input) {
      const system =
        "Assess the learner's answer only against the provided selected sources and the question. Return JSON {grade,feedback,evidence:[{quote,sourceIndex}],nextQuestion,nextEvidence:[{quote,sourceIndex}],nextConcept}. nextConcept names the idea the next question asks about as a short noun phrase, or is null when there is no next question. grade is correct, partial, incorrect, or uncertain. Cite exact source passages for the assessment. Say when evidence is ambiguous or selected sources conflict; name each source and explain its claim. Never call an answer correct based on outside knowledge. Adapt the next question to the learner's demonstrated gap. If there is no grounded next question, return null and an empty nextEvidence. " +
        untrustedDataClauseJsonSafe("sources and learner answer");
      return call(
        system,
        JSON.stringify({
          sources: boundedSources(input.sources),
          question: input.question,
          answer: input.answer.slice(0, 5000),
          history: input.history.slice(-4),
        }),
        evaluationResponse,
      );
    },
  };
}

export function defaultExplainItGenerator(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): ExplainItGenerator {
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
