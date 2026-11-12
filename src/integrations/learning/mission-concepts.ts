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

export const MISSION_CONCEPT_PROMPT_VERSION = "learning-mission-concepts@1";

const MAX_INPUT_CHARS = 12000;

/** The most concepts one Mission may plan. The bound is a product decision: a plan nobody finishes is not a plan. */
export const MAX_MISSION_CONCEPTS = 10;
const MIN_MISSION_CONCEPTS = 2;

type MissionSource = { title: string; text: string };

/**
 * A concept the model proposes, before verification. `sourceIndex` names the
 * source the passage came from; `quote` must be contiguous text of it. A
 * proposal that cannot be located is dropped by the domain, never stored.
 */
export type ProposedMissionConcept = { name: string; reason: string; quote: string; sourceIndex: number };

const conceptSchema = z.object({
  name: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(240),
  quote: z.string().min(1).max(500),
  sourceIndex: z.number().int().nonnegative(),
});

const responseSchema = z.object({ concepts: z.array(conceptSchema).min(1) });

function boundedSources(sources: MissionSource[]) {
  const perSourceLimit = Math.floor((MAX_INPUT_CHARS * 0.75) / sources.length);
  return sources.map((source, sourceIndex) => ({
    sourceIndex,
    title: source.title.slice(0, 120),
    text: source.text.slice(0, perSourceLimit),
  }));
}

export interface MissionConceptGenerator {
  readonly name: string;
  /**
   * Proposes at most MAX_MISSION_CONCEPTS short concept names for a goal, each
   * with a one-line reason and the passage it came from. `existing` are the
   * workspace's concepts already, so the model reuses a name rather than
   * making a near-duplicate.
   */
  propose(input: { goal: string; role: string | null; sources: MissionSource[]; existing: string[] }): Promise<{
    concepts: ProposedMissionConcept[];
  }>;
}

function missionConceptGenerator(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): MissionConceptGenerator {
  return {
    name: provider.name,
    async propose(input) {
      const system =
        `List the concepts a person must own to do this job by the date they named, drawn only from the provided sources. ` +
        `Return JSON {concepts:[{name,reason,quote,sourceIndex}]}. Give between ${MIN_MISSION_CONCEPTS} and ${MAX_MISSION_CONCEPTS} concepts, ` +
        `never more than ${MAX_MISSION_CONCEPTS}. Each name is a short noun phrase of one to four words in the sources' own terms; ` +
        `reuse an existing concept's exact name whenever it already names this idea. reason is one plain sentence saying why it matters for the goal. ` +
        `quote must be a contiguous verbatim passage of the source named by sourceIndex, and is what the concept was drawn from. ` +
        `Prefer ideas that need reasoning over facts to memorise. Never invent a concept the sources do not support. ` +
        untrustedDataClauseJsonSafe("sources");
      try {
        const result = await run({
          system,
          prompt: JSON.stringify({
            goal: input.goal.slice(0, 500),
            role: input.role?.slice(0, 2000) ?? null,
            existing: input.existing.slice(0, 60),
            sources: boundedSources(input.sources),
          }),
        });
        return responseSchema.parse(JSON.parse(result.text));
      } catch (cause) {
        if (cause instanceof GenerationRequestError)
          throw new Error("Making your concepts failed (HTTP " + cause.status + ").");
        if (cause instanceof SyntaxError || cause instanceof z.ZodError)
          throw new Error("Making your concepts returned an unreadable answer.");
        throw cause;
      }
    },
  };
}

export function defaultMissionConceptGenerator(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): MissionConceptGenerator {
  let provider: GenerationProvider;
  try {
    provider = generationProvider(env, fetchImpl);
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) throw new EmbeddingUnconfiguredError();
    throw cause;
  }
  const entry = providerEntry(provider.registryId);
  return missionConceptGenerator(provider, (input) => {
    const call = () => provider.generate({ ...input, json: true });
    if (workspaceId && entry?.quota && entry.enabled) {
      return withQuota(quotaStore ?? drizzleQuotaStore(), entry, workspaceId, 1, call);
    }
    return call();
  });
}
