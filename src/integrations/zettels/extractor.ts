import { z } from "zod";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import {
  GenerationRequestError,
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { openRouterProvider } from "@/integrations/generation/openrouter";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, withQuota, type QuotaStore } from "@/integrations/providers/quota";

/*
 * Turns a document's text into candidate zettels: a title, the idea in the
 * model's own words - as long as that idea needs, never padded - and the
 * verbatim passage it rests on. The domain never trusts the result: it
 * re-locates the quote in the text and drops any candidate whose quote is not
 * really there. Model access goes through the generation seam (ASH-187): the
 * default is the workspace's existing OpenRouter route; GENERATION_PROVIDER=
 * gemini switches to the verified free tier, with each call reserving one
 * request from the shared quota ledger when a workspace is known.
 */

export type ZettelCandidate = { title: string; content: string; quote?: string };

export interface ZettelExtractor {
  /** The proposer recorded on the card, e.g. "openrouter:openai/gpt-4o-mini". */
  readonly name: string;
  /**
   * `options.max` is the size-derived proposal cap (capForSize) for the whole
   * source, applied to every section call of one pass. A model returning more
   * than the cap fails the parse and the pass retries — the cap is enforced,
   * not asked. The flat default is the historical prompt cap.
   */
  extract(text: string, options?: { max?: number }): Promise<ZettelCandidate[]>;
}

const MAX_INPUT_CHARS = 12_000;
const DEFAULT_MODEL = "openai/gpt-4o-mini";

const DEFAULT_CAP = 8;

const responseItem = z.object({
  title: z.string(),
  content: z.string(),
  quote: z.string().optional(),
});

/** The response contract at one call's cap: `.max` makes the cap enforced rather than asked. */
const responseSchema = (max: number) => z.object({ zettels: z.array(responseItem).max(max) });

const systemPrompt = (max: number) =>
  `You extract atomic notes from a document. Return JSON with exactly this shape: {"zettels":[{"title","content","quote"}]}.
Each zettel is ONE idea the document actually makes - one idea per note, no compound ideas.
"title": a short noun phrase (max 8 words) naming the idea.
"content": the idea, in your own words. As long as the idea needs - one sentence to a few paragraphs. Never pad, never truncate. Short ideas get short cards.
"quote": copied VERBATIM from the document - the exact passage that supports the idea, never paraphrased, never reconstructed from memory. Omit "quote" when no passage in the document supports the idea.
Return at most ${max}, strongest ideas first. Return {"zettels":[]} when the document makes no clear ideas - never invent an idea to fill the shape. ${untrustedDataClauseJsonSafe("document")}`;

function fromGeneration(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): ZettelExtractor {
  return {
    name: provider.name,
    async extract(text, options) {
      const max = options?.max ?? DEFAULT_CAP;
      let out: { text: string };
      try {
        out = await run({ system: systemPrompt(max), prompt: text.slice(0, MAX_INPUT_CHARS) });
      } catch (cause) {
        if (cause instanceof GenerationRequestError) {
          throw new Error(`Zettel extraction failed (HTTP ${cause.status}).`);
        }
        throw cause;
      }
      try {
        return responseSchema(max).parse(JSON.parse(out.text)).zettels;
      } catch {
        throw new Error("Zettel extraction returned an unreadable answer.");
      }
    },
  };
}

/** The pre-ASH-187 route, kept as the seam's OpenRouter preset: same model, same contract. */
export function openRouterZettelExtractor(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ZettelExtractor {
  const model = env.ZETTEL_MODEL || DEFAULT_MODEL;
  try {
    const provider = openRouterProvider(env, fetchImpl, model);
    return fromGeneration(provider, (input) => provider.generate({ ...input, json: true }));
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) throw new EmbeddingUnconfiguredError();
    throw cause;
  }
}

/*
 * The default extractor: the resolved generation provider, with quota
 * admission when the provider carries a metered allowance and the workspace
 * is known. One extraction is one request against the provider's daily cap;
 * an exhausted free allowance stops the run instead of falling back to a
 * paid route.
 */
export function defaultZettelExtractor(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): ZettelExtractor {
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
