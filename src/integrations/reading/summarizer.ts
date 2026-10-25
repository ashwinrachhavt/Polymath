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
 * Turns a document's text into a structured reading summary (ASH-292): one
 * paragraph, the document's key claims each pinned to a verbatim quote, and
 * the questions the document leaves open. Same discipline as the zettel
 * extractor: the model proposes, the domain disposes - quotes are
 * re-located in the text and anything unverifiable is dropped. Model access
 * goes through the generation seam with the shared quota ledger, so an
 * exhausted free allowance stops the call instead of falling back to a paid
 * route.
 */

export type ReadingSummaryClaim = { claim: string; quote: string };

export type ReadingSummary = {
  /** One short paragraph. */
  summary: string;
  keyClaims: ReadingSummaryClaim[];
  openQuestions: string[];
};

export interface ReadingSummarizer {
  /** Recorded on the artifacts the summary produces, e.g. "openrouter:openai/gpt-4o-mini". */
  readonly name: string;
  summarize(text: string): Promise<ReadingSummary>;
}

const MAX_INPUT_CHARS = 12_000;

const response = z.object({
  summary: z.string(),
  keyClaims: z.array(z.object({ claim: z.string(), quote: z.string() })),
  openQuestions: z.array(z.string()),
});

const SYSTEM = `You summarize a document for a reader deciding what it is worth. Return JSON with exactly this shape: {"summary","keyClaims":[{"claim","quote"}],"openQuestions":[...]}.
"summary": ONE short paragraph - what the document is and what it says, no preamble.
"keyClaims": the document's strongest claims, one idea each, in your own words, each with "quote" copied VERBATIM from the document - the exact passage that supports the claim. If a claim has no supporting passage, drop it. At most 7.
"openQuestions": what the document leaves unresolved or invites the reader to check, as questions. At most 5; an empty list is an honest answer.
Never invent a claim, a quote, or a question to fill the shape. ${untrustedDataClauseJsonSafe("document")}`;

function fromGeneration(provider: GenerationProvider, run: (input: { system: string; prompt: string }) => Promise<{ text: string }>): ReadingSummarizer {
  return {
    name: provider.name,
    async summarize(text) {
      let out: { text: string };
      try {
        out = await run({ system: SYSTEM, prompt: text.slice(0, MAX_INPUT_CHARS) });
      } catch (cause) {
        if (cause instanceof GenerationRequestError) {
          throw new Error(`Reading summary failed (HTTP ${cause.status}).`);
        }
        throw cause;
      }
      try {
        return response.parse(JSON.parse(out.text));
      } catch {
        throw new Error("Reading summary returned an unreadable answer.");
      }
    },
  };
}

/*
 * The default summarizer: the resolved generation provider, with quota
 * admission when the provider carries a metered allowance and the workspace
 * is known. One summary is one request against the provider's daily cap.
 */
export function defaultReadingSummarizer(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): ReadingSummarizer {
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
