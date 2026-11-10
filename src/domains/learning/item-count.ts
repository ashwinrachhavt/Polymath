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
 * Makes up to `total` distinct items, one batch at a time.
 *
 * - `propose(count, avoidPrompts)` makes one model call for `count` items and
 *   returns how many the model proposed plus the ones that survived
 *   verification. `avoidPrompts` lists every prompt already kept, so a later
 *   call can steer away from repeats; repeats that still come back are dropped.
 * - `keep(made)` runs after each batch that added items, before the next
 *   call, with everything kept so far, so a caller can persist as it goes.
 *
 * A batch that comes back short or adds nothing new means the source has no
 * more to give, so the run stops there. A failed first call throws; a failed
 * later call ends the run with what the earlier calls made.
 */
export async function generateInBatches<T extends { prompt: string }>(
  total: number,
  propose: (count: number, avoidPrompts: string[]) => Promise<{ proposed: number; items: T[] }>,
  keep: (made: readonly T[]) => Promise<void> = async () => {},
): Promise<T[]> {
  const made: T[] = [];
  for (const count of planBatches(total)) {
    let batch: { proposed: number; items: T[] };
    try {
      batch = await propose(
        count,
        made.map((item) => item.prompt),
      );
    } catch (cause) {
      if (made.length === 0) throw cause;
      console.error("[learning] a later generation batch failed; keeping the items already made", cause);
      break;
    }
    const fresh = dedupeByPrompt([...made, ...batch.items]).slice(made.length, made.length + count);
    made.push(...fresh);
    if (fresh.length > 0) await keep(made);
    if (batch.proposed < count || fresh.length === 0) break;
  }
  return made;
}
