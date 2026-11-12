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
export const CHALLENGE_PROMPT_VERSION = "learning-challenge@1";
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

/** A practice challenge as the model wrote it. The learning domain validates `content` and locates `evidence`. */
export type ProposedChallenge = { content: unknown; evidence: ProposedEvidence[] };
type ProposedChallengeFormat = "predict" | "bug_hunt";

export interface ExplainItGenerator {
  readonly name: string;
  start(sources: ExplainSource[]): Promise<ExplainQuestion>;
  challenge(format: ProposedChallengeFormat, sources: ExplainSource[]): Promise<ProposedChallenge>;
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
  nextConcept: z
    .string()
    .max(80)
    .nullish()
    .transform((value) => value ?? null),
});

const challengeResponse = z.object({
  content: z.record(z.string(), z.unknown()),
  evidence: evidenceSchema.min(1),
});

const TERMS_SHAPE =
  '{"kind":"terms","accept":[[phrase,...],...],"reject":[phrase,...]}: every accept group must be stated and a group is stated by any one of its phrases, so give each group three to eight short lowercase wordings a learner might use (two to five words each, whole words, with singular, plural and tense variants listed separately); reject holds short wordings of the common wrong answer and must never share a phrase with accept';

const CHALLENGE_SHARED =
  "objective is one plain sentence naming the single ability shown. answer is a complete model answer that states every accept group in its own words. rule is the principle from the source in one sentence. hints is three hints, least revealing first, the first never giving the answer. evidence is the contiguous verbatim passage of the indicated source that states the rule. Build the challenge on one rule the sources state outright, and ask about a new concrete case the sources do not spell out, so it cannot be answered by copying a sentence. Use no outside knowledge. ";

const CHALLENGE_SHAPES: Record<ProposedChallengeFormat, string> = {
  predict:
    'Write one "predict the outcome" practice challenge. Return JSON {content:{format:"predict",objective,situation,question,outcome,reason,answer,rule,hints},evidence:[{quote,sourceIndex}]}. situation is a concrete scenario of two to five sentences. question asks what happens next and why. outcome checks the predicted result and reason checks the explanation; each is ' +
    TERMS_SHAPE +
    ". ",
  bug_hunt:
    'Write one "find the bug" practice challenge. Return JSON {content:{format:"bug_hunt",objective,artifact:{kind,lines},question,fault,invariant,answer,rule,hints},evidence:[{quote,sourceIndex}]}. artifact.kind is "log" or "code"; artifact.lines is six to twenty short lines of a log or of generic pseudo-code that you write, in which exactly one line breaks a rule the sources state; never copy code from the sources. question asks which line goes wrong and which rule it breaks. fault is {"kind":"lines","lines":[n]} with the 1-based number of the faulty line. invariant checks the rule that was broken and is ' +
    TERMS_SHAPE +
    '. answer must name the faulty line as "line N". ',
};

function boundedSources(sources: ExplainSource[]) {
  const perSourceLimit = Math.floor((MAX_INPUT_CHARS * 0.75) / sources.length);
  return sources.map((source, sourceIndex) => ({
    sourceIndex,
    title: source.title.slice(0, 120),
    text: source.text.slice(0, perSourceLimit),
  }));
}

/** The generator over one provider. `run` is where a caller adds quota or metering around each call. */
function explainItGenerator(
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
    challenge(format, sources) {
      const system = CHALLENGE_SHAPES[format] + CHALLENGE_SHARED + untrustedDataClauseJsonSafe("sources");
      return call(system, JSON.stringify({ sources: boundedSources(sources) }), challengeResponse);
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
  return explainItGenerator(provider, (input) => {
    const call = () => provider.generate({ ...input, json: true });
    if (workspaceId && entry?.quota && entry.enabled) {
      return withQuota(quotaStore ?? drizzleQuotaStore(), entry, workspaceId, 1, call);
    }
    return call();
  });
}
