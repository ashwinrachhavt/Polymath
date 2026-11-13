import { z } from "zod";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { resolveGeneration } from "@/domains/billing/resolver";
import { GenerationRequestError, type GenerationProvider } from "@/integrations/generation/provider";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, withQuota, type QuotaStore } from "@/integrations/providers/quota";

/*
 * Turns a diff and the coding session's own account of it into the parts of
 * an explainer. The model never sees the person's other notes; it sees the
 * diff (bounded), the session summary, and the names of concepts the person
 * already has, so it can skip them. Model access goes through the generation
 * seam with the shared quota ledger, like every other generator.
 */

type ExplainerInput = {
  repo: string;
  commit: string;
  summary: string;
  diff: string;
  /** Concepts the person already understands; background on them is skipped. */
  knownConcepts: string[];
};

const partSchema = z.object({
  title: z.string().min(1),
  story: z.string().min(1),
  refs: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive().optional() })).default([]),
});

const responseSchema = z.object({
  title: z.string().min(1),
  background: z.string().min(1),
  intuition: z.string().min(1),
  changes: z.array(partSchema).min(1).max(12),
  risks: z.array(z.string().min(1)).max(8).default([]),
  concepts: z.array(z.string().min(1)).min(1).max(12),
});

type GeneratedExplainer = z.infer<typeof responseSchema>;

export interface ExplainerGenerator {
  readonly name: string;
  generate(input: ExplainerInput): Promise<GeneratedExplainer>;
}

export const EXPLAINER_PROMPT_VERSION = "code-explainer@1";

const MAX_DIFF_CHARS = 60_000;
const MAX_SUMMARY_CHARS = 8_000;

const SYSTEM = `You explain a code change to the person who asked a coding agent to make it, so they understand it before they ship it. Return JSON with exactly this shape: {"title","background","intuition","changes":[{"title","story","refs":[{"path","line"}]}],"risks":[""],"concepts":[""]}.
"background": what a reader must know about this part of the system to follow the change, in two to four short paragraphs of plain prose. Skip anything the reader already understands.
"intuition": the one idea behind the change, in plain words, in one paragraph. Say what problem it removes and why this approach, not a tour of the files.
"changes": the changes told as a story, in the order a reader should meet them (the reason first, then what depends on it), not in file order. Each has a short "title", a "story" of one or two paragraphs written as complete sentences that each stand on their own, and "refs": the places to look, as the new file path exactly as the diff names it and, when you can tell, a line number in the new file taken from the hunk headers.
"risks": what could go wrong or deserves a second look: behavior that changed, cases not covered, things the diff leaves for later. Empty only if there are none.
"concepts": three to eight ideas a reader must hold to understand the change, each a short noun phrase of one to five words in the codebase's own terms (for example "optimistic locking"). Never a file name.
Everything must come from the diff and the session summary. If the diff does not show something, do not claim it. ${untrustedDataClauseJsonSafe("diff and the session summary")}`;

function knownInstruction(names: string[]): string {
  if (names.length === 0) return "";
  const bounded = names.slice(0, 40).map((name) => name.slice(0, 80));
  return ` The reader already understands these concepts, so do not explain them from scratch: ${JSON.stringify(bounded)}.`;
}

function fromGeneration(
  provider: GenerationProvider,
  run: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
): ExplainerGenerator {
  return {
    name: provider.name,
    async generate(input) {
      const prompt = JSON.stringify({
        repository: input.repo,
        commit: input.commit.slice(0, 12),
        session_summary: input.summary.slice(0, MAX_SUMMARY_CHARS),
        diff: input.diff.slice(0, MAX_DIFF_CHARS),
      });
      try {
        const out = await run({ system: `${SYSTEM}${knownInstruction(input.knownConcepts)}`, prompt });
        return responseSchema.parse(JSON.parse(out.text));
      } catch (cause) {
        if (cause instanceof GenerationRequestError) {
          throw new Error(`Explainer generation failed (HTTP ${cause.status}).`);
        }
        if (cause instanceof SyntaxError || cause instanceof z.ZodError) {
          throw new Error("Explainer generation returned an unreadable answer.");
        }
        throw cause;
      }
    },
  };
}

/** The default generator: the workspace's generation route (its own key, else the house under the weekly allowance), with the provider's quota admission when it carries one. */
export async function defaultExplainerGenerator(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): Promise<ExplainerGenerator> {
  const provider: GenerationProvider = await resolveGeneration(workspaceId, "generation", { env, fetchImpl });
  const entry = providerEntry(provider.registryId);
  return fromGeneration(provider, (input) => {
    const call = () => provider.generate({ ...input, json: true });
    if (entry?.quota && entry.enabled) {
      return withQuota(quotaStore ?? drizzleQuotaStore(), entry, workspaceId, 1, call);
    }
    return call();
  });
}
