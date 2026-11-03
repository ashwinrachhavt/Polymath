/*
 * Size-aware capacity for the zettelizer: how many proposals one source may
 * produce, and how many suggested links one card shows. The proposal cap is a
 * CEILING, never a floor — a capture that makes no clear claims proposes zero
 * (the extractor's honesty rule: never invent a claim to fill the shape), so
 * a thin source stays honest instead of being padded to a quota.
 *
 * The bands follow the brief (big post -> 5-8, small capture -> 1-2) and the
 * chunking constants: one section reads at most 12,000 chars, so a source in
 * the 2,001-12,000 band is the extractable medium post and anything larger
 * reads as multi-section.
 */

/** The proposal cap for a resolved source of `chars` characters. */
export function capForSize(chars: number): number {
  if (chars <= 2_000) return 2; // a small capture: at most a couple of ideas
  if (chars <= 12_000) return 5; // a medium post: one extractable read
  return 8; // a long, multi-section source
}

/*
 * Suggested (semantic) links surfaced per accepted card: at most 3 per card on
 * the Ideas collection strip, at most 5 on the detail page. Calibrated
 * neighbours of the graph thresholds — corpus-duplicate flagging fires at 0.15
 * cosine (ZETTEL_DUPLICATE_MAX_DISTANCE) and semantic suggestions at 0.45
 * (SEMANTIC_EDGE_MAX_DISTANCE). The caps are display budgets; the thresholds
 * are admission. One module holds all four so a recalibration reads them
 * together.
 */
export const SUGGESTED_LINKS_PER_COLLECTION_CARD = 3;
export const SUGGESTED_LINKS_PER_DETAIL_PAGE = 5;
