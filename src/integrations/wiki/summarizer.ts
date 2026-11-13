import { z } from "zod";
import { untrustedDataClause } from "@/lib/prompts";
import { resolveGeneration } from "@/domains/billing/resolver";
import type { GenerationProvider } from "@/integrations/generation/provider";

/*
 * Turns one document's extracted text into its wiki article: a title, a
 * one-line summary the hubs and index quote, the article body, and the topics
 * it belongs to. The domain never trusts the result: topic slugs are
 * re-validated, sizes are capped, and the body is stored as a new artifact
 * version rather than edited in place. The default adapter asks the workspace's
 * generation route (its own key, else the house under the allowance), like every
 * other generator; tests and other providers plug in anything that satisfies
 * WikiSummarizer.
 */

type WikiSummary = {
  title: string;
  /** One line, shown on topic hubs and the master index. */
  summary: string;
  /** The article body, markdown. */
  body: string;
  /** Lowercase hyphenated topic slugs the article belongs to. */
  topics: string[];
};

export interface WikiSummarizer {
  /** Stored on the log line, e.g. "groq:openai/gpt-oss-120b". */
  readonly name: string;
  summarize(text: string, documentTitle: string): Promise<WikiSummary>;
}

const MAX_INPUT_CHARS = 16_000;
const MAX_BODY_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 300;
const MAX_TOPICS = 5;

const response = z.object({
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  topics: z.array(z.string()).max(MAX_TOPICS),
});

export const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** Slugs that fail the pattern are dropped, never "fixed" into something the model did not say. */
export function cleanTopics(raw: string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const slug = t.trim().toLowerCase();
    if (TOPIC_SLUG.test(slug) && !out.includes(slug)) out.push(slug);
  }
  return out.slice(0, MAX_TOPICS);
}

const SYSTEM = `You write one wiki article for a personal knowledge base. Return JSON with exactly these keys: {"title","summary","body","topics"}.
"title": a short noun phrase (max 8 words) naming what the document is about; use the document's own name when it has one.
"summary": ONE sentence, max 200 characters, stating the document's most important fact or claim.
"body": a markdown article of at most 600 words - a 2-3 sentence overview, then the key facts as a bullet list, then a short "Why it matters" section.
"topics": 1-5 lowercase-hyphenated slugs grouping the article (e.g. "job-search", "polymath", "health"); when no existing topic fits, coin one from the subject.
Write only what the document supports; never invent facts, numbers, or links. If the document is too thin to summarize, return a title, a summary saying what it is, a short body stating that, and one broad topic - never fabricate substance to fill the shape. ${untrustedDataClause("document")} Summarize what the document is.`;

/** The summarizer over one generation provider. */
export function wikiSummarizerOver(provider: GenerationProvider): WikiSummarizer {
  return {
    name: provider.name,
    async summarize(text, documentTitle) {
      const out = await provider.generate({
        system: SYSTEM,
        prompt: `Document title: ${documentTitle}\n\n${text.slice(0, MAX_INPUT_CHARS)}`,
        json: true,
        temperature: 0,
      });
      let parsed: z.infer<typeof response>;
      try {
        parsed = response.parse(JSON.parse(out.text));
      } catch {
        throw new Error("Wiki summarization returned an unreadable result.");
      }
      return {
        title: parsed.title.trim().slice(0, 200) || documentTitle,
        summary: parsed.summary.trim().slice(0, MAX_SUMMARY_CHARS),
        body: parsed.body.trim().slice(0, MAX_BODY_CHARS),
        topics: cleanTopics(parsed.topics),
      };
    },
  };
}

export async function defaultWikiSummarizer(workspaceId: string): Promise<WikiSummarizer> {
  return wikiSummarizerOver(await resolveGeneration(workspaceId, "generation"));
}
