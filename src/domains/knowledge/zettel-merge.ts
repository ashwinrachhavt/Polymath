/*
 * The bounded merge pass (plan Task 17). The model sees only titles and
 * content — never quotes — and answers with indices to keep, strongest first.
 * It returns members of the input array by reference, so it cannot invent a
 * candidate or rewrite a quote; the only thing it controls is which survive
 * and in what order.
 */

import { z } from "zod";
import type { ZettelCandidate } from "@/integrations/zettels/extractor";
import { ZETTEL_MERGE_MAX_PER_SOURCE } from "./zettel-chunking";

export type SectionCandidate = ZettelCandidate & {
  /** Where the quote sits in the source text; absent for a quoteless candidate. */
  start?: number;
  end?: number;
  sectionIndex: number;
};

const keepReply = z.object({ keep: z.array(z.number()) });

export async function mergeCandidates(
  candidates: SectionCandidate[],
  options: {
    provider: {
      name: string;
      generate: (input: { system?: string; prompt: string; json?: boolean }) => Promise<{ text: string }>;
    };
    max?: number;
  },
): Promise<SectionCandidate[]> {
  const max = options.max ?? ZETTEL_MERGE_MAX_PER_SOURCE;
  if (candidates.length <= 1) return candidates.slice(0, max);

  // Titles and content only: the quote text never leaves this process.
  const list = candidates.map((c, index) => `${index}. ${c.title} — ${c.content}`).join("\n");
  const reply = await options.provider.generate({
    system:
      "You are merging extracted note candidates from one document. " +
      'Answer with JSON only: {"keep":[<indices>]}. ' +
      "List indices in strongest-first order, drop near-duplicates, and keep at most " +
      `${max}.`,
    prompt: list,
    json: true,
  });

  let keep: number[];
  try {
    keep = keepReply.parse(JSON.parse(reply.text)).keep;
  } catch {
    throw new Error("The merge step returned an unreadable answer.");
  }
  const seen = new Set<number>();
  const kept: SectionCandidate[] = [];
  for (const i of keep) {
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
    seen.add(i);
    kept.push(candidates[i]);
    if (kept.length >= max) break;
  }
  return kept;
}
