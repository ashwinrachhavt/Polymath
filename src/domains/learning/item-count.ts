/*
 * How many quiz questions or flashcards one learning request makes, and how
 * that work is split into model calls.
 *
 * A request names an exact count from MIN_ITEM_COUNT to MAX_ITEM_COUNT, or
 * leaves it to defaultItemCount, which scales with the source: about one
 * item per 600 characters, 20 to 50 for a substantial source, and never
 * padded up to 20 for a short one. Large requests run as sequential batches
 * of at most ITEMS_PER_BATCH, the most one model answer may hold (the
 * generators' response schemas enforce the same cap).
 */

/** The most sources one quiz or deck reads. */
export const MAX_LEARNING_SOURCES = 8;

export const MIN_ITEM_COUNT = 5;
export const MAX_ITEM_COUNT = 100;

const CHARS_PER_ITEM = 600;
const SHORT_SOURCE_CHARS = 6_000;
const DEFAULT_FLOOR = 20;
const DEFAULT_CEILING = 50;
const ITEMS_PER_BATCH = 25;

/** The count a request gets when it names none, from the selected sources' total length. */
export function defaultItemCount(sourceChars: number): number {
  const scaled = Math.round(sourceChars / CHARS_PER_ITEM);
  if (sourceChars < SHORT_SOURCE_CHARS) return Math.max(MIN_ITEM_COUNT, scaled);
  return Math.min(DEFAULT_CEILING, Math.max(DEFAULT_FLOOR, scaled));
}

/** Batch sizes, in call order, that add up to `total`. */
export function planBatches(total: number, perBatch = ITEMS_PER_BATCH): number[] {
  const batches: number[] = [];
  for (let left = total; left > 0; left -= perBatch) batches.push(Math.min(perBatch, left));
  return batches;
}

function promptKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Keeps the first item for each prompt, ignoring case and whitespace differences. */
export function dedupeByPrompt<T extends { prompt: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = promptKey(item.prompt);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Why a batched run ended:
 * - `complete`: it made every item requested.
 * - `source_exhausted`: the model ran out of distinct, verifiable items, so the
 *   sources support no more.
 * - `batch_failed`: a later model call failed (quota, timeout, unreadable
 *   answer), so more items may exist. The items made before it are kept.
 */
export type GenerationOutcome = "complete" | "source_exhausted" | "batch_failed";

/**
 * Makes up to `total` distinct items, one batch at a time.
 *
 * - `propose(count, avoidPrompts, batch)` makes one model call for `count`
 *   items and returns the ones that survived verification. `avoidPrompts`
 *   lists every prompt already kept, so a later call can steer away from
 *   repeats; repeats that still come back are dropped. `batch` is the call's
 *   zero-based index, so the caller can show each call a different part of a
 *   long source.
 * - `keep(made)` runs after each batch that added items, before the next
 *   call, with everything kept so far, so a caller can persist as it goes.
 *   A batch's items count as made only once `keep` succeeds.
 *
 * A batch that adds fewer than half the items it asked for means the source
 * has little more to give, so the run stops there. A failure in the first
 * batch throws; a failure in a later one ends the run with what the earlier
 * batches made and the outcome `batch_failed`.
 */
export async function generateInBatches<T extends { prompt: string }>(
  total: number,
  propose: (count: number, avoidPrompts: string[], batch: number) => Promise<T[]>,
  keep: (made: readonly T[]) => Promise<void> = async () => {},
): Promise<{ items: T[]; stoppedBy: GenerationOutcome }> {
  const made: T[] = [];
  for (const [batch, count] of planBatches(total).entries()) {
    let fresh: T[];
    try {
      const proposed = await propose(
        count,
        made.map((item) => item.prompt),
        batch,
      );
      fresh = dedupeByPrompt([...made, ...proposed]).slice(made.length, made.length + count);
      if (fresh.length > 0) await keep([...made, ...fresh]);
    } catch (cause) {
      if (made.length === 0) throw cause;
      console.error("[learning] a later generation batch failed; keeping the items already made", cause);
      return { items: made, stoppedBy: "batch_failed" };
    }
    made.push(...fresh);
    if (fresh.length * 2 < count) break;
  }
  return { items: made, stoppedBy: made.length >= total ? "complete" : "source_exhausted" };
}

/**
 * The one sentence that tells the learner what a request made and where to
 * look, for every way a run can end. `in_progress` is a run another request
 * started and has not finished.
 */
export function describeGenerationOutcome(
  noun: { one: string; many: string },
  run: { made: number; requested: number; stoppedBy: GenerationOutcome | "in_progress" },
): string {
  const { made, requested, stoppedBy } = run;
  const name = made === 1 ? noun.one : noun.many;
  const open = made === 1 ? "Open it in Results." : "Open them in Results.";
  if (stoppedBy === "in_progress") return `Still making ${noun.many}: ${made} so far, in Results.`;
  if (stoppedBy === "batch_failed")
    return `Made ${made} of ${requested} ${noun.many} before a batch failed. ${open.replace(".", ", or create again for more.")}`;
  if (stoppedBy === "source_exhausted" && made < requested)
    return `Made ${made} ${name}; the sources support no more. ${open}`;
  return `Made ${made} ${name}. ${open}`;
}

/** A short note for a result that stopped short of its request, or null when it did not. */
export function describeShortfall(run: {
  made: number;
  requested: number | null;
  stoppedBy: GenerationOutcome | "in_progress" | null;
}): string | null {
  if (run.stoppedBy === "in_progress") return "Still being made.";
  if (run.requested === null || run.made >= run.requested) return null;
  if (run.stoppedBy === "batch_failed") return `A batch failed after ${run.made} of ${run.requested}.`;
  if (run.stoppedBy === "source_exhausted") return "The sources support no more.";
  return null;
}
